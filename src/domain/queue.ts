import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type BackgroundSession,
  CliError,
  ClaudeCli,
  type PermissionMode,
  type SessionWait,
  sessionWait,
} from "../claude/claudeCli.ts";
import { type TranscriptPage, findTranscript, readFinalMessage, readMessages } from "../claude/transcript.ts";
import { type EventBus, TASK_EVENTS } from "../events.ts";
import { JsonStore } from "../store/jsonStore.ts";
import { InputError, checkCwd, checkPermissionMode, checkPrompt, checkRunName, checkUnattended } from "./runInput.ts";
import { mapStatus } from "./runs.ts";

/**
 * The work queue: the one place in the product that starts a background session.
 *
 * Schedules enqueue and the UI enqueues; neither starts a run on its own path. The loop runs
 * in-process: while fewer than `concurrency` tasks are running, claim the highest-priority
 * oldest queued task and start it, then watch `claude agents --json --all` until it ends.
 */

export type TaskState = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";

const TERMINAL: readonly TaskState[] = ["succeeded", "failed", "blocked", "cancelled"];

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.includes(state);
}

/** What the CLI says a running task is waiting for, plus when we first saw it. */
export interface TaskWaiting extends SessionWait {
  /** Epoch ms we first observed the wait; the CLI does not report one. */
  since: number;
}

export interface TaskRecord {
  id: string;
  title: string;
  /** The agent's runName — the same literal `claude --agent` takes. */
  agent: string;
  cwd: string;
  prompt: string;
  permissionMode: PermissionMode;
  unattended: boolean;
  priority: number;
  state: TaskState;
  attempts: number;
  maxAttempts: number;
  runId: string | null;
  sessionId: string | null;
  scheduleId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Final transcript message, display-ready: the `BLOCKED:` sentinel is already stripped. */
  result: string | null;
  error: string | null;
  waiting: TaskWaiting | null;
  /** Set when a failed attempt is requeued with backoff; it may not start again before this. */
  nextAttemptAt: number | null;
}

/** The wire shape. `nextAttemptAt` stays internal — it is scheduling, not something to render. */
export interface TaskView extends Omit<TaskRecord, "nextAttemptAt"> {
  /** 1-based position in the queue, or null unless the task is queued. */
  queuePosition: number | null;
  attachCommand: string | null;
}

export interface TaskList {
  tasks: TaskView[];
  /** Set when the CLI poll failed, so states may be stale. Show it; never swallow it. */
  warning: string | null;
}

export interface TaskStats {
  queued: number;
  /** Includes waiting tasks: a waiting task holds its slot. Never add the two together. */
  running: number;
  waiting: number;
  maxConcurrent: number;
}

/** 404 / 409 / 502 — a state conflict rather than a malformed body. */
export class TaskError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_MAX_ATTEMPTS = 1;
/** Finished tasks past this count are pruned, oldest first. Queued and running are never pruned. */
export const DEFAULT_HISTORY_LIMIT = 500;
export const DEFAULT_POLL_MS = 1_500;
export const MAX_TITLE_LENGTH = 80;
export const MAX_ATTEMPTS_LIMIT = 5;
export const PRIORITY_LIMIT = 1000;

/** First retry waits this long; each further attempt doubles it. Unused at maxAttempts: 1. */
export const BACKOFF_BASE_MS = 5_000;

/** The sentinel the unattended system prompt asks for; `claudeCli.ts` is where it comes from. */
const BLOCKED_PREFIX = /^BLOCKED:[ \t]*/;

function deriveTitle(prompt: string): string {
  const line = prompt.split("\n").find((l) => l.trim());
  const title = line?.trim() || "Untitled task";
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}

/**
 * The three task fields the scheduler validates too. Exported rather than copied: a schedule is a
 * saved task template, so "what is a valid title/priority/maxAttempts" has to have one definition
 * or the saved template accepts something the enqueued task will later reject.
 */
export function checkTitle(value: unknown): string {
  if (typeof value !== "string") throw new InputError("title must be a string");
  const title = value.trim();
  if (!title) throw new InputError("title must not be empty");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new InputError(`title is too long (max ${MAX_TITLE_LENGTH} characters)`);
  }
  return title;
}

export function checkPriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > PRIORITY_LIMIT) {
    throw new InputError(`priority must be a whole number between -${PRIORITY_LIMIT} and ${PRIORITY_LIMIT}`);
  }
  return value;
}

export function checkMaxAttempts(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_ATTEMPTS_LIMIT) {
    throw new InputError(`maxAttempts must be a whole number between 1 and ${MAX_ATTEMPTS_LIMIT}`);
  }
  return value;
}

/** Higher priority first, ties broken by the older task. The one definition of queue order. */
function queueOrder(a: TaskRecord, b: TaskRecord): number {
  return b.priority - a.priority || a.createdAt - b.createdAt;
}

/** Running, then queued, then everything finished — so the UI groups the list in one pass. */
const GROUP: Record<TaskState, number> = {
  running: 0,
  queued: 1,
  succeeded: 2,
  failed: 2,
  blocked: 2,
  cancelled: 2,
};

function listOrder(a: TaskRecord, b: TaskRecord): number {
  if (GROUP[a.state] !== GROUP[b.state]) return GROUP[a.state] - GROUP[b.state];
  if (a.state === "queued") return queueOrder(a, b);
  if (a.state === "running") return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  return (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
}

/** Compares what the CLI said, not when we saw it — `since` must not make every poll a change. */
function sameWait(a: SessionWait | null, b: SessionWait | null): boolean {
  if (a === null || b === null) return a === b;
  return a.reason === b.reason && a.detail === b.detail;
}

export interface CreateTaskInput {
  agent: unknown;
  cwd?: unknown;
  prompt?: unknown;
  title?: unknown;
  permissionMode?: unknown;
  unattended?: unknown;
  priority?: unknown;
  maxAttempts?: unknown;
  /** Set by the scheduler, never by a request body. */
  scheduleId?: string | null;
}

export interface UpdateTaskInput {
  title?: unknown;
  priority?: unknown;
}

export interface TaskQueueOptions {
  dataDir?: string;
  concurrency?: number;
  maxAttempts?: number;
  historyLimit?: number;
  pollMs?: number;
  starterPrompt?: string;
  defaultCwd?: string;
  /** Where `task:*` events go; omitted in tests that do not care about them. */
  bus?: EventBus;
}

export class TaskQueue {
  private readonly store: JsonStore<TaskRecord[]>;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly historyLimit: number;
  private readonly pollMs: number;
  private readonly starterPrompt: string;
  private readonly defaultCwd: string;
  private readonly bus?: EventBus;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private warning: string | null = null;

  constructor(
    private readonly home: string,
    private readonly cli: ClaudeCli,
    opts: TaskQueueOptions = {},
  ) {
    const dataDir = opts.dataDir ?? path.join(home, ".claude-agent-ui");
    this.store = new JsonStore<TaskRecord[]>(path.join(dataDir, "tasks.json"), () => []);
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.starterPrompt = opts.starterPrompt ?? "Start your task.";
    this.defaultCwd = opts.defaultCwd ?? home;
    this.bus = opts.bus;
  }

  /** Events carry an id only; a client that gets one re-reads /api/tasks. */
  private announce(type: string, taskId: string): void {
    this.bus?.emit(type, { taskId });
  }

  private async load(): Promise<TaskRecord[]> {
    const data = await this.store.read();
    return Array.isArray(data) ? data : [];
  }

  // ---------------------------------------------------------------- reading

  private toViews(tasks: TaskRecord[]): TaskView[] {
    const positions = new Map(
      tasks
        .filter((t) => t.state === "queued")
        .sort(queueOrder)
        .map((t, i) => [t.id, i + 1] as const),
    );
    return [...tasks].sort(listOrder).map(({ nextAttemptAt: _internal, ...task }) => ({
      ...task,
      queuePosition: positions.get(task.id) ?? null,
      attachCommand: task.runId ? `claude attach ${task.runId}` : null,
    }));
  }

  async list(): Promise<TaskList> {
    return { tasks: this.toViews(await this.load()), warning: this.warning };
  }

  async stats(): Promise<TaskStats> {
    const tasks = await this.load();
    const running = tasks.filter((t) => t.state === "running");
    return {
      queued: tasks.filter((t) => t.state === "queued").length,
      running: running.length,
      waiting: running.filter((t) => t.waiting !== null).length,
      maxConcurrent: this.concurrency,
    };
  }

  /** `200` with no messages for a task that has not started; `404` only for an unknown id. */
  async transcript(id: string): Promise<TranscriptPage> {
    const task = await this.require(id);
    if (!task.sessionId) return { messages: [], truncated: false };
    const file = await findTranscript(this.home, task.sessionId);
    if (!file) return { messages: [], truncated: false };
    return readMessages(file);
  }

  /**
   * The newest task a given schedule created, or undefined if it has never fired.
   *
   * This is the scheduler's overlap check and nothing else reads it: the schedule asks "is the one
   * I started last time still going?" before starting another. Newest by `createdAt`, because the
   * question is about the most recent fire, not about whatever finished most recently.
   *
   * A tie in `createdAt` goes to the later entry: tasks are appended in creation order, and two
   * can land in the same millisecond. A sort would keep the *first* of an equal pair — handing the
   * overlap check the older task and letting a blocked newer one through unseen.
   */
  async latestForSchedule(scheduleId: string): Promise<TaskRecord | undefined> {
    let latest: TaskRecord | undefined;
    for (const task of await this.load()) {
      if (task.scheduleId === scheduleId && (!latest || task.createdAt >= latest.createdAt)) latest = task;
    }
    return latest;
  }

  private async require(id: string): Promise<TaskRecord> {
    const task = (await this.load()).find((t) => t.id === id);
    if (!task) throw new TaskError("task not found", 404);
    return task;
  }

  private async viewOf(id: string): Promise<TaskView> {
    const view = this.toViews(await this.load()).find((t) => t.id === id);
    if (!view) throw new TaskError("task not found", 404);
    return view;
  }

  // ---------------------------------------------------------------- writing

  /**
   * Applies `fn` to one task inside the store's write chain and announces an update when it
   * reports a real change. Returning false keeps the watcher from emitting on every poll.
   */
  private async patch(id: string, fn: (task: TaskRecord) => boolean): Promise<TaskRecord | undefined> {
    const updated = await this.store.mutate((tasks) => {
      const task = tasks.find((t) => t.id === id);
      if (!task || !fn(task)) return undefined;
      return { ...task };
    });
    if (updated) this.announce(TASK_EVENTS.updated, id);
    return updated;
  }

  async create(input: CreateTaskInput): Promise<TaskView> {
    const agent = checkRunName(input.agent);
    const cwd = await checkCwd(input.cwd, this.home, this.defaultCwd);
    const prompt = checkPrompt(input.prompt, this.starterPrompt);
    // The literal "ask", never the configured default: a queued task has nobody there to answer,
    // so a global bypass must not be inherited by work that runs unwatched.
    const permissionMode = checkPermissionMode(input.permissionMode, "ask");
    // Unlike a run, a queued task defaults to unattended — nobody is watching it.
    const unattended = checkUnattended(input.unattended, true);
    const record: TaskRecord = {
      id: randomUUID(),
      title: input.title === undefined || input.title === null ? deriveTitle(prompt) : checkTitle(input.title),
      agent,
      cwd,
      prompt,
      permissionMode,
      unattended,
      priority: input.priority === undefined || input.priority === null ? 0 : checkPriority(input.priority),
      state: "queued",
      attempts: 0,
      maxAttempts: checkMaxAttempts(input.maxAttempts, this.maxAttempts),
      runId: null,
      sessionId: null,
      scheduleId: input.scheduleId ?? null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      waiting: null,
      nextAttemptAt: null,
    };
    await this.store.mutate((tasks) => {
      tasks.push(record);
    });
    this.announce(TASK_EVENTS.created, record.id);
    await this.prune();
    this.kick();
    return this.viewOf(record.id);
  }

  async update(id: string, input: UpdateTaskInput): Promise<TaskView> {
    const task = await this.require(id);
    const next: Partial<TaskRecord> = {};
    if (input.title !== undefined) next.title = checkTitle(input.title);
    if (input.priority !== undefined) {
      // Priority decides what starts next, so it means nothing once a task has started.
      if (task.state !== "queued") {
        throw new TaskError(`priority can only be changed while a task is queued (this one is ${task.state})`, 409);
      }
      next.priority = checkPriority(input.priority);
    }
    if (!Object.keys(next).length) throw new InputError("nothing to update: send a title or a priority");
    await this.patch(id, (t) => {
      Object.assign(t, next);
      return true;
    });
    return this.viewOf(id);
  }

  /**
   * Queued drops out of the queue; running calls `claude stop`. Already cancelled is a no-op.
   *
   * The other half of the same race: if the task settled while `claude stop` was in flight then
   * it is already terminal and keeps the outcome it reported, rather than having a real result
   * overwritten with "cancelled". Either way the caller gets the task's actual final state.
   */
  async cancel(id: string): Promise<TaskView> {
    const task = await this.require(id);
    // Idempotent so a double-click is never an error the user has to read.
    if (task.state === "cancelled") return this.viewOf(id);
    if (task.state !== "queued" && task.state !== "running") {
      throw new TaskError(`this task already finished (${task.state})`, 409);
    }
    if (task.state === "running" && task.runId) {
      try {
        await this.cli.stop(task.runId);
      } catch (err) {
        throw new TaskError(`claude stop failed: ${(err as Error).message}`, 502);
      }
    }
    await this.finish(id, "cancelled", {});
    return this.viewOf(id);
  }

  /** Clones a finished task back to `queued`. The original record is left intact. */
  async retry(id: string): Promise<TaskView> {
    const task = await this.require(id);
    if (!isTerminal(task.state)) throw new TaskError(`this task is still ${task.state}`, 409);
    const clone: TaskRecord = {
      ...task,
      id: randomUUID(),
      state: "queued",
      attempts: 0,
      runId: null,
      sessionId: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      waiting: null,
      nextAttemptAt: null,
    };
    await this.store.mutate((tasks) => {
      tasks.push(clone);
    });
    this.announce(TASK_EVENTS.created, clone.id);
    await this.prune();
    this.kick();
    return this.viewOf(clone.id);
  }

  /**
   * Writes a terminal state, once. Every caller here reads a task, awaits something slow, then
   * writes — the watcher awaits two CLI calls, `cancel` awaits `claude stop` — so by the time a
   * write lands the record may have moved on. A terminal state is therefore final: the first
   * writer wins and later ones no-op, which is what stops a settling tick from reviving a task
   * the user just cancelled. `guard` adds the caller's own view of what it is settling.
   *
   * Reports whether the write happened, so a caller can tell a win from a lost race.
   */
  private async finish(
    id: string,
    state: TaskState,
    patch: { result?: string | null; error?: string | null; sessionId?: string | null },
    guard?: (task: TaskRecord) => boolean,
  ): Promise<boolean> {
    const written = await this.patch(id, (task) => {
      if (isTerminal(task.state)) return false;
      if (guard && !guard(task)) return false;
      task.state = state;
      task.finishedAt = Date.now();
      task.waiting = null;
      task.nextAttemptAt = null;
      task.result = patch.result ?? null;
      task.error = patch.error ?? null;
      if (patch.sessionId !== undefined && patch.sessionId !== null) task.sessionId = patch.sessionId;
      return true;
    });
    if (!written) return false;
    await this.prune();
    return true;
  }

  /**
   * The watcher's claim on a task: it may only write the outcome of the attempt it observed.
   * A cancel, or a later attempt, moves the record out from under it and the write is dropped.
   */
  private static owns(observed: TaskRecord): (task: TaskRecord) => boolean {
    return (task) => task.state === "running" && task.runId === observed.runId;
  }

  /** Drops the oldest finished tasks past the cap, so tasks.json cannot grow without bound. */
  private async prune(): Promise<void> {
    const removed = await this.store.mutate((tasks) => {
      const finished = tasks
        .filter((t) => isTerminal(t.state))
        .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
      const excess = finished.length - this.historyLimit;
      if (excess <= 0) return [];
      const drop = new Set(finished.slice(0, excess).map((t) => t.id));
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (drop.has(tasks[i].id)) tasks.splice(i, 1);
      }
      return [...drop];
    });
    for (const id of removed) this.announce(TASK_EVENTS.removed, id);
  }

  // ---------------------------------------------------------------- the loop

  /** Runs one pass: settle what is running, then fill the free slots. Never overlaps itself. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.watch();
      await this.fill();
    } finally {
      this.ticking = false;
    }
  }

  /** Nudges the loop after an enqueue, but only once it is actually running. */
  private kick(): void {
    if (this.timer) void this.tick().catch(() => {});
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.reconcile();
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.pollMs);
    // Nothing here should keep the process alive on its own.
    this.timer.unref?.();
    await this.tick().catch(() => {});
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Startup crash safety. A task left `running` with a `runId` is fine — its background session
   * outlived us, so the watcher adopts it on the next tick. A task left `running` with no
   * `runId` died between claiming its slot and recording the session, and nothing will ever
   * resolve it: we cannot tell whether `claude --bg` ran, so say so rather than strand it.
   */
  async reconcile(): Promise<void> {
    for (const task of await this.load()) {
      if (task.state !== "running" || task.runId) continue;
      await this.finish(task.id, "failed", {
        error:
          "the server stopped while this task was starting, so its session was never recorded. " +
          "Check `claude agents --all` for a stray session, then retry the task.",
      });
    }
  }

  private async watch(): Promise<void> {
    const running = (await this.load()).filter((t) => t.state === "running" && t.runId);
    if (!running.length) {
      // Nothing to poll for, so there is nothing stale to warn about either.
      this.warning = null;
      return;
    }
    let sessions: BackgroundSession[];
    try {
      sessions = await this.cli.listSessions();
    } catch (err) {
      // Cannot tell what happened, so change nothing: states stay as they were and say so.
      this.warning = `could not read claude agents --json: ${(err as Error).message}`;
      return;
    }
    this.warning = null;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const task of running) {
      await this.settle(task, byId.get(task.runId!));
    }
  }

  private async settle(task: TaskRecord, session: BackgroundSession | undefined): Promise<void> {
    const status = mapStatus(session);
    const sessionId = task.sessionId ?? session?.sessionId ?? null;

    if (status === "running" || status === "waiting") {
      const wait = status === "waiting" && session ? sessionWait(session) : null;
      // `since` is carried across polls while the same wait holds, so the UI can show how long
      // it has been parked; a different wait is a new one and starts its own clock.
      const held = wait !== null && task.waiting !== null && sameWait(task.waiting, wait);
      const waiting: TaskWaiting | null = wait ? { ...wait, since: held ? task.waiting!.since : Date.now() } : null;
      await this.patch(task.id, (t) => {
        if (!TaskQueue.owns(task)(t)) return false;
        let changed = false;
        if (sessionId && t.sessionId !== sessionId) {
          t.sessionId = sessionId;
          changed = true;
        }
        if (!sameWait(t.waiting, waiting)) {
          t.waiting = waiting;
          changed = true;
        }
        return changed;
      });
      return;
    }

    // Ended. Only now is there a final message to read: reading one from a waiting session would
    // report the last thing it said before the prompt opened as its result.
    const final = sessionId ? await this.finalMessage(sessionId) : null;
    if (status === "finished") {
      // The sentinel is a convention of the prompt we inject, so it is stripped here: the UI
      // never has to know it exists, and changing it stays a one-codebase change.
      const blocked = final !== null && BLOCKED_PREFIX.test(final);
      const result = blocked && final !== null ? final.replace(BLOCKED_PREFIX, "") : final;
      await this.finish(task.id, blocked ? "blocked" : "succeeded", { result, sessionId }, TaskQueue.owns(task));
      return;
    }
    const reason =
      status === "missing"
        ? "the background session is no longer listed by the Claude CLI"
        : status === "stopped"
          ? "the background session stopped before it reported a result"
          : "the Claude CLI reported that the session failed";
    await this.failAttempt(task, reason, final, sessionId);
  }

  private async finalMessage(sessionId: string): Promise<string | null> {
    const file = await findTranscript(this.home, sessionId);
    if (!file) return null;
    const message = await readFinalMessage(file).catch(() => null);
    return message?.text ?? null;
  }

  /**
   * Fails the task, or requeues it with exponential backoff when attempts remain. Both paths
   * are guarded by the attempt the caller observed: requeuing a cancelled task would put work
   * the user stopped back in the queue and launch a second session for it.
   */
  private async failAttempt(
    task: TaskRecord,
    error: string,
    result: string | null,
    sessionId: string | null,
  ): Promise<void> {
    if (task.attempts < task.maxAttempts) {
      const delay = BACKOFF_BASE_MS * 2 ** (task.attempts - 1);
      await this.patch(task.id, (t) => {
        if (!TaskQueue.owns(task)(t)) return false;
        t.state = "queued";
        t.runId = null;
        t.sessionId = null;
        t.startedAt = null;
        t.waiting = null;
        // The failed attempt's output does not belong to the queued one that replaces it: the
        // row expansion reads `result` straight out, so leaving it would show the last
        // attempt's text as if this one had produced it. The final attempt keeps its cause.
        t.error = null;
        t.result = null;
        t.nextAttemptAt = Date.now() + delay;
        return true;
      });
      return;
    }
    await this.finish(task.id, "failed", { error, result, sessionId }, TaskQueue.owns(task));
  }

  private async fill(): Promise<void> {
    for (;;) {
      const claimed = await this.claim();
      if (!claimed) return;
      await this.launch(claimed);
    }
  }

  /**
   * Takes the next eligible queued task and marks it running, inside one write chain entry.
   * The claim and the concurrency check have to be atomic or two passes double-claim a task.
   */
  private async claim(): Promise<TaskRecord | undefined> {
    const now = Date.now();
    const claimed = await this.store.mutate((tasks) => {
      if (tasks.filter((t) => t.state === "running").length >= this.concurrency) return undefined;
      const next = tasks.filter((t) => t.state === "queued" && (t.nextAttemptAt ?? 0) <= now).sort(queueOrder)[0];
      if (!next) return undefined;
      next.state = "running";
      next.startedAt = now;
      next.attempts += 1;
      next.runId = null;
      next.sessionId = null;
      next.result = null;
      next.error = null;
      next.waiting = null;
      next.nextAttemptAt = null;
      return { ...next };
    });
    if (claimed) this.announce(TASK_EVENTS.updated, claimed.id);
    return claimed;
  }

  private async launch(task: TaskRecord): Promise<void> {
    let runId: string;
    try {
      runId = await this.cli.startBackground({
        agent: task.agent,
        cwd: task.cwd,
        prompt: task.prompt,
        unattended: task.unattended,
        permissionMode: task.permissionMode,
      });
    } catch (err) {
      const message = err instanceof CliError ? err.message : (err as Error).message;
      await this.failAttempt(task, `claude --bg failed: ${message}`, null, null);
      return;
    }
    let sessionId: string | null = null;
    try {
      sessionId = (await this.cli.listSessions()).find((s) => s.id === runId)?.sessionId ?? null;
    } catch {
      // resolved lazily by the watcher
    }
    const attached = await this.patch(task.id, (t) => {
      if (!TaskQueue.owns(task)(t)) return false;
      t.runId = runId;
      t.sessionId = sessionId;
      return true;
    });
    // Cancelled while it was starting: the session exists but nothing owns it, so stop it.
    if (!attached) await this.cli.stop(runId).catch(() => {});
  }
}
