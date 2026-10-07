import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LOCK_FILE } from "../src/store/lockfile.ts";
import { fakeClaudeBin, tempHome } from "./helpers.ts";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

/** Starts the real bin entry in its own process, and resolves with its URL once it is listening. */
async function startServer(dataDir: string): Promise<{ child: ChildProcess; port: number }> {
  // A stub that reports a supported version, so the preflight neither needs a real claude on PATH
  // nor warns about an untested one — this child's stderr is inherited, so a warning here would
  // land in the suite's own output.
  const claudeBin = await fakeClaudeBin();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CLI, "--port", "0", "--data-dir", dataDir, "--claude-bin", claudeBin, "--no-open"],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  let out = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server never printed its URL; saw: ${out}`)), 30_000);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      out += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("exit", (code) => reject(new Error(`server exited early with ${code}; saw: ${out}`)));
  });
  return { child, port };
}

/** Opens an SSE connection and resolves once the server has sent its first bytes. */
function connectEvents(port: number): Promise<http.ClientRequest> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        assert.equal(res.statusCode, 200);
        res.once("data", () => resolve(req));
        res.resume();
      },
    );
    req.on("error", reject);
  });
}

async function exitWithin(child: ChildProcess, ms: number): Promise<number | null> {
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  try {
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    assert.notEqual(signal, "SIGKILL", `the server was still running ${ms}ms after SIGINT`);
    return code;
  } finally {
    clearTimeout(timer);
  }
}

test("SIGINT brings the server down while an SSE client is connected", async () => {
  // server.close() waits for open connections, and an SSE stream never ends on its own — with the
  // browser open on /api/events that is every ordinary Ctrl-C, so this is the common path.
  const dataDir = path.join(await tempHome(), ".claude-agent-ui");
  const { child, port } = await startServer(dataDir);
  const stream = await connectEvents(port);
  try {
    child.kill("SIGINT");
    assert.equal(await exitWithin(child, 15_000), 0);
    // And the lock went with it, so the next start is not refused by a server that is gone.
    assert.equal(existsSync(path.join(dataDir, LOCK_FILE)), false);
  } finally {
    stream.destroy();
  }
});

test("SIGTERM with no client attached still exits cleanly and releases the lock", async () => {
  const dataDir = path.join(await tempHome(), ".claude-agent-ui");
  const { child } = await startServer(dataDir);
  // Immediately, with nothing in between: the URL is printed only after the signal handlers are
  // armed, so the first instant the test can see it is already too late to catch a bare SIGTERM.
  // Before that ordering existed this killed the process outright — exit code null, lock left on
  // disk — on Node 20, and won the race by luck on newer ones.
  child.kill("SIGTERM");
  assert.equal(await exitWithin(child, 15_000), 0);
  assert.equal(existsSync(path.join(dataDir, LOCK_FILE)), false);
});
