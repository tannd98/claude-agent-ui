#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import { ClaudeCli, TESTED_CLI_MAJOR, execRunner, parseCliVersion } from "./claude/claudeCli.ts";
import { ConfigError, USAGE, loadConfig, parseArgs } from "./config.ts";
import type { TaskQueue } from "./domain/queue.ts";
import type { Scheduler } from "./domain/schedules.ts";
import { HOST, createApp } from "./server.ts";
import { sweepTempFiles } from "./store/jsonStore.ts";
import { type Lock, LockError, acquireLock } from "./store/lockfile.ts";

const MIN_NODE_MAJOR = 20;

/** How long a shutdown waits for connections to drain before destroying what is left. */
export const SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * Brings the server down without waiting on connections that never end.
 *
 * `server.close()` stops accepting new connections and then waits for the open ones, and an SSE
 * stream is open by design — with the UI in a browser, that is every ordinary shutdown. So end the
 * streams first, which lets each client see a clean end rather than a destroyed socket, and keep a
 * timeout as the backstop for anything else still holding a socket.
 */
export function shutdown(server: Server, closeStreams: () => void, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  closeStreams();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, timeoutMs);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    // Idle keep-alive sockets hold close() open too, and nothing else is going to retire them.
    server.closeIdleConnections();
  });
}

export function readVersion(): string {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    return String(JSON.parse(readFileSync(file, "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/** Returns an actionable sentence when the running Node is too old, else null. */
export function checkNodeVersion(version: string = process.version, min = MIN_NODE_MAJOR): string | null {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  if (!Number.isFinite(major)) return null;
  if (major >= min) return null;
  return (
    `claude-agent-ui needs Node ${min} or newer, but this is Node ${version}.\n` +
    `Install a newer Node (for example: nvm install ${min}) and run it again.`
  );
}

export interface ClaudePreflight {
  /** An actionable sentence when the binary cannot be run at all. Fatal: nothing would work. */
  problem: string | null;
  /** An actionable sentence when the CLI is a major version we have not tested. Not fatal. */
  warning: string | null;
}

/**
 * Returns the warning for a CLI major version this release was not built against, else null.
 *
 * Only the major, and only when we could read one: a minor bump is where the CLI adds things, and
 * warning on every one of those would train people to ignore the line that matters.
 */
export function checkClaudeCliVersion(output: string, tested = TESTED_CLI_MAJOR): string | null {
  const version = parseCliVersion(output);
  if (!version) return null;
  const major = Number(version.split(".")[0]);
  if (major === tested) return null;
  const advice =
    major > tested
      ? `Check for a newer claude-agent-ui (npm view claude-agent-ui version).`
      : `Upgrade the CLI: npm i -g @anthropic-ai/claude-code`;
  return (
    `Warning: Claude Code CLI ${version} is a major version claude-agent-ui ${readVersion()} has not been tested against (it expects ${tested}.x).\n` +
    `Starting anyway. If runs fail to start or sessions show the wrong state, that is the first thing to suspect.\n` +
    advice
  );
}

/**
 * Runs the claude binary once and reports both whether it works and whether it is a version we
 * know. One spawn, because this is on the path between the user typing the command and the URL
 * appearing, and a second `--version` would buy nothing.
 */
export async function checkClaudeBinary(bin: string): Promise<ClaudePreflight> {
  const result = await new Promise<string | null>((resolve) => {
    execFile(bin, ["--version"], { timeout: 15_000 }, (err, stdout, stderr) =>
      resolve(err ? null : `${stdout}\n${stderr}`),
    );
  });
  if (result === null) {
    return {
      problem:
        `Could not run the Claude Code CLI as "${bin}".\n` +
        `Install it (npm i -g @anthropic-ai/claude-code) or point at it with --claude-bin <path>\n` +
        `or CLAUDE_AGENT_UI_CLAUDE_BIN=<path>.`,
      warning: null,
    };
  }
  return { problem: null, warning: checkClaudeCliVersion(result) };
}

/**
 * Best effort only: failing to open a browser must never take the server down, and the URL is
 * printed either way. `open` rather than our own `xdg-open`/`start` because the cases it gets
 * right — WSL, a container with no display, Windows quoting — are exactly the ones a hand-rolled
 * launcher gets wrong, and it spawns with an argv array like everything else here.
 */
function openBrowser(url: string): void {
  void open(url).catch(() => {});
}

/** Turns a listen() failure into a sentence the user can act on. */
function describeListenError(err: NodeJS.ErrnoException, port: number): string {
  if (err.code === "EADDRINUSE") {
    return `Port ${port} is already in use. Start it on another port: claude-agent-ui --port ${port + 1}`;
  }
  if (err.code === "EACCES") {
    return `Port ${port} needs elevated privileges. Pick a port above 1023: claude-agent-ui --port 3000`;
  }
  return err.message;
}

/** Starts the server and resolves once it is listening; returns undefined for --help and --version. */
export async function main(argv = process.argv.slice(2)): Promise<Server | undefined> {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(USAGE);
    return undefined;
  }
  if (flags.version) {
    process.stdout.write(`${readVersion()}\n`);
    return undefined;
  }

  const nodeProblem = checkNodeVersion();
  if (nodeProblem) throw new ConfigError(nodeProblem);

  const config = loadConfig({ argv });
  const claude = await checkClaudeBinary(config.claudeBin);
  if (claude.problem) throw new ConfigError(claude.problem);
  // A warning, not a refusal: an untested CLI is usually fine, and refusing to start would strand
  // someone on the day the CLI bumps. It goes to stderr so it survives `claude-agent-ui > url.txt`.
  if (claude.warning) process.stderr.write(`${claude.warning}\n`);

  // Taken before anything reads or writes the state directory, so two servers never interleave
  // their JSON writes. LockError already reads as a sentence, so it passes through as one.
  let lock: Lock;
  try {
    lock = await acquireLock(config.dataDir);
  } catch (err) {
    throw err instanceof LockError ? new ConfigError(err.message) : err;
  }
  // Safe only while we hold the lock: any temp file still here was orphaned by an earlier crash.
  await sweepTempFiles(config.dataDir).catch(() => 0);

  // With --port 0 the OS assigns the port at listen(), so the guard reads it back rather than
  // freezing the requested 0 — otherwise it would reject the very URL we are about to print.
  let boundPort = config.port;
  const app = createApp({
    home: os.homedir(),
    cli: new ClaudeCli(execRunner(config.claudeBin)),
    port: () => boundPort,
    starterPrompt: config.starterPrompt,
    defaultCwd: config.defaultCwd,
    permissionMode: config.permissionMode,
    dataDir: config.dataDir,
    historyLimit: config.historyLimit,
    concurrency: config.concurrency,
    maxAttempts: config.maxAttempts,
  });

  const server = app.listen(config.port, HOST);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (err) {
    // The lock outlives a failed listen() otherwise, and the next run would refuse to start.
    lock.release();
    throw new ConfigError(describeListenError(err as NodeJS.ErrnoException, config.port));
  }
  // Covers every way the server goes down: close() from a test, a signal, or an unhandled throw
  // that unwinds to exit. release() is idempotent, so overlapping paths are harmless.
  const tasks = app.locals.tasks as TaskQueue;
  const schedules = app.locals.schedules as Scheduler;
  server.once("close", () => {
    schedules.stop();
    tasks.stop();
    lock.release();
  });
  process.once("exit", () => lock.release());

  // Armed here, before start() and before the URL is printed, because the default disposition of
  // SIGTERM is to terminate: a signal arriving in the gap used to kill the process outright,
  // skipping the exit handler above and leaving the lockfile behind to confuse the next start.
  // The gap is small but real — `npx claude-agent-ui` then an immediate Ctrl-C hits it, and so
  // did the SIGTERM shutdown test on Node 20. Stopping early is safe: an unstarted queue has no
  // timer to clear and an unstarted scheduler has no jobs to stop.
  const closeStreams = app.locals.closeStreams as () => void;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(server, closeStreams).then(() => process.exit(0));
    });
  }

  // Only once the port is ours: reconciles tasks stranded `running` by an earlier crash, then
  // starts the worker loop. Background sessions outlive us, so a restart adopts them.
  await tasks.start();
  // After the queue, because a schedule firing before there is anything to drain it would leave
  // a task sitting queued. Nothing missed while we were down is replayed — see schedules.ts.
  await schedules.start();

  const address = server.address();
  boundPort = typeof address === "object" && address ? address.port : config.port;
  const url = `http://${HOST}:${boundPort}`;
  process.stdout.write(`Claude Agent UI: ${url}\n`);
  if (flags.open ?? true) openBrowser(url);

  server.on("error", (err: Error) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });

  return server;
}

/** True when this file is the program being run — npm's bin shim is a symlink, so resolve it. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof ConfigError ? err.message : (err?.stack ?? String(err))}\n`);
    process.exit(1);
  });
}
