#!/usr/bin/env node
/**
 * A stand-in for the real server, for looking at the UI.
 *
 * It speaks the same wire format as src/server.ts and src/sse.ts — the same routes, the same
 * SSE frame shape, the same event names — so the client cannot tell the difference. It exists
 * so the shell can be rendered and photographed in states the real server cannot be put into
 * on demand (an empty run list, a failing endpoint, a run starting on cue).
 *
 * All content is synthetic. No real paths, no real session ids.
 *
 *   node scripts/mock-api.mjs [--port 3000] [--scenario populated|empty|error|stale|lostrace]
 *
 * While it runs, POST /__mock/start-run pushes a run:started event; the status bar must move.
 */
import { createServer } from "node:http";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const port = Number(flag("port", 3000));
const scenario = flag("scenario", "populated");

const AGENTS = [
  {
    id: "a1",
    name: "release-notes",
    runName: "release-notes",
    description: "Drafts release notes from the commits since the last tag.",
    model: "claude-opus-5",
    scope: "project",
    plugin: null,
    editable: true,
    readOnlyReason: null,
    parses: true,
    valid: true,
    error: null,
  },
  {
    id: "a2",
    name: "flaky-test-triage",
    runName: "flaky-test-triage",
    description: "Re-runs a failing spec, bisects it and reports the first bad commit.",
    model: "claude-sonnet-5",
    scope: "user",
    plugin: null,
    editable: true,
    readOnlyReason: null,
    parses: true,
    valid: true,
    error: null,
  },
  {
    id: "a3",
    name: "dependency-audit",
    runName: "dependency-audit",
    description: "Reads the lockfile and summarises advisories that actually reach the app.",
    model: null,
    scope: "user",
    plugin: null,
    editable: true,
    readOnlyReason: null,
    parses: true,
    valid: true,
    error: null,
  },
  {
    id: "a4",
    name: "changelog-sync",
    runName: "changelog-sync",
    description: "",
    model: null,
    scope: "project",
    plugin: null,
    editable: true,
    readOnlyReason: null,
    // The frontmatter parses; it is just missing a key Claude Code requires. `parses` and
    // `valid` disagree here, which is the whole reason the two fields exist.
    parses: true,
    valid: false,
    error: "`description` is required",
  },
  {
    // Two bad fields at once, because `error` joins them: the longest sentence a list row has
    // to show without the clamp eating the second key's name.
    id: "a6",
    name: "-draft-helper",
    runName: "-draft-helper",
    description: "",
    model: null,
    scope: "user",
    plugin: null,
    editable: true,
    readOnlyReason: null,
    parses: true,
    valid: false,
    error: "`name` cannot start with `-`; `description` is required",
  },
  {
    id: "a5",
    name: "oncall-summary",
    runName: "demo-pack:oncall-summary",
    description: "Summarises the week's pages and what was learned from each.",
    model: null,
    scope: "plugin",
    plugin: "demo-pack",
    editable: false,
    readOnlyReason:
      "This agent belongs to the demo-pack plugin, which owns the file. Copy it to your user agents to make your own version.",
    parses: true,
    valid: true,
    error: null,
  },
];

/**
 * Skills, in the same three scopes. The mock serves the list and the detail so the Skills screen
 * can be looked at; it deliberately does not implement create/update/delete, because a write path
 * that only pretends to write is worse than no write path. Exercise those against a real server
 * started with a throwaway HOME — see scripts/shoot-definitions.mjs.
 */
const SKILLS = [
  {
    id: "k1",
    name: "writing-style",
    ref: "writing-style",
    dirName: "writing-style",
    description: "House style for prose that ships — short sentences, no filler, active voice.",
    scope: "user",
    plugin: null,
    editable: true,
    readOnlyReason: null,
    parses: true,
    valid: true,
    error: null,
  },
  {
    id: "k2",
    name: "deploy-checklist",
    ref: "deploy-checklist",
    dirName: "deploy-checklist",
    description: "The pre-deploy checks this project runs before a release goes out.",
    scope: "project",
    plugin: null,
    editable: true,
    readOnlyReason: null,
    parses: true,
    valid: true,
    error: null,
  },
  {
    id: "k3",
    name: "incident-drill",
    ref: "demo-pack:incident-drill",
    dirName: "incident-drill",
    description: "Walks an on-call engineer through a practice incident, step by step.",
    scope: "plugin",
    plugin: "demo-pack",
    editable: false,
    readOnlyReason:
      "This skill belongs to the demo-pack plugin, which owns the file. Copy it to your user skills to make your own version.",
    parses: true,
    valid: true,
    error: null,
  },
];

const fileFor = (d) =>
  `---\nname: ${d.name}\ndescription: ${d.description}\n---\n\n# ${d.name}\n\nSynthetic fixture content.\n`;

const now = Date.now();
const runs = [
  {
    runId: "r-7f2a91",
    agent: "release-notes",
    cwd: "/Users/sam/code/acme-web",
    status: "running",
    waiting: null,
    sessionId: "s-7f2a91",
    startedAt: now - 4 * 60_000,
    endedAt: null,
    finalText: null,
    attachCommand: "claude attach r-7f2a91",
  },
  {
    runId: "r-3c80bd",
    agent: "flaky-test-triage",
    cwd: "/Users/sam/code/acme-api",
    status: "finished",
    waiting: null,
    sessionId: "s-3c80bd",
    startedAt: now - 52 * 60_000,
    endedAt: now - 38 * 60_000,
    finalText: "Bisected to 9a1f2c4; the spec shares a fixture with the suite above it.",
    attachCommand: "claude attach r-3c80bd",
  },
  {
    runId: "r-55a0c2",
    agent: "dependency-audit",
    cwd: "/Users/sam/code/acme-api",
    status: "waiting",
    waiting: { reason: "permission", detail: "permission to run `npm audit --json`" },
    sessionId: "s-55a0c2",
    startedAt: now - 11 * 60_000,
    endedAt: null,
    finalText: null,
    attachCommand: "claude attach r-55a0c2",
  },
  {
    runId: "r-be14d7",
    agent: "dependency-audit",
    cwd: "/Users/sam/code/acme-web",
    status: "stopped",
    waiting: null,
    sessionId: "s-be14d7",
    startedAt: now - 3 * 60 * 60_000,
    endedAt: now - 3 * 60 * 60_000 + 90_000,
    finalText: null,
    attachCommand: "claude attach r-be14d7",
  },
  {
    runId: "r-02ff65",
    agent: "release-notes",
    cwd: "/Users/sam/code/acme-infra",
    status: "missing",
    waiting: null,
    sessionId: null,
    startedAt: now - 26 * 60 * 60_000,
    endedAt: null,
    finalText: null,
    attachCommand: "claude attach r-02ff65",
  },
];

/**
 * Tasks covering every badge condition at once: running, running-and-waiting (both reasons),
 * three queued so "3rd of 3" has something to count, and one of each terminal state. All
 * synthetic — invented repos, invented ids, invented prompts.
 */
const task = (over) => ({
  agent: "release-notes",
  cwd: "/Users/sam/code/acme-web",
  prompt: "Summarise what changed since the last tag and draft the release notes.",
  permissionMode: "ask",
  unattended: true,
  priority: 0,
  attempts: 1,
  maxAttempts: 1,
  runId: null,
  sessionId: null,
  scheduleId: null,
  createdAt: now - 60 * 60_000,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
  waiting: null,
  queuePosition: null,
  attachCommand: null,
  ...over,
});

const tasks = [
  task({
    id: "t-91a2",
    title: "Draft release notes for 0.4.0",
    state: "running",
    runId: "r-7f2a91",
    sessionId: "s-7f2a91",
    startedAt: now - 4 * 60_000,
    attachCommand: "claude attach r-7f2a91",
  }),
  task({
    id: "t-55a0",
    title: "Audit the lockfile for reachable advisories",
    agent: "dependency-audit",
    cwd: "/Users/sam/code/acme-api",
    prompt: "Read the lockfile and list only the advisories that actually reach the running app.",
    state: "running",
    runId: "r-55a0c2",
    sessionId: "s-55a0c2",
    startedAt: now - 11 * 60_000,
    waiting: { reason: "permission", detail: "permission prompt", since: now - 6 * 60_000 },
    attachCommand: "claude attach r-55a0c2",
  }),
  task({
    id: "t-1c40",
    title: "Bisect the flaky checkout spec",
    agent: "flaky-test-triage",
    cwd: "/Users/sam/code/acme-api",
    prompt: "Re-run the failing spec until it fails, then bisect to the first bad commit.",
    state: "queued",
    priority: 1,
    queuePosition: 1,
    createdAt: now - 9 * 60_000,
  }),
  task({
    id: "t-2d71",
    title: "Regenerate the API client from the new schema",
    cwd: "/Users/sam/code/acme-infra",
    state: "queued",
    queuePosition: 2,
    createdAt: now - 7 * 60_000,
  }),
  task({
    id: "t-3e08",
    title: "Tidy the changelog headings",
    agent: "changelog-sync",
    state: "queued",
    priority: -1,
    queuePosition: 3,
    createdAt: now - 5 * 60_000,
  }),
  task({
    id: "t-4f19",
    title: "Summarise yesterday's deploys",
    state: "succeeded",
    runId: "r-3c80bd",
    sessionId: "s-3c80bd",
    createdAt: now - 58 * 60_000,
    startedAt: now - 52 * 60_000,
    finishedAt: now - 38 * 60_000,
    result: "Three deploys, all green. The 14:20 rollout carried the cache change and cut p95 by 60ms.",
    attachCommand: "claude attach r-3c80bd",
  }),
  task({
    id: "t-5a2b",
    title: "Upgrade the test runner to v4",
    agent: "dependency-audit",
    cwd: "/Users/sam/code/acme-api",
    state: "failed",
    runId: "r-be14d7",
    createdAt: now - 3 * 60 * 60_000 - 5 * 60_000,
    startedAt: now - 3 * 60 * 60_000,
    finishedAt: now - 3 * 60 * 60_000 + 90_000,
    error: "the background session stopped before it reported a result",
    attachCommand: "claude attach r-be14d7",
  }),
  task({
    id: "t-6b3c",
    title: "Rotate the staging database credentials",
    cwd: "/Users/sam/code/acme-infra",
    state: "blocked",
    runId: "r-02ff65",
    createdAt: now - 26 * 60 * 60_000 - 5 * 60_000,
    startedAt: now - 26 * 60 * 60_000,
    finishedAt: now - 26 * 60 * 60_000 + 120_000,
    // Already stripped of the BLOCKED: sentinel, exactly as the server sends it.
    result: "The staging vault token is not in this environment, so I cannot read the current credentials.",
    attachCommand: "claude attach r-02ff65",
  }),
  task({
    id: "t-7c4d",
    title: "Backfill the search index",
    state: "cancelled",
    createdAt: now - 5 * 60 * 60_000 - 5 * 60_000,
    startedAt: now - 5 * 60 * 60_000,
    finishedAt: now - 5 * 60 * 60_000 + 30_000,
  }),
];

/**
 * Schedules covering every row condition the screen has to tell apart: one that has never
 * fired, one whose last fire was suppressed, one that failed to enqueue at all, one that is
 * disabled, and one whose pattern the describer deliberately refuses to put a sentence to.
 *
 * All synthetic. Note that no two share a timezone — a schedule read in the wrong zone is the
 * mistake the Next fire column exists to prevent, and a fixture where every row says
 * `Europe/London` would never show it.
 */
const schedule = (over) => ({
  enabled: true,
  timezone: "Europe/London",
  overlapPolicy: "skip",
  task: {
    agent: "release-notes",
    cwd: "/Users/sam/code/acme-web",
    prompt: "Summarise what changed since the last tag and draft the release notes.",
    title: null,
    permissionMode: "ask",
    unattended: true,
    priority: 0,
    maxAttempts: 1,
  },
  lastFiredAt: null,
  lastTrigger: null,
  lastTaskId: null,
  lastSkippedAt: null,
  lastSkipReason: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: now - 400 * 60 * 60_000,
  updatedAt: now - 400 * 60 * 60_000,
  // Computed per request by the real server. The mock stores it, since it has no cron engine.
  nextFireAt: now + 13 * 60 * 60_000,
  ...over,
});

const schedules = [
  schedule({
    id: "sc-1",
    name: "Nightly dependency audit",
    cron: "0 3 * * *",
    task: {
      agent: "dependency-audit",
      cwd: "/Users/sam/code/acme-api",
      prompt: "Read the lockfile and list only the advisories that actually reach the running app.",
      title: null,
      permissionMode: "ask",
      unattended: true,
      priority: 0,
      maxAttempts: 1,
    },
  }),
  schedule({
    id: "sc-2",
    name: "Weekday release notes",
    cron: "0 9 * * 1-5",
    timezone: "Asia/Ho_Chi_Minh",
    lastFiredAt: now - 27 * 60 * 60_000,
    lastTrigger: "cron",
    lastTaskId: "t-4f19",
    // Newer than the fire, so this is what the row explains.
    lastSkippedAt: now - 3 * 60 * 60_000,
    lastSkipReason: "previous_run_waiting",
    nextFireAt: now + 21 * 60 * 60_000,
  }),
  schedule({
    id: "sc-3",
    name: "Hourly changelog tidy",
    cron: "0 * * * *",
    timezone: "America/New_York",
    overlapPolicy: "queue",
    lastFiredAt: now - 41 * 60_000,
    lastTrigger: "manual",
    lastTaskId: "t-91a2",
    nextFireAt: now + 19 * 60_000,
  }),
  schedule({
    id: "sc-4",
    name: "Monthly advisory sweep",
    cron: "0 2 1 * *",
    enabled: false,
    // Disabled schedules have no next fire, and the screen must never invent one.
    nextFireAt: null,
  }),
  schedule({
    id: "sc-5",
    // Day-of-month AND day-of-week: legal cron, ORed, and no short sentence says that honestly.
    name: "Quarter-day custom pattern",
    cron: "0 9 1 * 1",
    nextFireAt: now + 2 * 24 * 60 * 60_000,
  }),
  schedule({
    id: "sc-6",
    name: "Search index backfill",
    cron: "30 4 * * *",
    lastError: "working directory does not exist: /Users/sam/code/acme-search",
    lastErrorAt: now - 9 * 60 * 60_000,
    nextFireAt: now + 14 * 60 * 60_000,
  }),
];

const TRANSCRIPT = {
  messages: [
    {
      role: "user",
      text: "Summarise what changed since the last tag and draft the release notes.",
      at: now - 4 * 60_000,
    },
    {
      role: "assistant",
      text: "Reading the commits since v0.3.2. There are 41, of which 12 are user-visible.",
      at: now - 3 * 60_000,
    },
    {
      role: "assistant",
      text: "Draft:\n\n## 0.4.0\n\n- The task queue now survives a restart.\n- Schedules show the next fire time in plain English.\n- Fixed a crash when the transcript file was rotated mid-read.",
      at: now - 90_000,
    },
  ],
  truncated: false,
};

let nextEventId = 1;
const clients = new Set();

function broadcast(type, data) {
  const frame = `id: ${nextEventId++}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    clients.add(res);
    res.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/__mock/start-run") {
    const started = {
      runId: `r-${Math.random().toString(16).slice(2, 8)}`,
      agent: "dependency-audit",
      cwd: "/Users/sam/code/acme-infra",
      status: "running",
      waiting: null,
      sessionId: null,
      startedAt: Date.now(),
      endedAt: null,
      finalText: null,
      attachCommand: "claude attach",
    };
    runs.unshift(started);
    broadcast("run:started", { runId: started.runId });
    return json(res, 200, { ok: true, runId: started.runId });
  }

  if (scenario === "error" && url.pathname.startsWith("/api/")) {
    return json(res, 500, { error: "the run store could not be read: EACCES ~/.claude-agent-ui/runs.json" });
  }

  if (url.pathname === "/api/agents") return json(res, 200, scenario === "empty" ? [] : AGENTS);
  if (url.pathname === "/api/skills") return json(res, 200, scenario === "empty" ? [] : SKILLS);

  // Always 200, like the real route: an invalid draft mid-edit is a normal state. The mock
  // judges only the two rules the editor shows inline.
  if (url.pathname === "/api/agents/validate" || url.pathname === "/api/skills/validate") {
    const isSkill = url.pathname === "/api/skills/validate";
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const content = String(JSON.parse(raw || "{}")?.content ?? "");
      const fields = [];
      if (!content.startsWith("---")) {
        fields.push({ field: "frontmatter", message: "missing frontmatter (file must start with a --- block)" });
      } else {
        const written = /^name:[ \t]*(.*)$/m.exec(content)?.[1];
        const name = written?.trim() ?? "";
        const description = /^description:[ \t]*(.*)$/m.exec(content)?.[1]?.trim() ?? "";
        // These are the loadability rules, not the path-safety one. `/validate` judges a file
        // that already exists, and `NAME_RE` is only applied where a new path gets built from
        // the name — so an existing `Code-Reviewer` must validate clean here. A skill may also
        // leave `name` out: Claude Code loads it and calls it by its directory.
        if (!name) {
          if (!isSkill || written !== undefined) fields.push({ field: "name", message: "`name` is required" });
        } else if (name.includes(":")) {
          fields.push({ field: "name", message: "`name` cannot contain `:`, which is reserved for plugin names" });
        } else if (name.startsWith("-")) {
          fields.push({ field: "name", message: "`name` cannot start with `-`" });
        }
        if (!description) fields.push({ field: "description", message: "`description` is required" });
      }
      json(res, 200, { valid: fields.length === 0, fields });
    });
    return;
  }

  const agent = AGENTS.find((a) => url.pathname === `/api/agents/${a.id}`);
  if (agent) {
    return json(res, 200, {
      ...agent,
      content: fileFor(agent),
      skillAccess: {
        kind: "all",
        reason: "This agent can use every skill installed here.",
        skills: SKILLS,
        unknown: [],
      },
    });
  }

  const skill = SKILLS.find((k) => url.pathname === `/api/skills/${k.id}`);
  if (skill) return json(res, 200, { ...skill, content: fileFor(skill), body: `# ${skill.name}\n` });
  if (url.pathname === "/api/runs") return json(res, 200, { runs: scenario === "empty" ? [] : runs });

  if (url.pathname === "/api/config") {
    return json(res, 200, {
      defaultCwd: "/Users/sam/code/acme-web",
      starterPrompt: "",
      permissionMode: "ask",
      templates: { agent: "", skill: "" },
    });
  }

  const live = scenario === "empty" ? [] : tasks;

  if (url.pathname === "/api/tasks/stats") {
    // `waiting` is a subset of `running`, never a sibling — the bar must not add them.
    return json(res, 200, {
      queued: live.filter((t) => t.state === "queued").length,
      running: live.filter((t) => t.state === "running").length,
      waiting: live.filter((t) => t.waiting).length,
      maxConcurrent: 2,
    });
  }

  if (url.pathname === "/api/tasks" && req.method === "GET") {
    return json(res, 200, {
      tasks: live,
      // `--scenario stale` is the only way to see the warning bar on demand.
      warning: scenario === "stale" ? "claude agents --json --all exited with code 1" : null,
    });
  }

  // Deliberately no POST /api/schedules: a write path that only pretends to write is worse
  // than no write path. Exercise create against a real server started with a throwaway HOME —
  // see scripts/shoot-schedules.mjs.

  if (url.pathname === "/api/tasks" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const sent = JSON.parse(body || "{}");
      const agent = AGENTS.find((a) => a.id === sent.agentId);
      const created = task({
        id: `t-${Math.random().toString(16).slice(2, 6)}`,
        title: sent.title || (sent.prompt || "Untitled task").split("\n")[0].slice(0, 80),
        agent: agent?.runName ?? "release-notes",
        cwd: sent.cwd ?? "/Users/sam/code/acme-web",
        prompt: sent.prompt ?? "",
        permissionMode: sent.permissionMode ?? "ask",
        unattended: sent.unattended ?? true,
        priority: sent.priority ?? 0,
        state: "queued",
        createdAt: Date.now(),
        queuePosition: live.filter((t) => t.state === "queued").length + 1,
      });
      tasks.push(created);
      broadcast("task:created", { taskId: created.id });
      json(res, 201, created);
    });
    return;
  }

  if (url.pathname === "/api/schedules" && req.method === "GET") {
    return json(res, 200, { schedules: scenario === "empty" ? [] : schedules });
  }

  const scheduleMatch = /^\/api\/schedules\/([^/]+)(\/run-now)?$/.exec(url.pathname);
  if (scheduleMatch) {
    const found = schedules.find((s) => s.id === scheduleMatch[1]);
    if (!found) return json(res, 404, { error: "schedule not found" });

    if (scheduleMatch[2] === "/run-now") {
      // 200 either way, like the real route. `sc-2`'s previous run is parked on a permission
      // prompt, which suppresses the fire under *both* overlap policies — the one behaviour
      // on this screen worth being able to see on demand.
      if (found.id === "sc-2") {
        found.lastSkippedAt = Date.now();
        found.lastSkipReason = "previous_run_waiting";
        broadcast("schedule:skipped", { scheduleId: found.id, reason: found.lastSkipReason, trigger: "manual" });
        return json(res, 200, { fired: false, reason: found.lastSkipReason });
      }
      const created = task({
        id: `t-${Math.random().toString(16).slice(2, 6)}`,
        title: found.task.title ?? found.name,
        agent: found.task.agent,
        cwd: found.task.cwd,
        prompt: found.task.prompt,
        state: "queued",
        scheduleId: found.id,
        createdAt: Date.now(),
        queuePosition: tasks.filter((t) => t.state === "queued").length + 1,
      });
      tasks.push(created);
      found.lastFiredAt = created.createdAt;
      found.lastTrigger = "manual";
      found.lastTaskId = created.id;
      broadcast("task:created", { taskId: created.id });
      broadcast("schedule:fired", { scheduleId: found.id, taskId: created.id, trigger: "manual" });
      return json(res, 200, { fired: true, taskId: created.id });
    }

    if (req.method === "DELETE") {
      schedules.splice(schedules.indexOf(found), 1);
      broadcast("schedule:removed", { scheduleId: found.id });
      return json(res, 200, { ok: true });
    }

    if (req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const sent = JSON.parse(body || "{}");
        for (const key of ["name", "cron", "timezone", "overlapPolicy"]) {
          if (sent[key] !== undefined) found[key] = sent[key];
        }
        if (typeof sent.enabled === "boolean") {
          found.enabled = sent.enabled;
          // A disabled schedule has no next fire; the real server computes null for it.
          found.nextFireAt = sent.enabled ? Date.now() + 13 * 60 * 60_000 : null;
        }
        if (sent.task) Object.assign(found.task, sent.task);
        found.updatedAt = Date.now();
        broadcast("schedule:updated", { scheduleId: found.id });
        json(res, 200, { schedule: found });
      });
      return;
    }
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
  if (taskMatch) {
    const found = tasks.find((t) => t.id === taskMatch[1]);
    if (!found) return json(res, 404, { error: "task not found" });
    const action = taskMatch[2];

    if (action === "/transcript") {
      return json(res, 200, found.startedAt ? TRANSCRIPT : { messages: [], truncated: false });
    }
    if (action === "/cancel") {
      if (found.state !== "queued" && found.state !== "running" && found.state !== "cancelled") {
        return json(res, 409, { error: "that task already finished" });
      }
      // tasks-api-contract rev 4: a running task can settle while `claude stop` is in flight,
      // and the first terminal write wins — so cancel answers 200 with the outcome the task
      // actually reached. `--scenario lostrace` is the only way to see that on demand.
      if (scenario === "lostrace" && found.state === "running") {
        found.state = "succeeded";
        found.result = "Finished the run before the stop request landed.";
        found.finishedAt = Date.now();
        found.waiting = null;
        found.queuePosition = null;
        broadcast("task:updated", { taskId: found.id });
        return json(res, 200, found);
      }
      found.state = "cancelled";
      found.finishedAt = Date.now();
      found.waiting = null;
      found.queuePosition = null;
      broadcast("task:updated", { taskId: found.id });
      return json(res, 200, found);
    }
    if (action === "/retry") {
      if (found.state === "queued" || found.state === "running") {
        return json(res, 409, { error: "that task is still running" });
      }
      const clone = task({
        ...found,
        id: `t-${Math.random().toString(16).slice(2, 6)}`,
        state: "queued",
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
        runId: null,
        attachCommand: null,
        queuePosition: tasks.filter((t) => t.state === "queued").length + 1,
      });
      tasks.push(clone);
      broadcast("task:created", { taskId: clone.id });
      return json(res, 201, clone);
    }
    if (req.method === "PATCH") {
      if (found.state !== "queued") return json(res, 409, { error: "priority only applies while a task is queued" });
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const sent = JSON.parse(body || "{}");
        if (typeof sent.priority === "number") found.priority = sent.priority;
        if (typeof sent.title === "string") found.title = sent.title;
        broadcast("task:updated", { taskId: found.id });
        json(res, 200, found);
      });
      return;
    }
  }

  return json(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1", () => {
  console.log(`mock API (${scenario}) on http://127.0.0.1:${port}`);
});
