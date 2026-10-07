import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type BackgroundSession,
  CliError,
  ClaudeCli,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type SessionPhase,
  type SessionWait,
  sessionPhase,
  sessionWait,
} from "../claude/claudeCli.ts";
import { findTranscript, readFinalMessage } from "../claude/transcript.ts";
import { type EventBus, RUN_EVENTS } from "../events.ts";
import { JsonStore } from "../store/jsonStore.ts";
import {
  MAX_PROMPT_LENGTH,
  checkCwd,
  checkPermissionMode,
  checkPrompt,
  checkRunName,
  checkUnattended,
} from "./runInput.ts";

/**
 * "waiting" = parked on a prompt a human has to answer; not finished, and not progress either.
 * "unknown" = `claude agents --json` could not be read this time.
 */
export type RunStatus = "running" | "waiting" | "finished" | "failed" | "stopped" | "missing" | "unknown";

export interface RunRecord {
  runId: string;
  sessionId: string | null;
  agent: string;
  cwd: string;
  startedAt: number;
  permissionMode: PermissionMode;
}

export interface RunsResponse {
  runs: RunView[];
  warning: string | null;
}

export interface RunView extends RunRecord {
  status: RunStatus;
  /** Non-null only while `status === "waiting"`; what the CLI says it is waiting for. */
  waiting: SessionWait | null;
  endedAt: number | null;
  finalText: string | null;
  attachCommand: string;
}

export class RunError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const PHASE_STATUS: Record<SessionPhase, RunStatus> = {
  waiting: "waiting",
  done: "finished",
  idle: "finished",
  failed: "failed",
  stopped: "stopped",
  working: "running",
};

export function mapStatus(session: BackgroundSession | undefined): RunStatus {
  if (!session) return "missing";
  return PHASE_STATUS[sessionPhase(session)];
}

/** Not finished: either working or parked on a prompt. Neither has a final message to read. */
export function isActive(status: RunStatus): boolean {
  return status === "running" || status === "waiting";
}

const TRUST_HINT = /not trusted/i;
export { MAX_PROMPT_LENGTH };
/** Oldest records past this count are dropped, so runs.json cannot grow without bound. */
export const DEFAULT_HISTORY_LIMIT = 500;

export interface StartRunOptions {
  prompt?: unknown;
  unattended?: unknown;
  permissionMode?: unknown;
}

export interface RunStoreOptions {
  dataDir?: string;
  historyLimit?: number;
  /** Where `run:*` events go; omitted in tests that do not care about them. */
  bus?: EventBus;
}

export class RunStore {
  private readonly store: JsonStore<RunRecord[]>;
  private readonly historyLimit: number;
  private readonly bus?: EventBus;
  private finalCache = new Map<string, { mtimeMs: number; text: string | null; timestamp: string | null }>();

  constructor(
    private readonly home: string,
    private readonly cli: ClaudeCli,
    private readonly starterPrompt: string,
    opts: RunStoreOptions = {},
  ) {
    const dataDir = opts.dataDir ?? path.join(home, ".claude-agent-ui");
    this.store = new JsonStore<RunRecord[]>(path.join(dataDir, "runs.json"), () => []);
    this.historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.bus = opts.bus;
  }

  /** Events carry an id only; a client that gets one re-reads /api/runs. */
  private announce(type: string, runId: string): void {
    this.bus?.emit(type, { runId });
  }

  private async load(): Promise<RunRecord[]> {
    const data = await this.store.read();
    return Array.isArray(data) ? data : [];
  }

  /** A blank or missing prompt falls back to the configured starter prompt. */
  async start(agent: string, cwdInput: string, opts: StartRunOptions = {}): Promise<RunRecord> {
    checkRunName(agent);
    const unattended = checkUnattended(opts.unattended, false);
    const permissionMode = checkPermissionMode(opts.permissionMode);
    const prompt = checkPrompt(opts.prompt, this.starterPrompt);
    // No fallback here: a run names its own directory, and an empty one is a bad request.
    const cwd = await checkCwd(cwdInput, this.home, "");

    let runId: string;
    try {
      runId = await this.cli.startBackground({ agent, cwd, prompt, unattended, permissionMode });
    } catch (err) {
      const message = err instanceof CliError ? err.message : (err as Error).message;
      const hint = TRUST_HINT.test(message)
        ? `\n\nOpen iTerm2, run: cd ${cwd} && claude — accept the trust prompt once, then retry.`
        : "";
      throw new RunError(`claude --bg failed: ${message}${hint}`, 502);
    }

    let sessionId: string | null = null;
    try {
      const sessions = await this.cli.listSessions();
      sessionId = sessions.find((s) => s.id === runId)?.sessionId ?? null;
    } catch {
      // resolved lazily in list()
    }
    const record: RunRecord = { runId, sessionId, agent, cwd, startedAt: Date.now(), permissionMode };
    await this.store.mutate((runs) => {
      runs.unshift(record);
      if (runs.length > this.historyLimit) runs.length = this.historyLimit;
    });
    this.announce(RUN_EVENTS.started, runId);
    return record;
  }

  private async finalMessage(sessionId: string) {
    const file = await findTranscript(this.home, sessionId);
    if (!file) return null;
    const { mtimeMs } = await stat(file);
    const cached = this.finalCache.get(sessionId);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    const msg = await readFinalMessage(file);
    const entry = { mtimeMs, text: msg?.text ?? null, timestamp: msg?.timestamp ?? null };
    this.finalCache.set(sessionId, entry);
    return entry;
  }

  async list(): Promise<RunsResponse> {
    const runs = await this.load();
    let sessions: BackgroundSession[] | null = null;
    let warning: string | null = null;
    try {
      sessions = await this.cli.listSessions();
    } catch (err) {
      warning = `could not read claude agents --json: ${(err as Error).message}`;
    }
    const byId = new Map((sessions ?? []).map((s) => [s.id, s]));
    const unresolved = runs.filter((r) => !r.sessionId && byId.get(r.runId)?.sessionId);
    if (unresolved.length) {
      await this.store.mutate((all) => {
        for (const r of all) if (!r.sessionId) r.sessionId = byId.get(r.runId)?.sessionId ?? null;
      });
    }

    const views = await Promise.all(
      runs.map(async (run): Promise<RunView> => {
        const session = byId.get(run.runId);
        const sessionId = run.sessionId ?? session?.sessionId ?? null;
        const status: RunStatus = sessions ? mapStatus(session) : "unknown";
        // A waiting run is not finished: reading a "final" message here would report the
        // last thing it said before the prompt as its result.
        const waiting = status === "waiting" && session ? sessionWait(session) : null;
        let finalText: string | null = null;
        let endedAt: number | null = null;
        if (!isActive(status) && sessionId) {
          const msg = await this.finalMessage(sessionId).catch(() => null);
          finalText = msg?.text ?? null;
          endedAt = msg?.timestamp ? Date.parse(msg.timestamp) : null;
        }
        return {
          ...run,
          permissionMode: run.permissionMode ?? DEFAULT_PERMISSION_MODE,
          sessionId,
          status,
          waiting,
          endedAt,
          finalText,
          attachCommand: `claude attach ${run.runId}`,
        };
      }),
    );
    this.pruneFinalCache(views);
    return { runs: views, warning };
  }

  /** Drops cached final messages for sessions no longer in the run list, so the map stays bounded. */
  private pruneFinalCache(views: RunView[]): void {
    const live = new Set(views.map((v) => v.sessionId).filter((id): id is string => id !== null));
    for (const sessionId of this.finalCache.keys()) {
      if (!live.has(sessionId)) this.finalCache.delete(sessionId);
    }
  }

  /** Test seam: how many sessions the final-message cache is currently holding. */
  get cachedFinalMessages(): number {
    return this.finalCache.size;
  }

  private async requireRun(runId: string): Promise<RunRecord> {
    const run = (await this.load()).find((r) => r.runId === runId);
    if (!run) throw new RunError("run not found", 404);
    return run;
  }

  async stop(runId: string): Promise<void> {
    await this.requireRun(runId);
    try {
      await this.cli.stop(runId);
    } catch (err) {
      throw new RunError(`claude stop failed: ${(err as Error).message}`, 502);
    }
    this.announce(RUN_EVENTS.stopped, runId);
  }

  async remove(runId: string): Promise<void> {
    await this.requireRun(runId);
    try {
      await this.cli.remove(runId);
    } catch (err) {
      // A session that is already gone can still be forgotten locally.
      const sessions = await this.cli.listSessions().catch(() => null);
      const gone = sessions !== null && !sessions.some((s) => s.id === runId);
      if (!gone) throw new RunError(`claude rm failed: ${(err as Error).message}`, 502);
    }
    await this.store.mutate((runs) => {
      const i = runs.findIndex((r) => r.runId === runId);
      if (i >= 0) runs.splice(i, 1);
    });
    this.announce(RUN_EVENTS.removed, runId);
  }

  async stopFinished(): Promise<string[]> {
    // Ended one way or the other, so the session is just holding a slot. A `waiting` run is
    // not in here on purpose: it has not ended, and killing it is the user's call.
    const finished = (await this.list()).runs.filter((r) => r.status === "finished" || r.status === "failed");
    const stopped: string[] = [];
    for (const run of finished) {
      try {
        await this.cli.stop(run.runId);
        stopped.push(run.runId);
        this.announce(RUN_EVENTS.stopped, run.runId);
      } catch {
        // keep going; the panel will still show it as finished
      }
    }
    return stopped;
  }
}
