import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PermissionMode } from "../claude/claudeCli.ts";
import { type EventBus, SCHEDULE_EVENTS } from "../events.ts";
import { JsonStore } from "../store/jsonStore.ts";
import {
  DEFAULT_MAX_ATTEMPTS,
  type CreateTaskInput,
  type TaskRecord,
  checkMaxAttempts,
  checkPriority,
  checkTitle,
} from "./queue.ts";
import { InputError, checkCwd, checkPermissionMode, checkPrompt, checkRunName, checkUnattended } from "./runInput.ts";

/**
 * Cron schedules, running in this process and enqueueing into the work queue.
 *
 * A schedule is a saved task template plus a cron expression and a timezone. When it fires it
 * **creates a queued task** and returns; it never spawns a background session, never touches the
 * CLI, never writes to the run store. The queue stays the one place that starts work, so "what is
 * this server doing" has exactly one answer.
 *
 * Two consequences the UI has to say out loud:
 *
 * - **Schedules only exist while this process does.** There is no daemon and no catch-up. A fire
 *   missed because the server was down is lost, not replayed on the next start — replaying it
 *   would mean a laptop opened on Monday launching every overnight job at once. `lastFiredAt` and
 *   the derived `nextFireAt` make the gap visible instead.
 * - **One process per data directory.** M1 takes a lock on the state directory before anything
 *   reads it, so two servers can never run the same schedules. That is why there is no
 *   cross-process coordination here and no double-fire to defend against — if that lock is ever
 *   removed, this file needs a different design.
 */

export type OverlapPolicy = "skip" | "queue";

/** Which clock asked for this fire: the cron pattern, or a person pressing "run now". */
export type FireTrigger = "cron" | "manual";

export type SkipReason = "previous_run_waiting" | "previous_task_running" | "previous_task_queued";

/** The task this schedule enqueues every time it fires. Validated when saved, not only when fired. */
export interface ScheduleTask {
  /** The agent's runName — the same literal `claude --agent` takes. */
  agent: string;
  cwd: string;
  prompt: string;
  /** null lets the queue derive one from the prompt, exactly as a hand-made task does. */
  title: string | null;
  permissionMode: PermissionMode;
  unattended: boolean;
  priority: number;
  maxAttempts: number;
}

export interface ScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  /** IANA name, e.g. "Asia/Ho_Chi_Minh". Croner reads it, so DST is handled in the right zone. */
  timezone: string;
  overlapPolicy: OverlapPolicy;
  task: ScheduleTask;
  lastFiredAt: number | null;
  lastTrigger: FireTrigger | null;
  lastTaskId: string | null;
  lastSkippedAt: number | null;
  lastSkipReason: SkipReason | null;
  /** The last fire that could not be turned into a task at all. See {@link SCHEDULE_EVENTS}. */
  lastError: string | null;
  lastErrorAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The wire shape: the record plus the one field that is computed, never stored.
 *
 * `nextFireAt` is derived from the pattern on every read. Persisting it would put a second,
 * staler answer on disk — one that is wrong the moment the clock crosses it, or the process is
 * stopped, or a DST boundary moves it. There is one source of truth for when a schedule next
 * fires, and it is the pattern.
 */
export interface ScheduleView extends ScheduleRecord {
  nextFireAt: number | null;
}

export type FireResult = { fired: true; taskId: string } | { fired: false; reason: SkipReason };

/** 404 / 409 — an unknown or conflicting schedule rather than a malformed body. */
export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export const MAX_NAME_LENGTH = 80;
export const DEFAULT_OVERLAP_POLICY: OverlapPolicy = "skip";

function checkName(value: unknown): string {
  if (typeof value !== "string") throw new InputError("name must be a string");
  const name = value.trim();
  if (!name) throw new InputError("name must not be empty");
  if (name.length > MAX_NAME_LENGTH) throw new InputError(`name is too long (max ${MAX_NAME_LENGTH} characters)`);
  return name;
}

function checkEnabled(value: unknown, fallback: boolean): boolean {
  const enabled = value ?? fallback;
  if (typeof enabled !== "boolean") throw new InputError("enabled must be a boolean");
  return enabled;
}

function checkOverlapPolicy(value: unknown, fallback: OverlapPolicy): OverlapPolicy {
  const policy = value ?? fallback;
  if (policy !== "skip" && policy !== "queue") throw new InputError(`overlapPolicy must be "skip" or "queue"`);
  return policy;
}

/**
 * Croner accepts an unknown timezone string and then quietly computes in UTC, which would turn
 * a typo into a job that fires at the wrong hour every day without ever reporting anything.
 * `Intl` is the thing that actually knows the IANA database, so ask it.
 */
export function checkTimezone(value: unknown, fallback: string): string {
  const timezone = value === undefined || value === null || value === "" ? fallback : value;
  if (typeof timezone !== "string") throw new InputError("timezone must be a string");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new InputError(`unknown timezone: ${timezone} (use an IANA name such as "Europe/London")`);
  }
  return timezone;
}

/** Rejects a pattern croner cannot parse, quoting its complaint so the user can fix the field. */
export function checkCron(value: unknown, timezone: string): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError("cron must be a non-empty expression");
  const cron = value.trim();
  try {
    probe(cron, timezone).stop();
  } catch (err) {
    throw new InputError(`invalid cron expression "${cron}": ${(err as Error).message}`);
  }
  return cron;
}

/** A job that only answers questions: paused so it never fires, unref'd so it never holds the loop. */
function probe(cron: string, timezone: string): Cron {
  return new Cron(cron, { timezone, paused: true, unref: true });
}

/**
 * When this pattern next fires in this timezone, strictly after `from`, or null if it never will.
 *
 * Pure, and the whole timezone/DST surface of this module: the tests drive it with an injected
 * `from` rather than waiting for a clock.
 */
export function nextFireAfter(cron: string, timezone: string, from: Date | number = Date.now()): number | null {
  const job = probe(cron, timezone);
  try {
    return job.nextRun(new Date(from))?.getTime() ?? null;
  } finally {
    job.stop();
  }
}

/** What the scheduler needs from the queue, and nothing more. {@link TaskQueue} satisfies it. */
export interface ScheduleQueue {
  create(input: CreateTaskInput): Promise<{ id: string }>;
  latestForSchedule(scheduleId: string): Promise<TaskRecord | undefined>;
}

export interface ScheduleTaskInput {
  agent?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  title?: unknown;
  permissionMode?: unknown;
  unattended?: unknown;
  priority?: unknown;
  maxAttempts?: unknown;
}

export interface CreateScheduleInput {
  name?: unknown;
  enabled?: unknown;
  cron?: unknown;
  timezone?: unknown;
  overlapPolicy?: unknown;
  task?: unknown;
}

/** Every field optional; anything omitted keeps its stored value, including inside `task`. */
export type UpdateScheduleInput = CreateScheduleInput;

export interface SchedulerOptions {
  dataDir?: string;
  maxAttempts?: number;
  starterPrompt?: string;
  defaultCwd?: string;
  /** The host zone, used when a schedule does not name one. */
  defaultTimezone?: string;
  /** Where `schedule:*` events go; omitted in tests that do not care about them. */
  bus?: EventBus;
  /** Injected by tests so "when did this fire" is deterministic; defaults to the wall clock. */
  now?: () => number;
}

export class Scheduler {
  private readonly store: JsonStore<ScheduleRecord[]>;
  private readonly maxAttempts: number;
  private readonly starterPrompt: string;
  private readonly defaultCwd: string;
  private readonly defaultTimezone: string;
  private readonly bus?: EventBus;
  private readonly now: () => number;
  private readonly jobs = new Map<string, Cron>();
  /** Tail of the in-flight {@link fire} chain per schedule id. See {@link serialize}. */
  private readonly fireChains = new Map<string, Promise<unknown>>();
  private running = false;

  constructor(
    private readonly home: string,
    private readonly tasks: ScheduleQueue,
    opts: SchedulerOptions = {},
  ) {
    const dataDir = opts.dataDir ?? path.join(home, ".claude-agent-ui");
    this.store = new JsonStore<ScheduleRecord[]>(path.join(dataDir, "schedules.json"), () => []);
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.starterPrompt = opts.starterPrompt ?? "Start your task.";
    this.defaultCwd = opts.defaultCwd ?? home;
    this.defaultTimezone = opts.defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.bus = opts.bus;
    this.now = opts.now ?? Date.now;
  }

  private async load(): Promise<ScheduleRecord[]> {
    const data = await this.store.read();
    return Array.isArray(data) ? data : [];
  }

  // ---------------------------------------------------------------- reading

  private toView(record: ScheduleRecord): ScheduleView {
    // A disabled schedule has no next fire, and saying "tomorrow 09:00" for one would be a lie
    // the user only discovers at 09:01.
    const nextFireAt = record.enabled ? nextFireAfter(record.cron, record.timezone, this.now()) : null;
    return { ...record, nextFireAt };
  }

  async list(): Promise<ScheduleView[]> {
    return (await this.load()).sort((a, b) => a.createdAt - b.createdAt).map((r) => this.toView(r));
  }

  async get(id: string): Promise<ScheduleView> {
    return this.toView(await this.require(id));
  }

  private async require(id: string): Promise<ScheduleRecord> {
    const record = (await this.load()).find((s) => s.id === id);
    if (!record) throw new ScheduleError("schedule not found", 404);
    return record;
  }

  // ---------------------------------------------------------------- writing

  /** Applies `fn` to one schedule inside the store's write chain. Returns the new record. */
  private async patch(id: string, fn: (record: ScheduleRecord) => void): Promise<ScheduleRecord> {
    const updated = await this.store.mutate((records) => {
      const record = records.find((s) => s.id === id);
      if (!record) return undefined;
      fn(record);
      record.updatedAt = this.now();
      return { ...record };
    });
    if (!updated) throw new ScheduleError("schedule not found", 404);
    return updated;
  }

  /**
   * Validates the whole template, merging a partial update over what is stored.
   *
   * Validated when the schedule is saved rather than only when it fires: a schedule naming an
   * agent that does not exist would otherwise fail silently every night at 03:00, and the first
   * anyone hears of it is that the work never happened.
   */
  private async checkTask(value: unknown, base: ScheduleTask | null): Promise<ScheduleTask> {
    if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
      throw new InputError("task must be an object");
    }
    if ((value === undefined || value === null) && base === null) {
      throw new InputError("task is required: a schedule is a saved task template");
    }
    const input: ScheduleTaskInput = { ...(base ?? {}), ...((value as ScheduleTaskInput | null) ?? {}) };
    return {
      agent: checkRunName(input.agent),
      cwd: await checkCwd(input.cwd, this.home, this.defaultCwd),
      prompt: checkPrompt(input.prompt, this.starterPrompt),
      title: input.title === undefined || input.title === null ? null : checkTitle(input.title),
      // The literal "ask", never the server's configured default: a scheduled task fires with
      // nobody watching, so a global bypass must not be inherited by work that runs unattended.
      // Same rule, and the same reason, as the queue's own create().
      permissionMode: checkPermissionMode(input.permissionMode, "ask"),
      unattended: checkUnattended(input.unattended, true),
      priority: input.priority === undefined || input.priority === null ? 0 : checkPriority(input.priority),
      maxAttempts: checkMaxAttempts(input.maxAttempts, this.maxAttempts),
    };
  }

  async create(input: CreateScheduleInput): Promise<ScheduleView> {
    const timezone = checkTimezone(input.timezone, this.defaultTimezone);
    const at = this.now();
    const record: ScheduleRecord = {
      id: randomUUID(),
      name: checkName(input.name),
      enabled: checkEnabled(input.enabled, true),
      cron: checkCron(input.cron, timezone),
      timezone,
      overlapPolicy: checkOverlapPolicy(input.overlapPolicy, DEFAULT_OVERLAP_POLICY),
      task: await this.checkTask(input.task, null),
      lastFiredAt: null,
      lastTrigger: null,
      lastTaskId: null,
      lastSkippedAt: null,
      lastSkipReason: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.mutate((records) => {
      records.push(record);
    });
    this.schedule(record);
    this.bus?.emit(SCHEDULE_EVENTS.created, { scheduleId: record.id });
    return this.toView(record);
  }

  async update(id: string, input: UpdateScheduleInput): Promise<ScheduleView> {
    const current = await this.require(id);
    // Everything is validated before anything is written, so a rejected field cannot leave the
    // schedule half-updated — and the cron is re-checked against the new timezone, not the old one.
    const timezone = checkTimezone(input.timezone, current.timezone);
    const next: Pick<ScheduleRecord, "name" | "enabled" | "cron" | "timezone" | "overlapPolicy" | "task"> = {
      name: input.name === undefined ? current.name : checkName(input.name),
      enabled: checkEnabled(input.enabled, current.enabled),
      cron: checkCron(input.cron ?? current.cron, timezone),
      timezone,
      overlapPolicy: checkOverlapPolicy(input.overlapPolicy, current.overlapPolicy),
      task: await this.checkTask(input.task, current.task),
    };
    const record = await this.patch(id, (s) => Object.assign(s, next));
    // Rebuilt rather than mutated: croner has no way to change a running job's pattern or zone.
    this.schedule(record);
    this.bus?.emit(SCHEDULE_EVENTS.updated, { scheduleId: id });
    return this.toView(record);
  }

  async remove(id: string): Promise<void> {
    const removed = await this.store.mutate((records) => {
      const i = records.findIndex((s) => s.id === id);
      if (i === -1) return false;
      records.splice(i, 1);
      return true;
    });
    if (!removed) throw new ScheduleError("schedule not found", 404);
    // Stopped after the record is gone: a job that fires in between finds nothing and no-ops.
    this.unschedule(id);
    this.bus?.emit(SCHEDULE_EVENTS.removed, { scheduleId: id });
  }

  // ---------------------------------------------------------------- firing

  /**
   * Whether this fire has to be suppressed, and why — checked in this order on purpose.
   *
   * A run parked on a permission prompt is `running` with `waiting` set: it holds its concurrency
   * slot and can sit there for hours, so it outranks the policy and suppresses the fire under
   * `queue` as well. Stacking a second run behind a blocked one builds a pile-up nobody asked
   * for, and under `queue` that pile-up has no bound. This is a deliberate narrowing of "queue
   * fires anyway" (CEO rule, T-10: never stack a second run behind a blocked one).
   *
   * Every suppression is recorded on the schedule and emitted, because "why did my 09:00 not
   * run" must always have an answer. A silent skip would be the bug.
   */
  private async overlap(record: ScheduleRecord): Promise<SkipReason | null> {
    const previous = await this.tasks.latestForSchedule(record.id);
    if (!previous) return null;
    if (previous.state === "running" && previous.waiting !== null) return "previous_run_waiting";
    if (record.overlapPolicy === "queue") return null;
    if (previous.state === "running") return "previous_task_running";
    if (previous.state === "queued") return "previous_task_queued";
    return null;
  }

  /**
   * Runs `fn` after every earlier call for the same schedule has settled.
   *
   * The overlap check is a read of the schedule, a read of the queue and then a write to the
   * queue — three awaits. Without this, two fires that interleave both read "no previous task"
   * and both enqueue, which is a hole in `skip` and, worse, in the `waiting` rule, whose whole
   * point is that a second run is never stacked behind a blocked one. A tail chain per id puts
   * the check and the `tasks.create()` in one critical section.
   *
   * Per *process*, which is the whole story: M1 locks the data directory, so one process per data
   * dir is the only arrangement there is (see the note at the top of this file).
   *
   * What the map holds is the *caught* tail, not the caller's promise: a fire that throws — a
   * deleted working directory — must not wedge every later fire of that schedule, and must not
   * become an unhandled rejection on its way past. The entry is dropped once idle, so the map
   * stays the size of the work in flight rather than growing a key per schedule that ever fired.
   */
  private serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.fireChains.get(id) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => {});
    this.fireChains.set(id, tail);
    void tail.then(() => {
      if (this.fireChains.get(id) === tail) this.fireChains.delete(id);
    });
    return result;
  }

  /**
   * Enqueues this schedule's task, unless the overlap check says not to.
   *
   * Throws when the template can no longer be turned into a task — the agent was renamed, the
   * working directory was deleted. The failure is recorded and emitted first, so the cron path
   * can drop the throw without losing it and the run-now path can answer with it.
   *
   * Serialized per schedule id: see {@link serialize} for why the check and the enqueue cannot be
   * allowed to interleave.
   */
  fire(id: string, trigger: FireTrigger): Promise<FireResult> {
    return this.serialize(id, () => this.fireOnce(id, trigger));
  }

  private async fireOnce(id: string, trigger: FireTrigger): Promise<FireResult> {
    const record = await this.require(id);
    const reason = await this.overlap(record);
    if (reason) {
      await this.patch(id, (s) => {
        s.lastSkippedAt = this.now();
        s.lastSkipReason = reason;
      });
      this.bus?.emit(SCHEDULE_EVENTS.skipped, { scheduleId: id, reason, trigger });
      return { fired: false, reason };
    }
    let taskId: string;
    try {
      taskId = (await this.tasks.create({ ...record.task, scheduleId: id })).id;
    } catch (err) {
      const error = (err as Error).message;
      await this.patch(id, (s) => {
        s.lastError = error;
        s.lastErrorAt = this.now();
      }).catch(() => {});
      this.bus?.emit(SCHEDULE_EVENTS.failed, { scheduleId: id, error });
      throw err;
    }
    await this.patch(id, (s) => {
      s.lastFiredAt = this.now();
      s.lastTrigger = trigger;
      s.lastTaskId = taskId;
      // The template worked this time, so the stale complaint goes with it.
      s.lastError = null;
      s.lastErrorAt = null;
    });
    this.bus?.emit(SCHEDULE_EVENTS.fired, { scheduleId: id, taskId, trigger });
    return { fired: true, taskId };
  }

  /**
   * "Run once now": enqueues immediately, for testing a schedule without waiting for its hour.
   *
   * Ignores `enabled` — the toggle governs the cron clock, and pressing the button on a disabled
   * row is an explicit "run this one anyway". It does **not** ignore the overlap check: the
   * reason for not stacking runs does not stop applying because a person asked.
   */
  async runNow(id: string): Promise<FireResult> {
    return this.fire(id, "manual");
  }

  // ---------------------------------------------------------------- lifecycle

  /** Creates the croner job for one schedule, replacing any job it already had. */
  private schedule(record: ScheduleRecord): void {
    this.unschedule(record.id);
    if (!this.running || !record.enabled) return;
    const job = new Cron(
      record.cron,
      // `unref` so schedules never keep the process alive on their own, and `protect: false`
      // because croner's own overlap guard only knows about its callback — the thing we actually
      // have to not overlap is the task the previous fire created, which outlives it. See overlap().
      { timezone: record.timezone, unref: true, protect: false },
      () => {
        // fire() has already recorded and emitted anything that went wrong, so there is nothing
        // left to do with the rejection but keep it from becoming an unhandled one.
        void this.fire(record.id, "cron").catch(() => {});
      },
    );
    this.jobs.set(record.id, job);
  }

  private unschedule(id: string): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  /**
   * Arms every enabled schedule. Deliberately does not look at what was missed while the process
   * was down: see the no-catch-up note at the top of this file.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const record of await this.load()) this.schedule(record);
  }

  /** Disarms everything. Called from the server's shutdown path, alongside the lock release. */
  stop(): void {
    this.running = false;
    for (const id of [...this.jobs.keys()]) this.unschedule(id);
  }

  /** How many schedules are armed right now. Lets a test assert the clock, not just the records. */
  get armedCount(): number {
    return this.jobs.size;
  }
}
