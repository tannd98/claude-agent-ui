import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type BackgroundSession, ClaudeCli, type StartBackgroundOptions } from "../src/claude/claudeCli.ts";
import { TaskQueue } from "../src/domain/queue.ts";
import { type FireResult, Scheduler, nextFireAfter } from "../src/domain/schedules.ts";
import { type BusEvent, EventBus, SCHEDULE_EVENTS } from "../src/events.ts";
import { tempHome } from "./helpers.ts";

/**
 * The scheduler is tested against the real queue, not a stand-in for it: the overlap check reads
 * whatever state the queue actually put a task in, and a fake queue would only prove that the
 * scheduler agrees with my idea of the queue. The `claude` binary is the only thing faked.
 */
class FakeCli extends ClaudeCli {
  sessions = new Map<string, BackgroundSession>();
  started: StartBackgroundOptions[] = [];
  private next = 1;

  constructor() {
    super(async () => ({ stdout: "", stderr: "" }));
  }

  async startBackground(opts: StartBackgroundOptions): Promise<string> {
    this.started.push(opts);
    const id = `run${this.next++}`;
    this.sessions.set(id, {
      id,
      sessionId: `${id}-session`,
      pid: 100,
      cwd: opts.cwd,
      kind: "background",
      status: "busy",
      state: "working",
    });
    return id;
  }

  async listSessions(): Promise<BackgroundSession[]> {
    return [...this.sessions.values()];
  }

  async stop(id: string): Promise<void> {
    this.patch(id, { pid: undefined, status: undefined, state: "stopped" });
  }

  /** Parks the session on a permission prompt: `running`, but holding its slot indefinitely. */
  wait(id: string): void {
    this.patch(id, { status: "waiting", state: "working", waitingFor: "permission prompt" });
  }

  finish(id: string): void {
    this.patch(id, { status: "idle", state: "done" });
  }

  private patch(id: string, fields: Partial<BackgroundSession>): void {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, ...fields });
  }
}

interface Context {
  home: string;
  cli: FakeCli;
  queue: TaskQueue;
  scheduler: Scheduler;
  events: BusEvent[];
  now: () => number;
  setNow: (iso: string) => void;
}

/** The injected clock's starting point: a Monday, so weekday patterns read the way they look. */
const START = "2026-03-02T09:00:00Z";

async function withScheduler(fn: (ctx: Context) => Promise<void>): Promise<void> {
  const home = await tempHome();
  const dataDir = path.join(home, ".ui");
  const cli = new FakeCli();
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const queue = new TaskQueue(home, cli, { dataDir, bus, defaultCwd: home, starterPrompt: "go" });
  let clock = Date.parse(START);
  const scheduler = new Scheduler(home, queue, {
    dataDir,
    bus,
    defaultCwd: home,
    starterPrompt: "go",
    defaultTimezone: "UTC",
    now: () => clock,
  });
  try {
    // Nothing is armed and nothing ticks until a test asks: no timer to race.
    await fn({
      home,
      cli,
      queue,
      scheduler,
      events,
      now: () => clock,
      setNow: (iso) => {
        clock = Date.parse(iso);
      },
    });
  } finally {
    scheduler.stop();
    queue.stop();
  }
}

const template = (home: string) => ({ agent: "alpha", cwd: home, prompt: "do the thing" });

function firedTaskId(result: FireResult): string {
  if (!result.fired) assert.fail(`expected a fire, but it was skipped: ${result.reason}`);
  return result.taskId;
}

async function waitFor<T>(fn: () => T | undefined, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await delay(20);
  }
}

/** The next `count` fires after `from`, as ISO strings — readable diffs when a zone is wrong. */
function nextFires(cron: string, timezone: string, from: string, count: number): string[] {
  const out: string[] = [];
  let at = Date.parse(from);
  for (let i = 0; i < count; i++) {
    const next = nextFireAfter(cron, timezone, at);
    assert.ok(next !== null, `${cron} stopped having a next fire after ${new Date(at).toISOString()}`);
    out.push(new Date(next).toISOString());
    at = next;
  }
  return out;
}

// ------------------------------------------------------------------ timezones and DST

test("a pattern fires at its local hour in a non-UTC timezone", () => {
  // Friday 2026-03-06, 19:00 in Ho Chi Minh City: the next weekday 09:00 is Monday.
  const from = "2026-03-06T12:00:00Z";
  assert.deepEqual(nextFires("0 9 * * 1-5", "Asia/Ho_Chi_Minh", from, 2), [
    "2026-03-09T02:00:00.000Z", // 09:00 ICT (UTC+7)
    "2026-03-10T02:00:00.000Z",
  ]);
  // The same pattern read as UTC is seven hours out, so the zone is doing real work here.
  assert.deepEqual(nextFires("0 9 * * 1-5", "UTC", from, 1), ["2026-03-09T09:00:00.000Z"]);
});

test("a daily pattern keeps its local hour across both DST boundaries", () => {
  const tz = "America/New_York";
  // Spring forward 2026-03-08: EST (UTC-5) before, EDT (UTC-4) after. The local hour holds and
  // the UTC instant moves — the other way round would be the bug.
  assert.deepEqual(nextFires("0 12 * * *", tz, "2026-03-06T17:30:00Z", 3), [
    "2026-03-07T17:00:00.000Z",
    "2026-03-08T16:00:00.000Z",
    "2026-03-09T16:00:00.000Z",
  ]);
  // Fall back 2026-11-01, the same thing in reverse.
  assert.deepEqual(nextFires("0 12 * * *", tz, "2026-10-31T16:30:00Z", 2), [
    "2026-11-01T17:00:00.000Z",
    "2026-11-02T17:00:00.000Z",
  ]);
});

test("spring forward: an hour that never happens still fires exactly once", () => {
  // 02:30 on 2026-03-08 in New York does not exist; the clock jumps 02:00 to 03:00. The fire is
  // neither lost nor doubled — it lands once, at 03:30 EDT.
  assert.deepEqual(nextFires("30 2 * * *", "America/New_York", "2026-03-07T08:00:00Z", 3), [
    "2026-03-08T07:30:00.000Z",
    "2026-03-09T06:30:00.000Z",
    "2026-03-10T06:30:00.000Z",
  ]);
});

test("fall back: an hour that happens twice still fires exactly once", () => {
  // 01:30 on 2026-11-01 in New York happens twice, at 05:30Z (EDT) and again at 06:30Z (EST).
  // Only the first is a fire; 06:30Z is absent from this list and that is the whole assertion.
  assert.deepEqual(nextFires("30 1 * * *", "America/New_York", "2026-10-31T06:00:00Z", 3), [
    "2026-11-01T05:30:00.000Z",
    "2026-11-02T06:30:00.000Z",
    "2026-11-03T06:30:00.000Z",
  ]);
});

// ------------------------------------------------------------------ creating and validating

test("a created schedule carries the locked defaults and a derived next fire", () =>
  withScheduler(async (ctx) => {
    const schedule = await ctx.scheduler.create({
      name: "Nightly sweep",
      cron: "0 3 * * *",
      task: template(ctx.home),
    });
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.overlapPolicy, "skip");
    assert.equal(schedule.timezone, "UTC");
    // A scheduled task runs with nobody watching, so it is unattended and never inherits a bypass.
    assert.equal(schedule.task.permissionMode, "ask");
    assert.equal(schedule.task.unattended, true);
    assert.equal(schedule.task.maxAttempts, 1);
    assert.equal(schedule.task.title, null);
    assert.equal(schedule.lastFiredAt, null);
    assert.equal(schedule.nextFireAt, Date.parse("2026-03-03T03:00:00Z"));
    assert.deepEqual(
      ctx.events.map((e) => e.type),
      [SCHEDULE_EVENTS.created],
    );
  }));

test("a disabled schedule reports no next fire rather than one it will not honour", () =>
  withScheduler(async (ctx) => {
    const schedule = await ctx.scheduler.create({
      name: "Paused",
      cron: "0 3 * * *",
      enabled: false,
      task: template(ctx.home),
    });
    assert.equal(schedule.nextFireAt, null);
    const back = await ctx.scheduler.update(schedule.id, { enabled: true });
    assert.equal(back.nextFireAt, Date.parse("2026-03-03T03:00:00Z"));
  }));

test("an invalid cron, an unknown timezone and a bad agent are rejected and nothing is stored", () =>
  withScheduler(async (ctx) => {
    const bad = (body: Record<string, unknown>) => () =>
      ctx.scheduler.create({ name: "n", cron: "0 3 * * *", task: template(ctx.home), ...body });
    await assert.rejects(bad({ cron: "not a cron" }), /invalid cron expression/);
    await assert.rejects(bad({ timezone: "Mars/Phobos" }), /unknown timezone/);
    await assert.rejects(bad({ overlapPolicy: "whenever" }), /overlapPolicy/);
    await assert.rejects(bad({ task: { ...template(ctx.home), agent: "--dangerous" } }), /invalid agent name/);
    await assert.rejects(bad({ task: { ...template(ctx.home), cwd: "/no/such/place" } }), /does not exist/);
    await assert.rejects(bad({ name: "   " }), /name must not be empty/);
    assert.deepEqual(await ctx.scheduler.list(), []);
    assert.deepEqual(ctx.events, []);
  }));

test("a rejected update leaves the stored schedule exactly as it was", () =>
  withScheduler(async (ctx) => {
    const created = await ctx.scheduler.create({ name: "n", cron: "0 3 * * *", task: template(ctx.home) });
    await assert.rejects(
      () => ctx.scheduler.update(created.id, { name: "renamed", cron: "nonsense" }),
      /invalid cron expression/,
    );
    const after = await ctx.scheduler.get(created.id);
    assert.equal(after.name, "n");
    assert.equal(after.cron, "0 3 * * *");
  }));

test("a cron that is valid in one timezone is re-checked against a new one", () =>
  withScheduler(async (ctx) => {
    const created = await ctx.scheduler.create({ name: "n", cron: "0 9 * * *", task: template(ctx.home) });
    const moved = await ctx.scheduler.update(created.id, { timezone: "Asia/Ho_Chi_Minh" });
    assert.equal(moved.timezone, "Asia/Ho_Chi_Minh");
    assert.equal(moved.nextFireAt, Date.parse("2026-03-03T02:00:00Z"));
  }));

test("a partial update keeps every task field it did not mention", () =>
  withScheduler(async (ctx) => {
    const created = await ctx.scheduler.create({
      name: "n",
      cron: "0 3 * * *",
      task: { ...template(ctx.home), priority: 5, title: "Sweep" },
    });
    const updated = await ctx.scheduler.update(created.id, { task: { prompt: "do it differently" } });
    assert.equal(updated.task.prompt, "do it differently");
    assert.equal(updated.task.priority, 5);
    assert.equal(updated.task.title, "Sweep");
    assert.equal(updated.task.agent, "alpha");
  }));

test("an unknown schedule is a 404 on every path that takes an id", () =>
  withScheduler(async (ctx) => {
    for (const call of [
      () => ctx.scheduler.get("nope"),
      () => ctx.scheduler.update("nope", { name: "x" }),
      () => ctx.scheduler.remove("nope"),
      () => ctx.scheduler.runNow("nope"),
    ]) {
      await assert.rejects(call, (err: { status?: number }) => err.status === 404);
    }
  }));

// ------------------------------------------------------------------ firing and overlap

test("a fire enqueues one task carrying the template and the schedule id", () =>
  withScheduler(async (ctx) => {
    const schedule = await ctx.scheduler.create({
      name: "n",
      cron: "0 3 * * *",
      task: { ...template(ctx.home), priority: 3, title: "Nightly sweep" },
    });
    const taskId = firedTaskId(await ctx.scheduler.fire(schedule.id, "cron"));

    const { tasks } = await ctx.queue.list();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, taskId);
    assert.equal(tasks[0].scheduleId, schedule.id);
    assert.equal(tasks[0].state, "queued");
    assert.equal(tasks[0].title, "Nightly sweep");
    assert.equal(tasks[0].priority, 3);
    assert.equal(tasks[0].permissionMode, "ask");
    // The fire created a task and stopped there: nothing started a session.
    assert.deepEqual(ctx.cli.started, []);

    const after = await ctx.scheduler.get(schedule.id);
    assert.equal(after.lastFiredAt, ctx.now());
    assert.equal(after.lastTrigger, "cron");
    assert.equal(after.lastTaskId, taskId);
    assert.deepEqual(
      ctx.events.filter((e) => e.type === SCHEDULE_EVENTS.fired).map((e) => e.data),
      [{ scheduleId: schedule.id, taskId, trigger: "cron" }],
    );
  }));

test("skip suppresses a fire while the previous task is still queued, and says why", () =>
  withScheduler(async (ctx) => {
    const schedule = await ctx.scheduler.create({ name: "n", cron: "0 3 * * *", task: template(ctx.home) });
    firedTaskId(await ctx.scheduler.fire(schedule.id, "cron"));
    ctx.setNow("2026-03-03T03:00:00Z");

    assert.deepEqual(await ctx.scheduler.fire(schedule.id, "cron"), {
      fired: false,
      reason: "previous_task_queued",
    });
    assert.equal((await ctx.queue.list()).tasks.length, 1);

    const after = await ctx.scheduler.get(schedule.id);
    assert.equal(after.lastSkipReason, "previous_task_queued");
    assert.equal(after.lastSkippedAt, Date.parse("2026-03-03T03:00:00Z"));
    assert.deepEqual(
      ctx.events.filter((e) => e.type === SCHEDULE_EVENTS.skipped).map((e) => e.data),
      [{ scheduleId: schedule.id, reason: "previous_task_queued", trigger: "cron" }],
    );
  }));

test("skip suppresses a fire while the previous task is running; queue does not", () =>
  withScheduler(async (ctx) => {
    const schedule = await ctx.scheduler.create({ name: "n", cron: "0 3 * * *", task: template(ctx.home) });
    firedTaskId(await ctx.scheduler.fire(schedule.id, "cron"));
    await ctx.queue.tick();
    assert.equal((await ctx.queue.list()).tasks[0].state, "running");

    assert.deepEqual(await ctx.scheduler.fire(schedule.id, "cron"), {
      fired: false,
      reason: "previous_task_running",
    });
    assert.equal((await ctx.queue.list()).tasks.length, 1);

    await ctx.scheduler.update(schedule.id, { overlapPolicy: "queue" });
    firedTaskId(await ctx.scheduler.fire(schedule.id, "cron"));
    assert.equal((await ctx.queue.list()).tasks.length, 2);
  }));

test("queue fires while the previous task is still waiting its turn in the queue", () =>
  withScheduler(async (ctx) => {
    const schedule = await ctx.scheduler.create({
      name: "n",
      cron: "0 3 * * *",
      overlapPolicy: "queue",
      task: template(ctx.home),
    });
    firedTaskId(await ctx.scheduler.fire(schedule.id, "cron"));
    firedTaskId(await ctx.scheduler.fire(schedule.id, "cron"));
    const { tasks } = await ctx.queue.list();
    assert.equal(tasks.length, 2);
    assert.deepEqual(new Set(tasks.map((t) => t.scheduleId)), new Set([schedule.id]));
  }));

test("a previous run parked on a permission prompt suppresses the fire under BOTH policies", () =>
  withScheduler(async (ctx) => {
    const schedule = await ctx.scheduler.create({
      name: "n",
      cron: "0 3 * * *",
      overlapPolicy: "queue",
      task: template(ctx.home),
    });
    firedTaskId(await ctx.scheduler.fire(schedule.id, "cron"));
    await ctx.queue.tick();
    ctx.cli.wait("run1");
    await ctx.queue.tick();
    const parked = (await ctx.queue.list()).tasks[0];
    assert.equal(parked.state, "running");
    assert.equal(parked.waiting?.reason, "permission");

    // `queue` means "fire anyway", except behind a run that is blocked holding its slot: that
    // pile-up has no bound. Narrowing `queue` here is deliberate, not an oversight.
    assert.deepEqual(await ctx.scheduler.fire(schedule.id, "cron"), {
      fired: false,
      reason: "previous_run_waiting",
    });
    await ctx.scheduler.update(schedule.id, { overlapPolicy: "skip" });
    assert.deepEqual(await ctx.scheduler.fire(schedule.id, "cron"), {
      fired: false,
      reason: "previous_run_waiting",
    });
    assert.equal((await ctx.queue.list()).tasks.length, 1);

    // And once the prompt is answered and the run ends, the next fire goes ahead.
    ctx.cli.finish("run1");
    await ctx.queue.tick();
    assert.equal((await ctx.queue.list()).tasks[0].state, "succeeded");
    firedTaskId(await ctx.scheduler.fire(schedule.id, "cron"));
    assert.equal((await ctx.queue.list()).tasks.length, 2);
  }));

test("fires that land at the same instant are serialized, so skip still means one task", () =>
  withScheduler(async (ctx) => {
    // The cron clock, a `POST /run-now` and a second browser tab can all arrive inside the same
    // tick. The check is three awaits long, so without serialization all three read "no previous
    // task" and all three enqueue — the UI's busy flag only ever guarded one row in one tab.
    const schedule = await ctx.scheduler.create({ name: "n", cron: "0 3 * * *", task: template(ctx.home) });
    const results = await Promise.all([
      ctx.scheduler.fire(schedule.id, "cron"),
      ctx.scheduler.runNow(schedule.id),
      ctx.scheduler.runNow(schedule.id),
    ]);

    assert.equal(results.filter((r) => r.fired).length, 1);
    assert.equal((await ctx.queue.list()).tasks.length, 1);
    // And the two that lost are recorded and emitted like any other skip, not dropped silently.
    assert.deepEqual(
      results.filter((r) => !r.fired),
      [
        { fired: false, reason: "previous_task_queued" },
        { fired: false, reason: "previous_task_queued" },
      ],
    );
    assert.equal(ctx.events.filter((e) => e.type === SCHEDULE_EVENTS.skipped).length, 2);
    assert.equal((await ctx.scheduler.get(schedule.id)).lastSkipReason, "previous_task_queued");
  }));

test("the race cannot leave a second task stacked behind a run that then blocks", () =>
  withScheduler(async (ctx) => {
    // Why the race is worse than a duplicate task. Two fires that both get through leave a second
    // task queued; when the first run then parks on a permission prompt it holds its slot
    // indefinitely, and the second is already stacked behind it — the exact pile-up the CEO rule
    // forbids. The rule is enforced at the only moment it can be, before the second task exists.
    const schedule = await ctx.scheduler.create({ name: "n", cron: "0 3 * * *", task: template(ctx.home) });
    await Promise.all([ctx.scheduler.fire(schedule.id, "cron"), ctx.scheduler.runNow(schedule.id)]);

    await ctx.queue.tick();
    ctx.cli.wait("run1");
    await ctx.queue.tick();
    const tasks = (await ctx.queue.list()).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].waiting?.reason, "permission");

    // And with the blocked run holding its slot, the next fire is refused for that reason.
    assert.deepEqual(await ctx.scheduler.fire(schedule.id, "cron"), {
      fired: false,
      reason: "previous_run_waiting",
    });
  }));

test("a fire that throws does not wedge the next fire of the same schedule", () =>
  withScheduler(async (ctx) => {
    // The serialization chain has to carry on through a rejection. If it did not, one deleted
    // working directory would stop that schedule firing for the lifetime of the process.
    const cwd = path.join(ctx.home, "gone");
    await mkdir(cwd, { recursive: true });
    const schedule = await ctx.scheduler.create({
      name: "n",
      cron: "0 3 * * *",
      task: { ...template(ctx.home), cwd },
    });
    await rm(cwd, { recursive: true, force: true });
    await assert.rejects(() => ctx.scheduler.fire(schedule.id, "cron"), /does not exist/);

    await ctx.scheduler.update(schedule.id, { task: { cwd: ctx.home } });
    firedTaskId(await ctx.scheduler.fire(schedule.id, "cron"));
    assert.equal((await ctx.queue.list()).tasks.length, 1);
    // The repaired fire clears the stale complaint rather than leaving it to be read tomorrow.
    assert.equal((await ctx.scheduler.get(schedule.id)).lastError, null);
  }));

test("a fire whose template can no longer be enqueued records the failure and reports it", () =>
  withScheduler(async (ctx) => {
    // The working directory was valid when the schedule was saved, and is deleted afterwards.
    const cwd = path.join(ctx.home, "work");
    await mkdir(cwd, { recursive: true });
    const schedule = await ctx.scheduler.create({
      name: "n",
      cron: "0 3 * * *",
      task: { ...template(ctx.home), cwd },
    });
    await rm(cwd, { recursive: true, force: true });

    await assert.rejects(() => ctx.scheduler.fire(schedule.id, "cron"), /does not exist/);
    assert.deepEqual((await ctx.queue.list()).tasks, []);
    assert.match(String((await ctx.scheduler.get(schedule.id)).lastError), /does not exist/);
    const failures = ctx.events.filter((e) => e.type === SCHEDULE_EVENTS.failed);
    assert.equal(failures.length, 1);
    assert.match(String((failures[0].data as { error: string }).error), /does not exist/);
  }));

// ------------------------------------------------------------------ run now

test("run now enqueues immediately, is recorded as manual, and works on a disabled schedule", () =>
  withScheduler(async (ctx) => {
    const schedule = await ctx.scheduler.create({
      name: "n",
      cron: "0 3 * * *",
      enabled: false,
      task: template(ctx.home),
    });
    const taskId = firedTaskId(await ctx.scheduler.runNow(schedule.id));
    assert.equal((await ctx.queue.list()).tasks.length, 1);

    const after = await ctx.scheduler.get(schedule.id);
    assert.equal(after.lastTaskId, taskId);
    assert.equal(after.lastTrigger, "manual");
    // Pressing the button did not arm the cron clock, and did not invent a next fire.
    assert.equal(after.enabled, false);
    assert.equal(after.nextFireAt, null);
  }));

test("run now still respects the overlap check", () =>
  withScheduler(async (ctx) => {
    const schedule = await ctx.scheduler.create({ name: "n", cron: "0 3 * * *", task: template(ctx.home) });
    firedTaskId(await ctx.scheduler.runNow(schedule.id));
    assert.deepEqual(await ctx.scheduler.runNow(schedule.id), { fired: false, reason: "previous_task_queued" });
    assert.equal((await ctx.queue.list()).tasks.length, 1);
  }));

// ------------------------------------------------------------------ lifecycle

test("nothing is armed until start, and stop disarms everything", () =>
  withScheduler(async (ctx) => {
    const schedule = await ctx.scheduler.create({ name: "n", cron: "0 3 * * *", task: template(ctx.home) });
    assert.equal(ctx.scheduler.armedCount, 0);
    await ctx.scheduler.start();
    assert.equal(ctx.scheduler.armedCount, 1);

    // The toggle governs the clock, so disabling disarms and re-enabling re-arms.
    await ctx.scheduler.update(schedule.id, { enabled: false });
    assert.equal(ctx.scheduler.armedCount, 0);
    await ctx.scheduler.update(schedule.id, { enabled: true });
    assert.equal(ctx.scheduler.armedCount, 1);

    await ctx.scheduler.remove(schedule.id);
    assert.equal(ctx.scheduler.armedCount, 0);
    await ctx.scheduler.start();
    assert.equal(ctx.scheduler.armedCount, 0);

    ctx.scheduler.stop();
    assert.equal(ctx.scheduler.armedCount, 0);
  }));

test("a fire missed while the server was down is lost, not replayed on the next start", () =>
  withScheduler(async (ctx) => {
    // Once a year, so nothing here can collide with the wall clock the cron job actually uses.
    const schedule = await ctx.scheduler.create({ name: "n", cron: "0 3 3 3 *", task: template(ctx.home) });
    // The server was down over this morning's 03:00 and comes back up at 09:00.
    ctx.setNow("2026-03-03T09:00:00Z");
    await ctx.scheduler.start();
    await delay(100);

    assert.deepEqual((await ctx.queue.list()).tasks, []);
    const after = await ctx.scheduler.get(schedule.id);
    assert.equal(after.lastFiredAt, null);
    // The gap is visible rather than backfilled: the next fire is a year out, not this morning.
    assert.equal(after.nextFireAt, Date.parse("2027-03-03T03:00:00Z"));
  }));

test("a schedule that comes due fires once, enqueues one task, and the queue runs it", () =>
  withScheduler(async (ctx) => {
    // Every second rather than the issue's "one minute out": the same croner path, waited on in
    // a second instead of sixty. The default `skip` policy is what holds it to one task even if
    // the clock ticks again before the scheduler is disarmed.
    const schedule = await ctx.scheduler.create({ name: "e2e", cron: "* * * * * *", task: template(ctx.home) });
    await ctx.scheduler.start();
    assert.equal(ctx.scheduler.armedCount, 1);

    const fired = await waitFor(() => ctx.events.find((e) => e.type === SCHEDULE_EVENTS.fired), "the schedule to fire");
    ctx.scheduler.stop();
    assert.deepEqual(fired.data, {
      scheduleId: schedule.id,
      taskId: (await ctx.scheduler.get(schedule.id)).lastTaskId,
      trigger: "cron",
    });

    const queued = (await ctx.queue.list()).tasks;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].state, "queued");
    assert.equal(queued[0].scheduleId, schedule.id);

    // And it drains through the queue like any other task.
    await ctx.queue.tick();
    assert.equal((await ctx.queue.list()).tasks[0].state, "running");
    ctx.cli.finish("run1");
    await ctx.queue.tick();
    assert.equal((await ctx.queue.list()).tasks[0].state, "succeeded");
    assert.equal(ctx.cli.started.length, 1);
  }));

test("schedules survive a restart, and arming them again does not fire them", () =>
  withScheduler(async (ctx) => {
    const created = await ctx.scheduler.create({
      name: "Nightly sweep",
      cron: "0 3 * * *",
      timezone: "Asia/Ho_Chi_Minh",
      overlapPolicy: "queue",
      task: { ...template(ctx.home), priority: 2 },
    });
    await ctx.scheduler.start();
    ctx.scheduler.stop();
    await ctx.scheduler.start();

    const [reloaded] = await ctx.scheduler.list();
    assert.equal(reloaded.id, created.id);
    assert.equal(reloaded.timezone, "Asia/Ho_Chi_Minh");
    assert.equal(reloaded.overlapPolicy, "queue");
    assert.equal(reloaded.task.priority, 2);
    assert.deepEqual((await ctx.queue.list()).tasks, []);
  }));
