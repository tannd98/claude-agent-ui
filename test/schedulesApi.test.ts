import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { type BackgroundSession, ClaudeCli, type StartBackgroundOptions } from "../src/claude/claudeCli.ts";
import type { TaskQueue } from "../src/domain/queue.ts";
import type { Scheduler } from "../src/domain/schedules.ts";
import { type BusEvent, EventBus, SCHEDULE_EVENTS } from "../src/events.ts";
import { createApp } from "../src/server.ts";
import { fixtureHome } from "./helpers.ts";

/** The same injected fake the queue tests use, pared down to what these routes exercise. */
class FakeCli extends ClaudeCli {
  sessions = new Map<string, BackgroundSession>();
  private next = 1;
  constructor() {
    super(async () => ({ stdout: "", stderr: "" }));
  }
  async startBackground(opts: StartBackgroundOptions): Promise<string> {
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
  async stop(): Promise<void> {}
}

interface Api {
  (path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }>;
}

interface Context {
  api: Api;
  home: string;
  queue: TaskQueue;
  scheduler: Scheduler;
  events: BusEvent[];
}

async function withApi(fn: (ctx: Context) => Promise<void>): Promise<void> {
  const home = await fixtureHome();
  const cli = new FakeCli();
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const app = createApp({
    home,
    cli,
    port,
    starterPrompt: "go",
    defaultCwd: home,
    dataDir: path.join(home, ".ui"),
    bus,
  });
  server.on("request", app);
  // Neither the cron clock nor the worker loop is started here: the test drives both by hand.
  const queue = app.locals.tasks as TaskQueue;
  const scheduler = app.locals.schedules as Scheduler;

  const api: Api = async (route, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? {} : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    await fn({ api, home, queue, scheduler, events });
  } finally {
    scheduler.stop();
    queue.stop();
    server.close();
  }
}

const body = (home: string, extra: Record<string, unknown> = {}) => ({
  name: "Nightly sweep",
  cron: "0 9 * * 1-5",
  timezone: "Asia/Ho_Chi_Minh",
  task: { agent: "alpha", cwd: home, prompt: "sweep the repo" },
  ...extra,
});

test("POST /api/schedules creates one and GET returns the envelope", async () => {
  await withApi(async ({ api, home }) => {
    const created = await api("/api/schedules", { method: "POST", body: body(home) });
    assert.equal(created.status, 201);
    const schedule = created.body.schedule;
    assert.equal(schedule.name, "Nightly sweep");
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.overlapPolicy, "skip");
    assert.equal(schedule.timezone, "Asia/Ho_Chi_Minh");
    assert.equal(schedule.task.permissionMode, "ask");
    assert.equal(schedule.task.unattended, true);
    assert.equal(schedule.task.maxAttempts, 1);
    assert.equal(schedule.lastFiredAt, null);
    assert.equal(schedule.lastSkipReason, null);
    assert.ok(typeof schedule.nextFireAt === "number", "the row needs a next fire to show");

    const list = await api("/api/schedules");
    assert.equal(list.status, 200);
    // An envelope, so the response has somewhere to grow without breaking a client.
    assert.deepEqual(Object.keys(list.body), ["schedules"]);
    assert.equal(list.body.schedules.length, 1);
    assert.deepEqual(list.body.schedules[0], schedule);
  });
});

test("PUT /api/schedules/:id toggles enabled and keeps the rest", async () => {
  await withApi(async ({ api, home }) => {
    const { body: created } = await api("/api/schedules", { method: "POST", body: body(home) });
    const off = await api(`/api/schedules/${created.schedule.id}`, { method: "PUT", body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.schedule.enabled, false);
    assert.equal(off.body.schedule.cron, "0 9 * * 1-5");
    // A disabled schedule has no next fire, so the row cannot promise one.
    assert.equal(off.body.schedule.nextFireAt, null);

    const on = await api(`/api/schedules/${created.schedule.id}`, { method: "PUT", body: { enabled: true } });
    assert.ok(typeof on.body.schedule.nextFireAt === "number");
  });
});

test("DELETE /api/schedules/:id removes it", async () => {
  await withApi(async ({ api, home }) => {
    const { body: created } = await api("/api/schedules", { method: "POST", body: body(home) });
    const gone = await api(`/api/schedules/${created.schedule.id}`, { method: "DELETE" });
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body, { ok: true });
    assert.deepEqual((await api("/api/schedules")).body.schedules, []);
    assert.equal((await api(`/api/schedules/${created.schedule.id}`, { method: "DELETE" })).status, 404);
  });
});

test("POST /api/schedules/:id/run-now enqueues a task, then answers 200 with the skip reason", async () => {
  await withApi(async ({ api, home, queue }) => {
    const { body: created } = await api("/api/schedules", { method: "POST", body: body(home) });
    const id = created.schedule.id;

    const first = await api(`/api/schedules/${id}/run-now`, { method: "POST" });
    assert.equal(first.status, 200);
    assert.equal(first.body.fired, true);
    assert.ok(first.body.taskId);

    const tasks = (await api("/api/tasks")).body.tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, first.body.taskId);
    assert.equal(tasks[0].scheduleId, id);
    assert.equal(tasks[0].state, "queued");

    // A suppressed fire is the route working, not an error: 200, with the reason to show.
    const second = await api(`/api/schedules/${id}/run-now`, { method: "POST" });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { fired: false, reason: "previous_task_queued" });
    assert.equal((await api("/api/tasks")).body.tasks.length, 1);

    // The schedule row shows both halves of that story.
    const row = (await api("/api/schedules")).body.schedules[0];
    assert.equal(row.lastTaskId, first.body.taskId);
    assert.equal(row.lastTrigger, "manual");
    assert.equal(row.lastSkipReason, "previous_task_queued");
    assert.ok(row.lastSkippedAt > 0);

    // And the task it enqueued drains through the queue like any other.
    await queue.tick();
    assert.equal((await api("/api/tasks")).body.tasks[0].state, "running");
  });
});

test("a bad cron, timezone or task is a 400 and stores nothing", async () => {
  await withApi(async ({ api, home }) => {
    for (const [patch, message] of [
      [{ cron: "every so often" }, /invalid cron expression/],
      [{ timezone: "Mars/Phobos" }, /unknown timezone/],
      [{ name: "" }, /name must not be empty/],
      [{ overlapPolicy: "sometimes" }, /overlapPolicy/],
      [{ task: { agent: "alpha", cwd: "/no/such/place", prompt: "x" } }, /does not exist/],
    ] as const) {
      const res = await api("/api/schedules", { method: "POST", body: body(home, patch) });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(patch)}`);
      assert.match(res.body.error, message);
    }
    assert.deepEqual((await api("/api/schedules")).body.schedules, []);
  });
});

test("an unknown schedule id is a 404 on every route that takes one", async () => {
  await withApi(async ({ api }) => {
    assert.equal((await api("/api/schedules/nope", { method: "PUT", body: { enabled: false } })).status, 404);
    assert.equal((await api("/api/schedules/nope", { method: "DELETE" })).status, 404);
    assert.equal((await api("/api/schedules/nope/run-now", { method: "POST" })).status, 404);
  });
});

test("the schedule routes emit onto the same bus the SSE stream serves", async () => {
  await withApi(async ({ api, home, events }) => {
    const { body: created } = await api("/api/schedules", { method: "POST", body: body(home) });
    const id = created.schedule.id;
    await api(`/api/schedules/${id}`, { method: "PUT", body: { name: "Renamed" } });
    await api(`/api/schedules/${id}/run-now`, { method: "POST" });
    await api(`/api/schedules/${id}/run-now`, { method: "POST" });
    await api(`/api/schedules/${id}`, { method: "DELETE" });
    assert.deepEqual(
      events.filter((e) => e.type.startsWith("schedule:")).map((e) => e.type),
      [
        SCHEDULE_EVENTS.created,
        SCHEDULE_EVENTS.updated,
        SCHEDULE_EVENTS.fired,
        SCHEDULE_EVENTS.skipped,
        SCHEDULE_EVENTS.removed,
      ],
    );
  });
});
