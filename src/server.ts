import express, { type NextFunction, type Request, type Response } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCli, DEFAULT_PERMISSION_MODE, type PermissionMode } from "./claude/claudeCli.ts";
import { discoverAgents, findAgent, toPublic } from "./domain/agents.ts";
import { NEW_AGENT_TEMPLATE, createAgent, deleteAgent, updateAgent } from "./domain/agentStore.ts";
import { ValidationError } from "./domain/errors.ts";
import { checkDefinition, parseFrontmatter } from "./domain/frontmatter.ts";
import { TaskError, TaskQueue } from "./domain/queue.ts";
import { RunError, RunStore } from "./domain/runs.ts";
import { ScheduleError, Scheduler } from "./domain/schedules.ts";
import { NEW_SKILL_TEMPLATE, createSkill, deleteSkill, updateSkill } from "./domain/skillStore.ts";
import { discoverSkills, findSkill, readSkill, resolveAgentSkills, toPublicSkill } from "./domain/skills.ts";
import { AGENT_EVENTS, EventBus, SKILL_EVENTS } from "./events.ts";
import { streamEvents } from "./sse.ts";

/** The only address this server ever binds. There is deliberately no option to change it. */
export const HOST = "127.0.0.1";

/**
 * The port the guard accepts in a Host header. With `--port 0` the OS picks the port at listen(),
 * so callers pass a getter and the guard reads the bound port per request instead of a stale 0.
 */
export type PortSource = number | (() => number);

/**
 * Blocks DNS rebinding: a foreign page whose hostname resolves to 127.0.0.1 would be same-origin,
 * so require our own Host header, and for state-changing requests a matching (or absent) Origin.
 */
export function loopbackGuard(port: PortSource) {
  const allowed = (host: string, bound: number) =>
    host === `127.0.0.1:${bound}` || host === `localhost:${bound}` || host === `[::1]:${bound}`;
  return (req: Request, res: Response, next: NextFunction) => {
    const bound = typeof port === "function" ? port() : port;
    const host = req.headers.host ?? "";
    const origin = req.headers.origin;
    const safeMethod = req.method === "GET" || req.method === "HEAD";
    if (!allowed(host, bound) || (!safeMethod && origin !== undefined && origin !== `http://${host}`)) {
      res.status(403).json({ error: "forbidden host or origin" });
      return;
    }
    next();
  };
}

/**
 * Why a definition cannot be run, quoting the problem rather than saying "invalid frontmatter".
 * Claude Code skips a file with a missing `description` just as surely as one with broken YAML,
 * and a user told which key is wrong can fix it in one pass.
 */
function unrunnable(error: string | null): string {
  return `agent file is not usable: ${error ?? "its frontmatter is invalid"}; fix it before running`;
}

export interface AppOptions {
  home: string;
  cli: ClaudeCli;
  /** A number, or a getter when the bound port is only known after listen() — see {@link PortSource}. */
  port: PortSource;
  starterPrompt: string;
  defaultCwd: string;
  permissionMode?: PermissionMode;
  dataDir?: string;
  historyLimit?: number;
  /** How many tasks the queue runs at once, and how many attempts each one gets. */
  concurrency?: number;
  maxAttempts?: number;
  /** How often the queue polls the CLI; tests drive `tick()` by hand instead. */
  pollMs?: number;
  /** Directory holding the built web client; defaults to `web/` next to this module. */
  webRoot?: string;
  /** The bus /api/events streams; one is created when the caller does not supply it. */
  bus?: EventBus;
}

export function createApp(opts: AppOptions) {
  const { home } = opts;
  const permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const bus = opts.bus ?? new EventBus();
  const runs = new RunStore(home, opts.cli, opts.starterPrompt, {
    dataDir: opts.dataDir,
    historyLimit: opts.historyLimit,
    bus,
  });
  const tasks = new TaskQueue(home, opts.cli, {
    dataDir: opts.dataDir,
    concurrency: opts.concurrency,
    maxAttempts: opts.maxAttempts,
    historyLimit: opts.historyLimit,
    pollMs: opts.pollMs,
    starterPrompt: opts.starterPrompt,
    defaultCwd: opts.defaultCwd,
    bus,
  });
  // Given the queue, not the CLI: a schedule enqueues and stops there. Nothing in this object
  // can start a background session even if it wanted to.
  const schedules = new Scheduler(home, tasks, {
    dataDir: opts.dataDir,
    maxAttempts: opts.maxAttempts,
    starterPrompt: opts.starterPrompt,
    defaultCwd: opts.defaultCwd,
    bus,
  });
  const webRoot = opts.webRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "web");

  const app = express();
  // Published so later subsystems (the scheduler) emit onto the same bus.
  app.locals.bus = bus;
  // The caller owns the loop's lifetime: nothing starts work until start() is called, and
  // shutdown has to stop it. Tests drive tick() directly and never start the interval.
  app.locals.tasks = tasks;
  // Same contract for the cron clock: nothing is armed until start(), and shutdown disarms it.
  app.locals.schedules = schedules;
  // Shutdown needs these: server.close() waits for open connections, and an SSE connection never
  // ends on its own, so something has to end them. See closeStreams below.
  const streams = new Set<() => void>();
  app.locals.closeStreams = () => {
    for (const close of [...streams]) close();
  };
  app.use(loopbackGuard(opts.port));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(webRoot));

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  // Agents and skills are discovered relative to this directory as well as to ~, which is what
  // makes a definition "project" scope. It is one directory, not a per-request parameter: the
  // server serves one project, the one it was started in.
  const projectDir = opts.defaultCwd;

  app.get("/api/config", (_req, res) => {
    res.json({
      defaultCwd: opts.defaultCwd,
      starterPrompt: opts.starterPrompt,
      permissionMode,
      template: NEW_AGENT_TEMPLATE,
      templates: { agent: NEW_AGENT_TEMPLATE, skill: NEW_SKILL_TEMPLATE },
    });
  });

  // The only push channel in the product: nothing here polls. The response is owned by
  // streamEvents from this point on, so the handler must not touch res afterwards.
  app.get("/api/events", (req, res) => {
    const close = streamEvents(bus, req, res);
    streams.add(close);
    res.on("close", () => streams.delete(close));
  });

  /**
   * Checks a draft without writing it, so the editor can mark a bad field while the user is
   * still typing. Always 200: an invalid draft is a normal state mid-edit, not a failed request.
   *
   * Per kind, because the two differ on one rule: Claude Code loads a SKILL.md with no `name`
   * and calls it by its directory, while `claude --agent` has no such fallback to fall back on.
   */
  const validateRoute = (kind: "agent" | "skill") => (req: Request, res: Response) => {
    const { fields } = checkDefinition(req.body?.content, { kind });
    res.json({ valid: fields.length === 0, fields });
  };

  app.get(
    "/api/agents",
    wrap(async (_req, res) => {
      res.json((await discoverAgents(home, projectDir)).map(toPublic));
    }),
  );

  // Registered before "/api/agents/:id" so "validate" is never read as an agent id.
  app.post("/api/agents/validate", validateRoute("agent"));

  app.get(
    "/api/agents/:id",
    wrap(async (req, res) => {
      const agent = await findAgent(home, String(req.params.id), projectDir);
      if (!agent) throw new ValidationError("agent not found", 404);
      const content = await readFile(agent.filePath, "utf8");
      // The frontmatter is re-parsed here rather than carried on every list entry: only the
      // detail view needs `skills:`/`tools:`, and a failed parse is already reported as `error`.
      let data: Record<string, unknown> = {};
      try {
        ({ data } = parseFrontmatter(content));
      } catch {
        // Left empty; resolveAgentSkills reports "cannot be resolved" off agent.parses.
      }
      const skills = await discoverSkills(home, projectDir);
      res.json({ ...toPublic(agent), content, skillAccess: resolveAgentSkills(agent, skills, data) });
    }),
  );

  app.post(
    "/api/agents",
    wrap(async (req, res) => {
      const { id, scope } = await createAgent(home, req.body?.content, { projectDir, scope: req.body?.scope });
      bus.emit(AGENT_EVENTS.created, { id });
      res.status(201).json({ id, scope });
    }),
  );

  app.put(
    "/api/agents/:id",
    wrap(async (req, res) => {
      const id = String(req.params.id);
      await updateAgent(home, id, req.body?.content, projectDir);
      bus.emit(AGENT_EVENTS.updated, { id });
      res.json({ id });
    }),
  );

  app.delete(
    "/api/agents/:id",
    wrap(async (req, res) => {
      const id = String(req.params.id);
      await deleteAgent(home, id, projectDir);
      bus.emit(AGENT_EVENTS.removed, { id });
      res.json({ id });
    }),
  );

  app.get(
    "/api/skills",
    wrap(async (_req, res) => {
      res.json((await discoverSkills(home, projectDir)).map(toPublicSkill));
    }),
  );

  app.post("/api/skills/validate", validateRoute("skill"));

  app.get(
    "/api/skills/:id",
    wrap(async (req, res) => {
      const skill = await findSkill(home, String(req.params.id), projectDir);
      if (!skill) throw new ValidationError("skill not found", 404);
      res.json(await readSkill(skill));
    }),
  );

  app.post(
    "/api/skills",
    wrap(async (req, res) => {
      const { id, scope } = await createSkill(home, req.body?.content, { projectDir, scope: req.body?.scope });
      bus.emit(SKILL_EVENTS.created, { id });
      res.status(201).json({ id, scope });
    }),
  );

  app.put(
    "/api/skills/:id",
    wrap(async (req, res) => {
      const id = String(req.params.id);
      await updateSkill(home, id, req.body?.content, projectDir);
      bus.emit(SKILL_EVENTS.updated, { id });
      res.json({ id });
    }),
  );

  app.delete(
    "/api/skills/:id",
    wrap(async (req, res) => {
      const id = String(req.params.id);
      await deleteSkill(home, id, projectDir);
      bus.emit(SKILL_EVENTS.removed, { id });
      res.json({ id });
    }),
  );

  app.get(
    "/api/runs",
    wrap(async (_req, res) => {
      res.json(await runs.list());
    }),
  );

  app.post(
    "/api/runs",
    wrap(async (req, res) => {
      const agentId = String(req.body?.agentId ?? "");
      const agent = await findAgent(home, agentId, projectDir);
      if (!agent) throw new RunError("agent not found", 404);
      if (!agent.valid) throw new RunError(unrunnable(agent.error));
      const run = await runs.start(agent.runName, String(req.body?.cwd ?? ""), {
        prompt: req.body?.prompt,
        unattended: req.body?.unattended,
        permissionMode: req.body?.permissionMode ?? permissionMode,
      });
      res.status(201).json(run);
    }),
  );

  app.get(
    "/api/tasks",
    wrap(async (_req, res) => {
      res.json(await tasks.list());
    }),
  );

  // Registered before "/api/tasks/:id/..." so "stats" is never read as a task id.
  app.get(
    "/api/tasks/stats",
    wrap(async (_req, res) => {
      res.json(await tasks.stats());
    }),
  );

  app.post(
    "/api/tasks",
    wrap(async (req, res) => {
      const agent = await findAgent(home, String(req.body?.agentId ?? ""), projectDir);
      if (!agent) throw new TaskError("agent not found", 404);
      if (!agent.valid) throw new TaskError(unrunnable(agent.error), 400);
      // Built field by field rather than spread: `scheduleId` belongs to the scheduler, and a
      // request body must never be able to claim a task was created by one.
      res.status(201).json(
        await tasks.create({
          agent: agent.runName,
          cwd: req.body?.cwd,
          prompt: req.body?.prompt,
          title: req.body?.title,
          permissionMode: req.body?.permissionMode,
          unattended: req.body?.unattended,
          priority: req.body?.priority,
          maxAttempts: req.body?.maxAttempts,
        }),
      );
    }),
  );

  app.patch(
    "/api/tasks/:id",
    wrap(async (req, res) => {
      res.json(await tasks.update(String(req.params.id), { title: req.body?.title, priority: req.body?.priority }));
    }),
  );

  app.post(
    "/api/tasks/:id/cancel",
    wrap(async (req, res) => {
      res.json(await tasks.cancel(String(req.params.id)));
    }),
  );

  // 201 with a new id: retry clones, so the row the user clicked keeps its history.
  app.post(
    "/api/tasks/:id/retry",
    wrap(async (req, res) => {
      res.status(201).json(await tasks.retry(String(req.params.id)));
    }),
  );

  app.get(
    "/api/tasks/:id/transcript",
    wrap(async (req, res) => {
      res.json(await tasks.transcript(String(req.params.id)));
    }),
  );

  app.get(
    "/api/schedules",
    wrap(async (_req, res) => {
      res.json({ schedules: await schedules.list() });
    }),
  );

  app.post(
    "/api/schedules",
    wrap(async (req, res) => {
      res.status(201).json({ schedule: await schedules.create(req.body ?? {}) });
    }),
  );

  app.put(
    "/api/schedules/:id",
    wrap(async (req, res) => {
      res.json({ schedule: await schedules.update(String(req.params.id), req.body ?? {}) });
    }),
  );

  app.delete(
    "/api/schedules/:id",
    wrap(async (req, res) => {
      await schedules.remove(String(req.params.id));
      res.json({ ok: true });
    }),
  );

  // 200 for a suppressed fire as well as a fired one: being told "not now, the previous run is
  // still waiting" is the route working, and the UI has to show the reason either way.
  app.post(
    "/api/schedules/:id/run-now",
    wrap(async (req, res) => {
      res.json(await schedules.runNow(String(req.params.id)));
    }),
  );

  app.post(
    "/api/runs/stop-finished",
    wrap(async (_req, res) => {
      res.json({ stopped: await runs.stopFinished() });
    }),
  );

  app.post(
    "/api/runs/:id/stop",
    wrap(async (req, res) => {
      await runs.stop(String(req.params.id));
      res.json({ ok: true });
    }),
  );

  app.delete(
    "/api/runs/:id",
    wrap(async (req, res) => {
      await runs.remove(String(req.params.id));
      res.json({ ok: true });
    }),
  );

  // /tasks, /schedule and the rest exist only in the browser's router, so a reload or a pasted
  // link has to come back as index.html — express.static above already answered anything real.
  // Three things keep their own 404: /api, because a mistyped endpoint should not look like it
  // worked; a path with an extension, because handing HTML to a request for a missing .js reads
  // as a MIME error rather than the missing file it is; and a client that did not ask for HTML.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/") || path.extname(req.path) !== "" || !req.accepts("html")) return next();
    res.sendFile(path.resolve(webRoot, "index.html"), (err) => {
      // No built client on disk (a dev server run straight from src) — fall through to the 404.
      if (err) next();
    });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const raw =
      err instanceof ValidationError ||
      err instanceof RunError ||
      err instanceof TaskError ||
      err instanceof ScheduleError
        ? err.status
        : ((err as any).status ?? (err as any).statusCode);
    const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;
    if (status === 500) console.error(err);
    // `fields` turns a frontmatter 400 into something the editor can point at, so it rides along
    // whenever there is one; every other error keeps the plain `{ error }` shape.
    const fields = err instanceof ValidationError && err.fields.length > 0 ? err.fields : undefined;
    res.status(status).json(fields ? { error: err.message, fields } : { error: err.message });
  });

  return app;
}
