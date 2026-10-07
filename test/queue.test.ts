import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { type BackgroundSession, CliError, ClaudeCli, type StartBackgroundOptions } from "../src/claude/claudeCli.ts";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_MAX_ATTEMPTS,
  type TaskQueueOptions,
  type TaskRecord,
  TaskQueue,
  type TaskView,
} from "../src/domain/queue.ts";
import { type BusEvent, EventBus } from "../src/events.ts";
import { put, tempHome } from "./helpers.ts";

/**
 * Stands in for the real binary: sessions are created by startBackground and then driven by the
 * test (finish / wait / fail / vanish), so the whole loop runs without a claude process anywhere.
 */
class FakeCli extends ClaudeCli {
  sessions = new Map<string, BackgroundSession>();
  started: StartBackgroundOptions[] = [];
  stopped: string[] = [];
  startError: string | null = null;
  listError: string | null = null;
  stopError: string | null = null;
  private next = 1;

  constructor() {
    super(async () => ({ stdout: "", stderr: "" }));
  }

  async startBackground(opts: StartBackgroundOptions): Promise<string> {
    this.started.push(opts);
    if (this.startError) throw new CliError(this.startError, this.startError);
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

  /** Lets a test run inside the watcher's await, so an interleaving is deterministic not lucky. */
  onList: (() => Promise<void>) | null = null;

  async listSessions(): Promise<BackgroundSession[]> {
    if (this.listError) throw new CliError(this.listError, this.listError);
    const gate = this.onList;
    if (gate) {
      this.onList = null;
      await gate();
    }
    return [...this.sessions.values()];
  }

  /** The same gate for the other side of the race: a tick landing inside `cancel`'s await. */
  onStop: (() => Promise<void>) | null = null;

  async stop(id: string): Promise<void> {
    const gate = this.onStop;
    if (gate) {
      this.onStop = null;
      await gate();
    }
    if (this.stopError) throw new CliError(this.stopError, this.stopError);
    this.stopped.push(id);
    this.patch(id, { pid: undefined, status: undefined, state: "stopped" });
  }

  private patch(id: string, fields: Partial<BackgroundSession>): void {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, ...fields });
  }

  /** The session went idle with a result waiting in its transcript. */
  finish(id: string): void {
    this.patch(id, { status: "idle", state: "done" });
  }

  /** Parked on a prompt a human has to answer. */
  wait(id: string, waitingFor = "permission prompt"): void {
    this.patch(id, { status: "waiting", state: "blocked", waitingFor });
  }

  /** The wait resolved and the session went back to work. */
  resume(id: string): void {
    this.patch(id, { status: "busy", state: "working", waitingFor: undefined });
  }

  /** The CLI's own verdict that the session failed. */
  fail(id: string): void {
    this.patch(id, { status: "idle", state: "failed" });
  }

  /** The session is no longer listed at all. */
  vanish(id: string): void {
    this.sessions.delete(id);
  }
}

interface Harness {
  home: string;
  dataDir: string;
  cli: FakeCli;
  queue: TaskQueue;
  events: BusEvent[];
}

async function harness(opts: TaskQueueOptions = {}): Promise<Harness> {
  const home = await tempHome();
  const dataDir = path.join(home, ".ui");
  const cli = new FakeCli();
  const events: BusEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  const queue = new TaskQueue(home, cli, { dataDir, bus, defaultCwd: home, starterPrompt: "go", ...opts });
  return { home, dataDir, cli, queue, events };
}

async function view(queue: TaskQueue, id: string): Promise<TaskView> {
  const found = (await queue.list()).tasks.find((t) => t.id === id);
  assert.ok(found, `task ${id} is not in the list`);
  return found;
}

/** Writes the final-message transcript the queue reads once a session ends. */
async function writeTranscript(home: string, sessionId: string, text: string): Promise<void> {
  const file = path.join(home, ".claude", "projects", "-work", `${sessionId}.jsonl`);
  await put(
    file,
    [
      JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: "go" } }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:01:00.000Z",
        message: { id: "m1", role: "assistant", content: [{ type: "text", text }] },
      }),
    ].join("\n"),
  );
}

const taskIds = (events: BusEvent[], type: string) =>
  events.filter((e) => e.type === type).map((e) => (e.data as { taskId: string }).taskId);

test("the locked defaults are what the queue ships with", () => {
  assert.equal(DEFAULT_CONCURRENCY, 2);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 1);
  assert.equal(DEFAULT_HISTORY_LIMIT, 500);
});

test("a task goes queued → running → succeeded with its result readable", async () => {
  const { home, cli, queue, events } = await harness();
  const created = await queue.create({ agent: "alpha", prompt: "do the thing" });
  assert.equal(created.state, "queued");
  assert.equal(created.queuePosition, 1);
  assert.equal(created.title, "do the thing");
  // A queued task has nobody watching: unattended on, permissions still asked for.
  assert.equal(created.permissionMode, "ask");
  assert.equal(created.unattended, true);
  assert.equal(created.attachCommand, null);

  await queue.tick();
  let task = await view(queue, created.id);
  assert.equal(task.state, "running");
  assert.equal(task.runId, "run1");
  assert.equal(task.sessionId, "run1-session");
  assert.equal(task.attachCommand, "claude attach run1");
  assert.equal(task.attempts, 1);
  assert.equal(task.queuePosition, null);
  assert.deepEqual(cli.started[0].permissionMode, "ask");
  assert.equal(cli.started[0].unattended, true);

  await writeTranscript(home, "run1-session", "All done.");
  cli.finish("run1");
  await queue.tick();
  task = await view(queue, created.id);
  assert.equal(task.state, "succeeded");
  assert.equal(task.result, "All done.");
  assert.equal(task.error, null);
  assert.ok(task.finishedAt && task.finishedAt >= task.startedAt!);
  assert.deepEqual(taskIds(events, "task:created"), [created.id]);
});

test("a running task that has not changed emits nothing on later polls", async () => {
  const { queue, events } = await harness();
  const created = await queue.create({ agent: "alpha", prompt: "x" });
  await queue.tick();
  const settled = events.length;
  await queue.tick();
  await queue.tick();
  // The watcher emits on an observed change only, so a long run is not an event storm.
  assert.equal(events.length, settled);
  assert.equal((await view(queue, created.id)).state, "running");
});

test("two tasks run at once and a third waits for a slot", async () => {
  const { home, cli, queue } = await harness();
  const a = await queue.create({ agent: "alpha", prompt: "a" });
  const b = await queue.create({ agent: "alpha", prompt: "b" });
  const c = await queue.create({ agent: "alpha", prompt: "c" });

  await queue.tick();
  assert.equal((await view(queue, a.id)).state, "running");
  assert.equal((await view(queue, b.id)).state, "running");
  const third = await view(queue, c.id);
  assert.equal(third.state, "queued");
  assert.equal(third.queuePosition, 1);
  assert.deepEqual(await queue.stats(), { queued: 1, running: 2, waiting: 0, maxConcurrent: 2 });

  // Freeing one slot lets exactly one more in.
  await writeTranscript(home, "run1-session", "first done");
  cli.finish("run1");
  await queue.tick();
  assert.equal((await view(queue, a.id)).state, "succeeded");
  assert.equal((await view(queue, c.id)).state, "running");
  assert.deepEqual(await queue.stats(), { queued: 0, running: 2, waiting: 0, maxConcurrent: 2 });
});

test("higher priority runs first, and ties go to the older task", async () => {
  const { queue } = await harness({ concurrency: 1 });
  const low = await queue.create({ agent: "alpha", prompt: "low" });
  const alsoLow = await queue.create({ agent: "alpha", prompt: "also low" });
  const high = await queue.create({ agent: "alpha", prompt: "high", priority: 5 });

  assert.deepEqual(
    (await queue.list()).tasks.filter((t) => t.state === "queued").map((t) => t.prompt),
    ["high", "low", "also low"],
  );
  await queue.tick();
  assert.equal((await view(queue, high.id)).state, "running");
  assert.equal((await view(queue, low.id)).queuePosition, 1);
  assert.equal((await view(queue, alsoLow.id)).queuePosition, 2);
});

test("a BLOCKED: reply lands in state blocked with the sentinel stripped", async () => {
  const { home, cli, queue } = await harness();
  const created = await queue.create({ agent: "alpha", prompt: "x" });
  await queue.tick();
  await writeTranscript(home, "run1-session", "BLOCKED: I need the staging database URL.");
  cli.finish("run1");
  await queue.tick();

  const task = await view(queue, created.id);
  assert.equal(task.state, "blocked");
  // Stripped server-side: the sentinel comes from the prompt we inject, so the UI never sees it.
  assert.equal(task.result, "I need the staging database URL.");
});

test("a waiting session is reported inline, holds its slot, and announces once", async () => {
  const { cli, queue, events } = await harness({ concurrency: 1 });
  const created = await queue.create({ agent: "alpha", prompt: "x" });
  const queued = await queue.create({ agent: "alpha", prompt: "next" });
  await queue.tick();

  cli.wait("run1", "permission prompt");
  await queue.tick();
  const task = await view(queue, created.id);
  // Not a seventh state: still running, with the wait hung off it.
  assert.equal(task.state, "running");
  assert.equal(task.waiting?.reason, "permission");
  assert.equal(task.waiting?.detail, "permission prompt");
  assert.ok(task.waiting && task.waiting.since > 0);
  assert.equal(task.attachCommand, "claude attach run1");
  // A parked run is not finished, so it is never given a final message.
  assert.equal(task.result, null);

  const announced = events.length;
  await queue.tick();
  await queue.tick();
  assert.equal(events.length, announced, "a held wait must not emit once per poll");

  // It holds its slot: the queued task stays queued, and waiting counts inside running.
  assert.equal((await view(queue, queued.id)).state, "queued");
  assert.deepEqual(await queue.stats(), { queued: 1, running: 1, waiting: 1, maxConcurrent: 1 });
});

test("a soft wait carries the CLI's own reason, and an unnamed one carries nothing", async () => {
  const { cli, queue } = await harness();
  const named = await queue.create({ agent: "alpha", prompt: "a" });
  const unnamed = await queue.create({ agent: "alpha", prompt: "b" });
  await queue.tick();

  cli.wait("run1", "sandbox request");
  cli.wait("run2", "");
  await queue.tick();
  assert.deepEqual(
    { ...(await view(queue, named.id)).waiting, since: 0 },
    { reason: "other", detail: "sandbox request", since: 0 },
  );
  // We do not synthesise a stand-in for a wait the CLI did not name.
  assert.deepEqual({ ...(await view(queue, unnamed.id)).waiting, since: 0 }, { reason: "other", detail: "", since: 0 });

  // And leaving the wait clears it, with an event so the badge cannot go on lying.
  cli.resume("run1");
  await queue.tick();
  assert.equal((await view(queue, named.id)).waiting, null);
});

test("cancel drops a queued task and stops a running one", async () => {
  const { cli, queue } = await harness({ concurrency: 1 });
  const running = await queue.create({ agent: "alpha", prompt: "a" });
  const queued = await queue.create({ agent: "alpha", prompt: "b" });
  await queue.tick();

  const droppedView = await queue.cancel(queued.id);
  assert.equal(droppedView.state, "cancelled");
  assert.deepEqual(cli.stopped, [], "cancelling a queued task must not touch the CLI");

  const stoppedView = await queue.cancel(running.id);
  assert.equal(stoppedView.state, "cancelled");
  assert.deepEqual(cli.stopped, ["run1"]);
  assert.deepEqual(await queue.stats(), { queued: 0, running: 0, waiting: 0, maxConcurrent: 1 });

  // Idempotent, so a double-click is never an error the user has to read.
  assert.equal((await queue.cancel(running.id)).state, "cancelled");
});

test("cancel on a finished task is 409, and claude stop failing is 502", async () => {
  const { home, cli, queue } = await harness();
  const done = await queue.create({ agent: "alpha", prompt: "a" });
  await queue.tick();
  await writeTranscript(home, "run1-session", "ok");
  cli.finish("run1");
  await queue.tick();
  await assert.rejects(queue.cancel(done.id), (err: any) => err.status === 409);
  await assert.rejects(queue.cancel("nope"), (err: any) => err.status === 404);

  const live = await queue.create({ agent: "alpha", prompt: "b" });
  await queue.tick();
  cli.stopError = "session is gone";
  await assert.rejects(queue.cancel(live.id), (err: any) => err.status === 502);
  // And it stays running rather than being recorded as cancelled on a stop that did not happen.
  assert.equal((await view(queue, live.id)).state, "running");
});

test("a cancel landing inside a settling tick is not overwritten by it", async () => {
  const { home, cli, queue } = await harness();
  const task = await queue.create({ agent: "alpha", prompt: "a" });
  await queue.tick();
  await writeTranscript(home, "run1-session", "All done.");
  cli.finish("run1");

  // The watcher reads the running tasks, then awaits the CLI twice before it writes. A cancel
  // arriving in that window is the user's decision and has to win: the task is already over.
  cli.onList = async () => {
    assert.equal((await queue.cancel(task.id)).state, "cancelled");
  };
  await queue.tick();

  const after = await view(queue, task.id);
  assert.equal(after.state, "cancelled", "the settling tick revived a cancelled task");
  assert.equal(after.result, null);
  assert.deepEqual(cli.stopped, ["run1"]);
});

test("a cancel landing inside a settling tick is never requeued for another attempt", async () => {
  const { cli, queue } = await harness({ maxAttempts: 2 });
  const task = await queue.create({ agent: "alpha", prompt: "a" });
  await queue.tick();
  assert.equal((await view(queue, task.id)).maxAttempts, 2);
  cli.fail("run1");

  // The escalation of the same race: the failure path would read attempts(1) < maxAttempts(2)
  // and put the task the user just stopped back in the queue, where it starts a second
  // background session — carrying this task's permissionMode into an unsupervised rerun.
  cli.onList = async () => {
    assert.equal((await queue.cancel(task.id)).state, "cancelled");
  };
  await queue.tick();

  assert.equal((await view(queue, task.id)).state, "cancelled", "a cancelled task was requeued");
  assert.deepEqual(await queue.stats(), { queued: 0, running: 0, waiting: 0, maxConcurrent: 2 });
  assert.equal(cli.started.length, 1, "the cancelled task was launched a second time");
});

test("a task that settles while claude stop is in flight keeps the outcome it reported", async () => {
  const { home, cli, queue } = await harness();
  const task = await queue.create({ agent: "alpha", prompt: "a" });
  await queue.tick();
  await writeTranscript(home, "run1-session", "All done.");
  cli.finish("run1");
  // The other direction: cancel saw it running, then a tick settled it while `claude stop` was
  // still in flight. A real result must not be thrown away and relabelled "cancelled".
  cli.onStop = async () => {
    await queue.tick();
  };
  const returned = await queue.cancel(task.id);
  assert.equal(returned.state, "succeeded", "cancel overwrote a result that had already landed");
  assert.equal(returned.result, "All done.");
  assert.equal((await view(queue, task.id)).state, "succeeded");
});

test("a requeued attempt does not carry the previous attempt's result or error", async () => {
  const { home, cli, queue } = await harness({ maxAttempts: 2 });
  const task = await queue.create({ agent: "alpha", prompt: "a" });
  await queue.tick();
  await writeTranscript(home, "run1-session", "half-finished thought");
  cli.fail("run1");
  await queue.tick();

  // Queued again, so the row expansion reads `result` — and it must not show the failed
  // attempt's text as if this one had produced it.
  const requeued = await view(queue, task.id);
  assert.equal(requeued.state, "queued");
  assert.equal(requeued.attempts, 1);
  assert.equal(requeued.result, null);
  assert.equal(requeued.error, null);
});

test("retry clones a finished task to a new queued one and leaves the original alone", async () => {
  const { home, cli, queue, events } = await harness();
  const original = await queue.create({ agent: "alpha", prompt: "x", priority: 3 });
  await queue.tick();
  await writeTranscript(home, "run1-session", "nope");
  cli.fail("run1");
  await queue.tick();
  assert.equal((await view(queue, original.id)).state, "failed");

  const clone = await queue.retry(original.id);
  assert.notEqual(clone.id, original.id);
  assert.equal(clone.state, "queued");
  assert.equal(clone.attempts, 0);
  assert.equal(clone.priority, 3);
  assert.equal(clone.runId, null);
  assert.equal(clone.result, null);
  assert.equal(clone.error, null);
  // History is not rewritten: the row the user clicked keeps its failure.
  assert.equal((await view(queue, original.id)).state, "failed");
  assert.deepEqual(taskIds(events, "task:created"), [original.id, clone.id]);

  await assert.rejects(queue.retry(clone.id), (err: any) => err.status === 409);
});

test("a vanished session fails the task, and the CLI's own failure verdict is read", async () => {
  const { cli, queue } = await harness();
  const gone = await queue.create({ agent: "alpha", prompt: "a" });
  const broken = await queue.create({ agent: "alpha", prompt: "b" });
  await queue.tick();

  cli.vanish("run1");
  cli.fail("run2");
  await queue.tick();
  const vanished = await view(queue, gone.id);
  assert.equal(vanished.state, "failed");
  assert.match(vanished.error!, /no longer listed/);
  const failed = await view(queue, broken.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error!, /session failed/);
});

test("a start that the CLI refuses fails the task with the reason", async () => {
  const { cli, queue } = await harness();
  const created = await queue.create({ agent: "alpha", prompt: "a" });
  cli.startError = "Workspace not trusted";
  await queue.tick();
  const task = await view(queue, created.id);
  assert.equal(task.state, "failed");
  assert.match(task.error!, /claude --bg failed: Workspace not trusted/);
});

test("a CLI poll that fails warns instead of guessing at the states", async () => {
  const { cli, queue } = await harness();
  const created = await queue.create({ agent: "alpha", prompt: "a" });
  await queue.tick();
  cli.listError = "connection refused";
  await queue.tick();

  const { tasks, warning } = await queue.list();
  assert.match(warning!, /could not read claude agents --json: connection refused/);
  assert.equal(tasks[0].state, "running", "an unreadable CLI must not move a task");

  cli.listError = null;
  await queue.tick();
  assert.equal((await queue.list()).warning, null);
});

test("retries stay off by default, and an attempt left requeues with backoff", async () => {
  const off = await harness();
  const once = await off.queue.create({ agent: "alpha", prompt: "a" });
  await off.queue.tick();
  off.cli.vanish("run1");
  await off.queue.tick();
  assert.equal((await view(off.queue, once.id)).state, "failed", "maxAttempts 1 means no retry");

  const twice = await harness({ maxAttempts: 2 });
  const retried = await twice.queue.create({ agent: "alpha", prompt: "a" });
  await twice.queue.tick();
  twice.cli.vanish("run1");
  await twice.queue.tick();
  const task = await view(twice.queue, retried.id);
  assert.equal(task.state, "queued");
  assert.equal(task.attempts, 1);
  // Backed off, so the very next pass does not immediately burn the second attempt.
  await twice.queue.tick();
  assert.equal((await view(twice.queue, retried.id)).state, "queued");
  assert.equal(twice.cli.started.length, 1);
});

test("a crash between claiming a slot and recording the session does not strand the task", async () => {
  const { dataDir, queue } = await harness();
  const created = await queue.create({ agent: "alpha", prompt: "a" });
  // Exactly the on-disk state a kill in the start window leaves behind.
  const file = path.join(dataDir, "tasks.json");
  const tasks = JSON.parse(await readFile(file, "utf8")) as TaskRecord[];
  tasks[0].state = "running";
  tasks[0].startedAt = Date.now();
  tasks[0].attempts = 1;
  await put(file, JSON.stringify(tasks, null, 2));

  await queue.reconcile();
  const task = await view(queue, created.id);
  assert.equal(task.state, "failed");
  assert.match(task.error!, /never recorded/);
  assert.deepEqual(await queue.stats(), { queued: 0, running: 0, waiting: 0, maxConcurrent: 2 });
});

test("a restart adopts a running task whose session outlived the server", async () => {
  const { home, dataDir, cli, queue } = await harness();
  const created = await queue.create({ agent: "alpha", prompt: "a" });
  await queue.tick();
  assert.equal((await view(queue, created.id)).runId, "run1");

  // A second queue over the same state directory stands in for the restarted process.
  const restarted = new TaskQueue(home, cli, { dataDir, defaultCwd: home, starterPrompt: "go" });
  await restarted.reconcile();
  assert.equal((await view(restarted, created.id)).state, "running", "a live session must not be failed");

  await writeTranscript(home, "run1-session", "finished after the restart");
  cli.finish("run1");
  await restarted.tick();
  const task = await view(restarted, created.id);
  assert.equal(task.state, "succeeded");
  assert.equal(task.result, "finished after the restart");
});

test("the history cap prunes the oldest finished task and says so", async () => {
  // 3 stands in for the shipped 500: the rule is the cap, not the number.
  const { queue, events } = await harness({ historyLimit: 3 });
  const ids: string[] = [];
  for (const n of [1, 2, 3, 4]) {
    const task = await queue.create({ agent: "alpha", prompt: `t${n}` });
    await queue.cancel(task.id);
    ids.push(task.id);
  }
  const { tasks } = await queue.list();
  assert.equal(tasks.length, 3);
  assert.equal(
    tasks.some((t) => t.id === ids[0]),
    false,
  );
  assert.deepEqual(taskIds(events, "task:removed"), [ids[0]]);
});

test("queued and running tasks are never pruned, however small the cap", async () => {
  const { home, cli, queue } = await harness({ historyLimit: 1, concurrency: 1 });
  const done = await queue.create({ agent: "alpha", prompt: "done" });
  await queue.tick();
  await writeTranscript(home, "run1-session", "ok");
  cli.finish("run1");
  await queue.tick();

  const running = await queue.create({ agent: "alpha", prompt: "running" });
  const queued = await queue.create({ agent: "alpha", prompt: "queued" });
  await queue.tick();
  const states = new Map((await queue.list()).tasks.map((t) => [t.id, t.state]));
  assert.equal(states.get(running.id), "running");
  assert.equal(states.get(queued.id), "queued");
  assert.equal(states.get(done.id), "succeeded");
});

test("the list is ordered running, then queue order, then most recently finished", async () => {
  const { home, cli, queue } = await harness({ concurrency: 1 });
  const first = await queue.create({ agent: "alpha", prompt: "first" });
  await queue.tick();
  await writeTranscript(home, "run1-session", "ok");
  cli.finish("run1");
  await queue.tick();
  const live = await queue.create({ agent: "alpha", prompt: "live" });
  await queue.tick();
  // Created after the only slot was taken, so priority decides the queue but not what is running.
  await queue.create({ agent: "alpha", prompt: "later" });
  await queue.create({ agent: "alpha", prompt: "urgent", priority: 9 });
  await queue.tick();

  assert.deepEqual(
    (await queue.list()).tasks.map((t) => t.prompt),
    ["live", "urgent", "later", "first"],
  );
  assert.equal((await view(queue, live.id)).state, "running");
});

test("priority can be changed while queued and nowhere else", async () => {
  const { queue } = await harness({ concurrency: 1 });
  const running = await queue.create({ agent: "alpha", prompt: "a" });
  const queued = await queue.create({ agent: "alpha", prompt: "b" });
  const other = await queue.create({ agent: "alpha", prompt: "c" });
  await queue.tick();

  const raised = await queue.update(other.id, { priority: 4 });
  assert.equal(raised.priority, 4);
  assert.equal(raised.queuePosition, 1);
  assert.equal((await view(queue, queued.id)).queuePosition, 2);

  await assert.rejects(queue.update(running.id, { priority: 1 }), (err: any) => err.status === 409);
  // A title is editable in any state — it is a label, not scheduling.
  assert.equal((await queue.update(running.id, { title: "renamed" })).title, "renamed");
});

test("bad input is rejected rather than degraded", async () => {
  const { home, queue } = await harness();
  const bad: Array<Record<string, unknown>> = [
    { agent: "--rm-rf" },
    { agent: "alpha", permissionMode: "skip" },
    { agent: "alpha", permissionMode: "bypass" },
    { agent: "alpha", unattended: "yes" },
    { agent: "alpha", prompt: "a\0b" },
    { agent: "alpha", prompt: "x".repeat(100_001) },
    { agent: "alpha", priority: 1.5 },
    { agent: "alpha", priority: 10_000 },
    { agent: "alpha", maxAttempts: 0 },
    { agent: "alpha", title: "   " },
    { agent: "alpha", cwd: "relative/path" },
    { agent: "alpha", cwd: path.join(home, "definitely-not-here") },
  ];
  for (const input of bad) {
    await assert.rejects(queue.create(input as never), (err: any) => err.status === 400, JSON.stringify(input));
  }
  // There is no "skip" alias on the one flag with a real blast radius — one literal, loud rejection.
  const opted = await queue.create({ agent: "alpha", prompt: "x", permissionMode: "bypassPermissions" });
  assert.equal(opted.permissionMode, "bypassPermissions");
});

test("the bypass opt-in is passed through to the CLI only when it was asked for", async () => {
  const { cli, queue } = await harness({ concurrency: 2 });
  await queue.create({ agent: "alpha", prompt: "safe" });
  await queue.create({ agent: "alpha", prompt: "risky", permissionMode: "bypassPermissions" });
  await queue.tick();
  assert.deepEqual(
    cli.started.map((s) => s.permissionMode),
    ["ask", "bypassPermissions"],
  );
});

test("a long prompt gets a derived title, and an explicit one wins", async () => {
  const { queue } = await harness();
  const derived = await queue.create({ agent: "alpha", prompt: `${"w".repeat(120)}\nsecond line` });
  assert.equal(derived.title.length, 80);
  assert.ok(derived.title.endsWith("…"));
  const named = await queue.create({ agent: "alpha", prompt: "x", title: "  Deploy staging  " });
  assert.equal(named.title, "Deploy staging");
});

test("transcript is empty for a queued task, structured once it has run, and 404 for a stranger", async () => {
  const { home, cli, queue } = await harness();
  const created = await queue.create({ agent: "alpha", prompt: "x" });
  assert.deepEqual(await queue.transcript(created.id), { messages: [], truncated: false });

  await queue.tick();
  await writeTranscript(home, "run1-session", "Here is the answer.");
  cli.finish("run1");
  await queue.tick();
  assert.deepEqual(await queue.transcript(created.id), {
    messages: [
      { role: "user", text: "go", at: Date.parse("2026-01-01T00:00:00.000Z") },
      { role: "assistant", text: "Here is the answer.", at: Date.parse("2026-01-01T00:01:00.000Z") },
    ],
    truncated: false,
  });
  await assert.rejects(queue.transcript("nope"), (err: any) => err.status === 404);
});

test("the newest task of a schedule wins, even when two land in the same millisecond", async () => {
  // The scheduler's overlap check reads this and nothing else does: "is the task I started last
  // time still going?". Two tasks can be created inside one millisecond, and a sort over equal
  // keys is stable — it would hand back the *older* one, hiding a newer task that is running or
  // blocked. Later wins instead, because tasks are appended in creation order.
  const { queue } = await harness();
  const realNow = Date.now;
  Date.now = () => 1_767_225_600_000;
  let first: string;
  let second: string;
  try {
    first = (await queue.create({ agent: "alpha", prompt: "first", scheduleId: "sched-1" })).id;
    second = (await queue.create({ agent: "alpha", prompt: "second", scheduleId: "sched-1" })).id;
  } finally {
    Date.now = realNow;
  }
  const other = await queue.create({ agent: "alpha", prompt: "other", scheduleId: "sched-2" });

  const latest = await queue.latestForSchedule("sched-1");
  assert.notEqual(first, second);
  assert.equal(latest?.id, second);
  // A schedule that has never fired has no latest, and one schedule never reads another's.
  assert.equal((await queue.latestForSchedule("sched-2"))?.id, other.id);
  assert.equal(await queue.latestForSchedule("sched-3"), undefined);
});
