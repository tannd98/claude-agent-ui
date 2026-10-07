import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  type BackgroundSession,
  CliError,
  ClaudeCli,
  type StartBackgroundOptions,
  sessionWait,
} from "../src/claude/claudeCli.ts";
import { MAX_PROMPT_LENGTH, RunStore, mapStatus } from "../src/domain/runs.ts";
import { type BusEvent, EventBus } from "../src/events.ts";
import { put, tempHome } from "./helpers.ts";

test("mapStatus: busy→running, idle→finished, stopped, missing", () => {
  const base = { id: "a", sessionId: "s", cwd: "/", kind: "background" };
  assert.equal(mapStatus({ ...base, pid: 1, status: "busy", state: "working" }), "running");
  assert.equal(mapStatus({ ...base, pid: 1, status: "idle", state: "blocked" }), "finished");
  assert.equal(mapStatus({ ...base, pid: 1, status: "idle", state: "done" }), "finished");
  assert.equal(mapStatus({ ...base, state: "stopped" }), "stopped");
  assert.equal(mapStatus(undefined), "missing");
});

test("mapStatus: a session parked on a prompt is waiting, not running", () => {
  const base = { id: "a", sessionId: "s", cwd: "/", kind: "background" };
  // The CLI pairs status:"waiting" with state:"blocked"; without the waiting branch this
  // fell through to "running" and a stuck run was indistinguishable from a busy one.
  assert.equal(
    mapStatus({ ...base, pid: 1, status: "waiting", state: "blocked", waitingFor: "permission prompt" }),
    "waiting",
  );
  assert.equal(
    mapStatus({ ...base, pid: 1, status: "waiting", state: "blocked", waitingFor: "input needed" }),
    "waiting",
  );
});

test("mapStatus: a terminal state outranks the liveness fields", () => {
  const base = { id: "a", sessionId: "s", cwd: "/", kind: "background" };
  // state:"failed" used to be dropped: with the job record still around it read as
  // "finished" — a failed run reported as a successful one — and as "stopped" once reaped.
  assert.equal(mapStatus({ ...base, pid: 1, status: "idle", state: "failed" }), "failed");
  assert.equal(mapStatus({ ...base, state: "failed" }), "failed");
  // Reaped but the CLI told us it completed: "finished", not the "no pid" guess of "stopped".
  assert.equal(mapStatus({ ...base, state: "done" }), "finished");
  // Reaped with nothing reported at all: we still cannot say more than "stopped".
  assert.equal(mapStatus({ ...base }), "stopped");
});

test("sessionWait: the permission prompt is named; every other wait is soft", () => {
  const base = { id: "a", sessionId: "s", cwd: "/", kind: "background", pid: 1, state: "blocked" };
  assert.deepEqual(sessionWait({ ...base, status: "waiting", waitingFor: "permission prompt" }), {
    reason: "permission",
    detail: "permission prompt",
  });
  assert.deepEqual(sessionWait({ ...base, status: "waiting", waitingFor: "sandbox request" }), {
    reason: "other",
    detail: "sandbox request",
  });
  // A wait with no reason reported is still a wait; we do not invent a detail for it.
  assert.deepEqual(sessionWait({ ...base, status: "waiting" }), { reason: "other", detail: "" });
  assert.equal(sessionWait({ ...base, status: "busy", state: "working" }), null);
});

/** Stands in for the real binary so the suite never needs `claude` installed. */
class FakeCli extends ClaudeCli {
  sessions: BackgroundSession[] = [];
  startError: string | null = null;
  removeError: string | null = null;
  listError: string | null = null;
  calls: string[] = [];
  started: StartBackgroundOptions[] = [];
  private nextId = 0;
  constructor() {
    super(async () => ({ stdout: "", stderr: "" }));
  }
  async startBackground(opts: StartBackgroundOptions) {
    this.started.push(opts);
    this.calls.push(`bg ${opts.agent} ${opts.cwd} ${opts.prompt}${opts.unattended ? " [unattended]" : ""}`);
    if (this.startError) throw new CliError(this.startError, this.startError);
    const id = this.nextId === 0 ? "abcd1234" : `abcd${String(1234 + this.nextId)}`;
    this.nextId++;
    this.sessions.push({ id, sessionId: `${id}-full`, pid: 9, cwd: opts.cwd, kind: "background", status: "busy" });
    return id;
  }
  async listSessions() {
    if (this.listError) throw new CliError(this.listError, this.listError);
    return this.sessions;
  }
  async stop(id: string) {
    this.calls.push(`stop ${id}`);
  }
  async remove(id: string) {
    this.calls.push(`rm ${id}`);
    if (this.removeError) throw new CliError(this.removeError, this.removeError);
  }
}

async function setup(opts: { historyLimit?: number; bus?: EventBus } = {}) {
  const home = await tempHome();
  const cli = new FakeCli();
  return {
    home,
    cli,
    store: new RunStore(home, cli, "Start your task.", { historyLimit: opts.historyLimit, bus: opts.bus }),
  };
}

const runsFile = (home: string) => path.join(home, ".claude-agent-ui", "runs.json");

test("start persists the run with its session id", async () => {
  const { home, cli, store } = await setup();
  const run = await store.start("omc:executor", home);
  assert.equal(run.runId, "abcd1234");
  assert.equal(run.sessionId, "abcd1234-full");
  assert.deepEqual(cli.calls, [`bg omc:executor ${home} Start your task.`]);
  const saved = JSON.parse(await readFile(runsFile(home), "utf8"));
  assert.equal(saved[0].runId, "abcd1234");
});

test("start passes a custom prompt through unchanged", async () => {
  const { home, cli, store } = await setup();
  await store.start("omc:executor", home, { prompt: "  Fix bug X\n" });
  assert.deepEqual(cli.calls, [`bg omc:executor ${home}   Fix bug X\n`]);
});

test("start falls back to the starter prompt for a missing or blank prompt", async () => {
  const { home, cli, store } = await setup();
  for (const prompt of [undefined, null, "", "   \n"]) await store.start("a", home, { prompt });
  assert.deepEqual(cli.calls, Array(4).fill(`bg a ${home} Start your task.`));
});

test("start passes unattended through and defaults it to off", async () => {
  const { home, cli, store } = await setup();
  await store.start("a", home, { prompt: "go", unattended: true });
  await store.start("a", home, { prompt: "go", unattended: null });
  assert.deepEqual(cli.calls, [`bg a ${home} go [unattended]`, `bg a ${home} go`]);
  await assert.rejects(store.start("a", home, { prompt: "go", unattended: "yes" }), (err: any) => err.status === 400);
});

test("permissionMode defaults to ask, is recorded, and bypass is an explicit opt-in", async () => {
  const { home, cli, store } = await setup();
  const asked = await store.start("a", home);
  assert.equal(asked.permissionMode, "ask");
  assert.equal(cli.started[0].permissionMode, "ask");

  const bypassed = await store.start("a", home, { permissionMode: "bypassPermissions" });
  assert.equal(bypassed.permissionMode, "bypassPermissions");
  assert.equal(cli.started[1].permissionMode, "bypassPermissions");

  const saved = JSON.parse(await readFile(runsFile(home), "utf8"));
  assert.deepEqual(
    saved.map((r: any) => r.permissionMode),
    ["bypassPermissions", "ask"],
  );
});

test("start rejects an unknown permissionMode before calling the CLI", async () => {
  const { home, cli, store } = await setup();
  for (const mode of ["yolo", "acceptEdits", 1, true]) {
    await assert.rejects(store.start("a", home, { permissionMode: mode }), (err: any) => err.status === 400);
  }
  assert.deepEqual(cli.calls, []);
});

test("start rejects a non-string or over-long prompt before calling the CLI", async () => {
  const { home, cli, store } = await setup();
  for (const prompt of [42, { text: "x" }, ["x"], "x".repeat(MAX_PROMPT_LENGTH + 1), "a\0b"]) {
    await assert.rejects(store.start("a", home, { prompt }), (err: any) => err.status === 400);
  }
  assert.deepEqual(cli.calls, []);
});

test("start validates the working directory", async () => {
  const { store } = await setup();
  await assert.rejects(store.start("a", "relative/dir"), /absolute/);
  await assert.rejects(store.start("a", "/definitely/not/here"), /does not exist/);
});

test("trust error gets a plain-language hint", async () => {
  const { home, cli, store } = await setup();
  cli.startError = "Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.";
  await assert.rejects(
    store.start("a", home),
    (err: any) => err.status === 502 && /accept the trust prompt once/.test(err.message),
  );
});

test("list: running has no final text; finished reads it from the transcript", async () => {
  const { home, cli, store } = await setup();
  await store.start("a", home);
  let [view] = (await store.list()).runs;
  assert.equal(view.status, "running");
  assert.equal(view.finalText, null);
  assert.equal(view.attachCommand, "claude attach abcd1234");

  await put(
    path.join(home, ".claude", "projects", "-x", "abcd1234-full.jsonl"),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-30T04:24:33.613Z",
      message: { id: "m", content: [{ type: "text", text: "All done." }] },
    }),
  );
  cli.sessions[0].status = "idle";
  [view] = (await store.list()).runs;
  assert.equal(view.status, "finished");
  assert.equal(view.finalText, "All done.");
  assert.equal(view.endedAt, Date.parse("2026-09-30T04:24:33.613Z"));

  cli.sessions = [];
  [view] = (await store.list()).runs;
  assert.equal(view.status, "missing");
});

test("list: a waiting run carries its reason and is never given a final message", async () => {
  const { home, cli, store } = await setup();
  await store.start("a", home);
  // The transcript already has text in it — the last thing said before the prompt opened.
  await put(
    path.join(home, ".claude", "projects", "-x", "abcd1234-full.jsonl"),
    JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "Let me edit that." }] } }),
  );
  Object.assign(cli.sessions[0], { status: "waiting", state: "blocked", waitingFor: "permission prompt" });

  const [view] = (await store.list()).runs;
  assert.equal(view.status, "waiting");
  assert.deepEqual(view.waiting, { reason: "permission", detail: "permission prompt" });
  // Reporting that as the result would announce a parked run as a finished one.
  assert.equal(view.finalText, null);
  // The approval path for 0.1.0: answer it in a terminal.
  assert.equal(view.attachCommand, "claude attach abcd1234");

  cli.sessions[0].status = "idle";
  cli.sessions[0].state = "done";
  const [done] = (await store.list()).runs;
  assert.equal(done.status, "finished");
  assert.equal(done.waiting, null);
  assert.equal(done.finalText, "Let me edit that.");
});

test("the final-message cache does not outlive the runs it was built for", async () => {
  const { home, cli, store } = await setup();
  await store.start("a", home);
  await put(
    path.join(home, ".claude", "projects", "-x", "abcd1234-full.jsonl"),
    JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "All done." }] } }),
  );
  cli.sessions[0].status = "idle";
  assert.equal((await store.list()).runs[0].finalText, "All done.");
  assert.equal(store.cachedFinalMessages, 1);

  await store.remove("abcd1234");
  await store.list();
  assert.equal(store.cachedFinalMessages, 0);
});

test("remove forgets the run even when the session is already gone", async () => {
  const { home, cli, store } = await setup();
  await store.start("a", home);
  cli.removeError = "some future wording";
  cli.sessions = [];
  await store.remove("abcd1234");
  assert.deepEqual((await store.list()).runs, []);
  await assert.rejects(store.remove("abcd1234"), /not found/);
});

test("stopFinished stops only idle runs", async () => {
  const { home, cli, store } = await setup();
  await store.start("a", home);
  assert.deepEqual(await store.stopFinished(), []);
  cli.sessions[0].status = "idle";
  assert.deepEqual(await store.stopFinished(), ["abcd1234"]);
  assert.ok(cli.calls.includes("stop abcd1234"));
});

test("start rejects option-like agent names and expands ~ in cwd", async () => {
  const { home, cli, store } = await setup();
  await assert.rejects(store.start("--foo", home), /invalid agent name/);
  const run = await store.start("omc:executor", "~");
  assert.equal(run.cwd, home);
  assert.deepEqual(cli.calls, [`bg omc:executor ${home} Start your task.`]);
});

test("list survives a failing claude agents call", async () => {
  const { home, cli, store } = await setup();
  await store.start("a", home);
  cli.listError = "timeout";
  const { runs, warning } = await store.list();
  assert.equal(runs[0].status, "unknown");
  assert.match(warning!, /timeout/);
});

test("remove keeps the run when the session still exists and rm fails", async () => {
  const { home, cli, store } = await setup();
  await store.start("a", home);
  cli.removeError = "boom";
  await assert.rejects(store.remove("abcd1234"), /claude rm failed/);
  assert.equal((await store.list()).runs.length, 1);
});

test("a corrupt runs.json is an error, not silently replaced", async () => {
  const { home, store } = await setup();
  await put(runsFile(home), "{not json");
  await assert.rejects(store.list());
  assert.equal(await readFile(runsFile(home), "utf8"), "{not json");
});

test("history is capped: the oldest runs fall off instead of growing forever", async () => {
  const { home, store } = await setup({ historyLimit: 3 });
  for (let i = 0; i < 5; i++) await store.start("a", home);
  const saved = JSON.parse(await readFile(runsFile(home), "utf8"));
  assert.equal(saved.length, 3);
  // unshift() puts the newest first, so the three kept records are the three most recent.
  assert.deepEqual(
    saved.map((r: any) => r.runId),
    ["abcd1238", "abcd1237", "abcd1236"],
  );
});

test("a run start, stop and removal each announce themselves on the bus", async () => {
  const bus = new EventBus();
  const seen: BusEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  const { home, store } = await setup({ bus });

  const run = await store.start("a", home);
  await store.stop(run.runId);
  await store.remove(run.runId);

  assert.deepEqual(
    seen.map((e) => e.type),
    ["run:started", "run:stopped", "run:removed"],
  );
  // The payload is an identifier, not a copy of the record: clients re-read /api/runs.
  assert.deepEqual(seen[0].data, { runId: run.runId });
});

test("a failed start announces nothing", async () => {
  const bus = new EventBus();
  const { home, cli, store } = await setup({ bus });
  cli.startError = "boom";
  await assert.rejects(store.start("a", home));
  assert.equal(bus.lastEventId, 0);
});
