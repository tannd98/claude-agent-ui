import { readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Name of the lockfile inside the state directory. */
export const LOCK_FILE = "server.lock";

export class LockError extends Error {}

export interface LockInfo {
  pid: number;
  /** ms since epoch, only used to make the message friendlier. */
  startedAt: number;
  /**
   * The host that wrote the lock. A pid only means something on the machine that issued it, so a
   * state directory on a synced or networked volume needs this to know whether the liveness probe
   * below is answering about the right process at all.
   */
  hostname: string;
}

export interface Lock {
  readonly file: string;
  readonly info: LockInfo;
  /**
   * Removes the lockfile if it is still ours. Safe to call more than once.
   *
   * Synchronous on purpose: it has to run on the way out of the process — from a signal handler or
   * an `exit` listener — where there is no chance to await anything.
   */
  release(): void;
}

/**
 * True when a process with this pid exists. Signal 0 performs the permission and existence checks
 * without delivering anything; EPERM means it exists but belongs to someone else, which still
 * counts as running.
 */
export function isProcessAlive(pid: number, kill = process.kill.bind(process)): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLock(raw: string, thisHost: string): LockInfo | null {
  try {
    const data = JSON.parse(raw) as Partial<LockInfo>;
    if (!Number.isInteger(data.pid) || (data.pid as number) <= 0) return null;
    // A lockfile from an older build has no hostname. Reading it as ours keeps the stale-pid
    // reclaim working across an upgrade, which is the only way that file can have got here.
    const hostname = typeof data.hostname === "string" && data.hostname ? data.hostname : thisHost;
    return { pid: data.pid as number, startedAt: Number(data.startedAt) || 0, hostname };
  } catch {
    return null;
  }
}

function heldMessage(info: LockInfo, dataDir: string): string {
  return (
    `claude-agent-ui is already running for this state directory (PID ${info.pid}).\n` +
    `Stop that server first, or run this one against another directory: ` +
    `claude-agent-ui --data-dir <path>\n` +
    `If you are sure PID ${info.pid} is gone, delete ${path.join(dataDir, LOCK_FILE)} and try again.`
  );
}

function foreignHostMessage(info: LockInfo, dataDir: string, thisHost: string): string {
  return (
    `This state directory is locked by claude-agent-ui on another machine ` +
    `("${info.hostname}", PID ${info.pid}); this one is "${thisHost}".\n` +
    `We cannot tell from here whether that server is still running, so we will not take the lock ` +
    `off it — two servers sharing one directory would overwrite each other's state.\n` +
    `Stop it on "${info.hostname}", or run this one against a local directory: ` +
    `claude-agent-ui --data-dir <path>\n` +
    `If "${info.hostname}" is gone for good, delete ${path.join(dataDir, LOCK_FILE)} and try again.`
  );
}

export interface AcquireLockOptions {
  pid?: number;
  /** Test seam for process liveness; defaults to a signal-0 probe. */
  isAlive?: (pid: number) => boolean;
  /** Test seam for the host identity; defaults to {@link os.hostname}. */
  hostname?: string;
}

/**
 * Takes the exclusive lock on a state directory, so two servers never write the same JSON files.
 *
 * A lockfile left behind by a crashed server is reclaimed once its pid is gone — the alternative is
 * a UI that refuses to start after an unclean shutdown. The create is `wx`, so two processes racing
 * for a free lock cannot both win.
 */
export async function acquireLock(dataDir: string, opts: AcquireLockOptions = {}): Promise<Lock> {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? ((p: number) => isProcessAlive(p));
  const thisHost = opts.hostname ?? os.hostname();
  const file = path.join(dataDir, LOCK_FILE);
  await mkdir(dataDir, { recursive: true });
  const info: LockInfo = { pid, startedAt: Date.now(), hostname: thisHost };

  // Two passes at most: one to claim it, one more after clearing a lock whose owner is gone.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(JSON.stringify(info), "utf8");
      } finally {
        await handle.close();
      }
      return makeLock(file, info);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    let existing: LockInfo | null;
    try {
      existing = parseLock(await readFile(file, "utf8"), thisHost);
    } catch (err) {
      // Someone released it between our create and our read; go around and claim it.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    // A lock written elsewhere is never reclaimed: pid 4242 on that host is not pid 4242 here, so
    // the liveness probe would be answering about an unrelated process, and getting it wrong
    // either refuses for no reason or lets two servers write one directory.
    if (existing && existing.hostname !== thisHost) {
      throw new LockError(foreignHostMessage(existing, dataDir, thisHost));
    }
    // A truncated or unparseable lockfile is a crash artefact, not a running server.
    if (existing && isAlive(existing.pid)) throw new LockError(heldMessage(existing, dataDir));
    await rm(file, { force: true });
  }

  // Only reachable if another process keeps re-taking the lock as fast as we clear it.
  throw new LockError(
    `Could not take the lock on ${dataDir}: another process keeps claiming ${LOCK_FILE}.\n` +
      `Stop any running claude-agent-ui and try again.`,
  );
}

function makeLock(file: string, info: LockInfo): Lock {
  let released = false;
  return {
    file,
    info,
    release() {
      if (released) return;
      released = true;
      // Only remove the file if it is still the one we wrote: a stale-lock takeover by a later
      // server must not have its lock deleted by our shutdown.
      try {
        const current = parseLock(readFileSync(file, "utf8"), info.hostname);
        if (current?.pid !== info.pid || current.startedAt !== info.startedAt || current.hostname !== info.hostname) {
          return;
        }
        rmSync(file, { force: true });
      } catch {
        // This runs from a signal handler and an `exit` listener, where a throw would print a raw
        // stack trace as the last thing the user sees. A lockfile we cannot read or delete is one
        // we leave alone: the next start reclaims it once our pid is gone.
      }
    },
  };
}
