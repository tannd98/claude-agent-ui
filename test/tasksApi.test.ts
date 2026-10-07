import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { type BackgroundSession, ClaudeCli, type StartBackgroundOptions } from "../src/claude/claudeCli.ts";
import type { TaskQueue } from "../src/domain/queue.ts";
import { createApp } from "../src/server.ts";
import { fixtureHome, put } from "./helpers.ts";

/** The same injected fake the queue tests use, pared down to what the routes exercise. */
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
  finish(id: string): void {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, status: "idle", state: "done" });
  }
}

interface Api {
  (path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }>;
}

interface Context {
  api: Api;
  home: string;
  cli: FakeCli;
  queue: TaskQueue;
  agentId: string;
}

async function withApi(fn: (ctx: Context) => Promise<void>): Promise<void> {
  const home = await fixtureHome();
  const cli = new FakeCli();
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
  });
  server.on("request", app);
  // Nothing ticks on its own here: the test drives the loop, so there is no timer to race.
  const queue = app.locals.tasks as TaskQueue;

  const api: Api = async (route, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? {} : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    const agents = await api("/api/agents");
    const alpha = (agents.body as Array<{ id: string; runName: string }>).find((a) => a.runName === "alpha");
    assert.ok(alpha, "the fixture home should expose the alpha agent");
    await fn({ api, home, cli, queue, agentId: alpha.id });
  } finally {
    server.close();
  }
}

test("POST /api/tasks creates a queued task and GET returns the envelope", async () => {
  await withApi(async ({ api, agentId }) => {
    const created = await api("/api/tasks", { method: "POST", body: { agentId, prompt: "ship it" } });
    assert.equal(created.status, 201);
    assert.equal(created.body.state, "queued");
    assert.equal(created.body.title, "ship it");
    assert.equal(created.body.queuePosition, 1);
    assert.equal(created.body.permissionMode, "ask");
    assert.equal(created.body.unattended, true);
    assert.equal(created.body.attachCommand, null);
    assert.equal(created.body.scheduleId, null);
    // Internal scheduling must not leak onto the wire.
    assert.equal("nextAttemptAt" in created.body, false);

    const list = await api("/api/tasks");
    assert.equal(list.status, 200);
    // An envelope, not a bare array: a failed CLI poll has to be able to say so.
    assert.deepEqual(Object.keys(list.body).sort(), ["tasks", "warning"]);
    assert.equal(list.body.tasks.length, 1);
    assert.equal(list.body.warning, null);

    const stats = await api("/api/tasks/stats");
    assert.deepEqual(stats.body, { queued: 1, running: 0, waiting: 0, maxConcurrent: 2 });
  });
});

test("a request body cannot claim a task came from a schedule", async () => {
  await withApi(async ({ api, agentId }) => {
    const created = await api("/api/tasks", { method: "POST", body: { agentId, prompt: "x", scheduleId: "forged" } });
    assert.equal(created.status, 201);
    assert.equal(created.body.scheduleId, null);
  });
});

test("the task lifecycle is visible over HTTP, and the transcript comes back structured", async () => {
  await withApi(async ({ api, cli, queue, home, agentId }) => {
    const created = await api("/api/tasks", { method: "POST", body: { agentId, prompt: "x" } });
    const id = created.body.id as string;

    await queue.tick();
    let list = await api("/api/tasks");
    assert.equal(list.body.tasks[0].state, "running");
    assert.equal(list.body.tasks[0].attachCommand, "claude attach run1");

    // A task that has started but produced nothing yet is an empty transcript, not an error.
    const early = await api(`/api/tasks/${id}/transcript`);
    assert.equal(early.status, 200);
    assert.deepEqual(early.body, { messages: [], truncated: false });

    await put(
      path.join(home, ".claude", "projects", "-work", "run1-session.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Shipped." }] },
      }),
    );
    cli.finish("run1");
    await queue.tick();

    list = await api("/api/tasks");
    assert.equal(list.body.tasks[0].state, "succeeded");
    assert.equal(list.body.tasks[0].result, "Shipped.");

    const transcript = await api(`/api/tasks/${id}/transcript`);
    assert.deepEqual(transcript.body, {
      messages: [{ role: "assistant", text: "Shipped.", at: Date.parse("2026-01-01T00:00:00.000Z") }],
      truncated: false,
    });
  });
});

test("cancel is 200 then 200, and 409 once a task has finished", async () => {
  await withApi(async ({ api, cli, queue, home, agentId }) => {
    const queued = await api("/api/tasks", { method: "POST", body: { agentId, prompt: "drop me" } });
    const dropped = await api(`/api/tasks/${queued.body.id}/cancel`, { method: "POST" });
    assert.equal(dropped.status, 200);
    assert.equal(dropped.body.state, "cancelled");
    // Idempotent, so a double-click is never a red error.
    assert.equal((await api(`/api/tasks/${queued.body.id}/cancel`, { method: "POST" })).status, 200);

    const done = await api("/api/tasks", { method: "POST", body: { agentId, prompt: "finish me" } });
    await queue.tick();
    await put(
      path.join(home, ".claude", "projects", "-work", "run1-session.jsonl"),
      JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "done" }] } }),
    );
    cli.finish("run1");
    await queue.tick();
    const late = await api(`/api/tasks/${done.body.id}/cancel`, { method: "POST" });
    assert.equal(late.status, 409);
    assert.match(late.body.error, /already finished/);
  });
});

test("retry answers 201 with a new id; retrying a live task is 409", async () => {
  await withApi(async ({ api, queue, agentId }) => {
    const created = await api("/api/tasks", { method: "POST", body: { agentId, prompt: "x" } });
    assert.equal((await api(`/api/tasks/${created.body.id}/retry`, { method: "POST" })).status, 409);

    await api(`/api/tasks/${created.body.id}/cancel`, { method: "POST" });
    const retried = await api(`/api/tasks/${created.body.id}/retry`, { method: "POST" });
    assert.equal(retried.status, 201);
    assert.notEqual(retried.body.id, created.body.id);
    assert.equal(retried.body.state, "queued");
    // The clicked row keeps its own history rather than being rewritten.
    const list = await api("/api/tasks");
    assert.equal(list.body.tasks.length, 2);
    await queue.tick();
  });
});

test("PATCH edits a title in any state but refuses priority once a task has started", async () => {
  await withApi(async ({ api, queue, agentId }) => {
    const created = await api("/api/tasks", { method: "POST", body: { agentId, prompt: "x" } });
    const id = created.body.id as string;
    const raised = await api(`/api/tasks/${id}`, { method: "PATCH", body: { priority: 3 } });
    assert.equal(raised.status, 200);
    assert.equal(raised.body.priority, 3);

    await queue.tick();
    const late = await api(`/api/tasks/${id}`, { method: "PATCH", body: { priority: 9 } });
    assert.equal(late.status, 409);
    assert.match(late.body.error, /only be changed while a task is queued/);
    assert.equal((await api(`/api/tasks/${id}`, { method: "PATCH", body: { title: "renamed" } })).status, 200);
  });
});

test("bad bodies are 400 and unknown ids are 404", async () => {
  await withApi(async ({ api, agentId }) => {
    const alias = await api("/api/tasks", { method: "POST", body: { agentId, permissionMode: "skip" } });
    assert.equal(alias.status, 400);
    assert.match(alias.body.error, /"ask" or "bypassPermissions"/);

    assert.equal((await api("/api/tasks", { method: "POST", body: { agentId, priority: 1.5 } })).status, 400);
    assert.equal((await api("/api/tasks", { method: "POST", body: { agentId: "nope" } })).status, 404);
    assert.equal((await api("/api/tasks/nope/cancel", { method: "POST" })).status, 404);
    assert.equal((await api("/api/tasks/nope/retry", { method: "POST" })).status, 404);
    assert.equal((await api("/api/tasks/nope/transcript")).status, 404);
    assert.equal((await api("/api/tasks/nope", { method: "PATCH", body: { title: "x" } })).status, 404);
  });
});

test("the bypass opt-in crosses the wire only under its one literal", async () => {
  await withApi(async ({ api, cli, queue, agentId }) => {
    await api("/api/tasks", {
      method: "POST",
      body: { agentId, prompt: "risky", permissionMode: "bypassPermissions" },
    });
    await queue.tick();
    assert.equal((await api("/api/tasks")).body.tasks[0].permissionMode, "bypassPermissions");
    assert.equal(cli.sessions.size, 1);
  });
});
