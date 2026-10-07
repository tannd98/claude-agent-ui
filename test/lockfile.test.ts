import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.ts";
import { ConfigError } from "../src/config.ts";
import { LOCK_FILE, LockError, acquireLock, isProcessAlive } from "../src/store/lockfile.ts";
import { fakeClaudeBin, tempHome } from "./helpers.ts";

const never = () => false;
const always = () => true;

test("isProcessAlive reads a signal-0 probe: ESRCH is gone, EPERM is running", () => {
  const fail = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(1234, fail("ESRCH") as never), false);
  // Another user's process still owns the directory, even though we may not signal it.
  assert.equal(isProcessAlive(1234, fail("EPERM") as never), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});

test("a second server is refused, and the message names the running PID", async () => {
  const dir = await tempHome();
  const first = await acquireLock(dir, { pid: 4242, isAlive: always });
  await assert.rejects(acquireLock(dir, { pid: 7, isAlive: always }), (err: unknown) => {
    assert.ok(err instanceof LockError);
    assert.match(err.message, /already running for this state directory \(PID 4242\)/);
    assert.match(err.message, /--data-dir/);
    assert.match(err.message, new RegExp(path.join(dir, LOCK_FILE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
  first.release();
});

test("releasing the lock lets the next server start, and releasing twice is harmless", async () => {
  const dir = await tempHome();
  const first = await acquireLock(dir, { pid: 4242, isAlive: always });
  first.release();
  first.release();
  const second = await acquireLock(dir, { pid: 99, isAlive: always });
  assert.equal(second.info.pid, 99);
  second.release();
});

test("a lock left by a crashed server is reclaimed once its PID is gone", async () => {
  const dir = await tempHome();
  const crashed = await acquireLock(dir, { pid: 4242, isAlive: always });
  assert.equal(JSON.parse(await readFile(crashed.file, "utf8")).pid, 4242);
  // Same directory, but nothing is running under 4242 any more.
  const next = await acquireLock(dir, { pid: 99, isAlive: never });
  assert.equal(JSON.parse(await readFile(next.file, "utf8")).pid, 99);
  next.release();
});

test("a truncated or garbage lockfile is treated as a crash artefact, not a running server", async () => {
  for (const content of ["", "{not json", '{"pid":"nope"}', '{"pid":0}']) {
    const dir = await tempHome();
    await writeFile(path.join(dir, LOCK_FILE), content);
    const lock = await acquireLock(dir, { pid: 99, isAlive: always });
    assert.equal(lock.info.pid, 99);
    lock.release();
  }
});

test("release does not delete a lock another server has since taken over", async () => {
  const dir = await tempHome();
  const crashed = await acquireLock(dir, { pid: 4242, isAlive: always });
  const taker = await acquireLock(dir, { pid: 99, isAlive: never });
  // The first owner shutting down late must not hand the directory to a third server.
  crashed.release();
  assert.equal(JSON.parse(await readFile(taker.file, "utf8")).pid, 99);
  await assert.rejects(acquireLock(dir, { pid: 7, isAlive: always }), /PID 99/);
  taker.release();
});

test("the lockfile records the host that wrote it", async () => {
  const dir = await tempHome();
  const lock = await acquireLock(dir, { pid: 4242, isAlive: always });
  assert.equal(JSON.parse(await readFile(lock.file, "utf8")).hostname, os.hostname());
  lock.release();
});

test("a lock held by another machine is refused, alive or not, because we cannot tell", async () => {
  // The default ~/.claude-agent-ui on a synced or networked home is exactly this case: pid 4242
  // over there is some unrelated process over here, so neither answer from a signal-0 probe means
  // anything. Both are refused rather than guessed at.
  for (const isAlive of [always, never]) {
    const dir = await tempHome();
    await writeFile(
      path.join(dir, LOCK_FILE),
      JSON.stringify({ pid: 4242, startedAt: Date.now(), hostname: "other-laptop" }),
    );
    await assert.rejects(acquireLock(dir, { pid: 99, isAlive, hostname: "this-laptop" }), (err: unknown) => {
      assert.ok(err instanceof LockError);
      assert.match(err.message, /locked by claude-agent-ui on another machine \("other-laptop", PID 4242\)/);
      assert.match(err.message, /cannot tell from here whether that server is still running/);
      assert.match(err.message, /--data-dir/);
      return true;
    });
    // And it is left exactly as we found it: refusing must never half-take the lock.
    assert.equal(JSON.parse(await readFile(path.join(dir, LOCK_FILE), "utf8")).hostname, "other-laptop");
  }
});

test("a lockfile from an older build, with no hostname, still reclaims on a dead PID", async () => {
  const dir = await tempHome();
  await writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 4242, startedAt: Date.now() }));
  const lock = await acquireLock(dir, { pid: 99, isAlive: never, hostname: "this-laptop" });
  assert.equal(lock.info.pid, 99);
  lock.release();
});

test("release leaves a lockfile it cannot read, rather than throwing out of the exit handler", async () => {
  const dir = await tempHome();
  const lock = await acquireLock(dir, { pid: 4242, isAlive: always });
  // Stands in for an EACCES or EIO at shutdown: readFileSync on a directory fails with EISDIR.
  await rm(lock.file);
  await mkdir(lock.file);
  assert.doesNotThrow(() => lock.release());
});

/** Starts a server through main() the way the bin entry does, minus the browser. */
function start(dataDir: string, claudeBin: string) {
  return main(["--port", "0", "--data-dir", dataDir, "--claude-bin", claudeBin, "--no-open"]);
}

test("two servers on one state directory: the second exits with the first one's PID", async () => {
  const claudeBin = await fakeClaudeBin();
  const dataDir = path.join(await tempHome(), ".claude-agent-ui");
  const server = await start(dataDir, claudeBin);
  assert.ok(server);
  try {
    await assert.rejects(start(dataDir, claudeBin), (err: unknown) => {
      assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${String(err)}`);
      assert.match(err.message, new RegExp(`PID ${process.pid}\\b`));
      assert.doesNotMatch(err.message, /at .*:\d+:\d+/, "the message must not be a stack trace");
      return true;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  // Once the first server is down the directory is free again.
  const third = await start(dataDir, claudeBin);
  assert.ok(third);
  await new Promise((resolve) => third.close(resolve));
});
