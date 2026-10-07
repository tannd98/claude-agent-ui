import { execFile } from "node:child_process";

export class CliError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

export interface CliResult {
  stdout: string;
  stderr: string;
}

/** Runs the claude binary with an argument array (never through a shell). */
export type CliRunner = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<CliResult>;

export function execRunner(bin: string): CliRunner {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const output = `${stdout}\n${stderr}`.trim();
            reject(new CliError(output || err.message, output));
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
    });
}

/**
 * The major version of the Claude Code CLI this release was built and tested against.
 *
 * Every argument in `startBackground` and the JSON shape in `parseSessions` are a contract with
 * that CLI, and a major bump is where a contract is allowed to break. Bump this deliberately,
 * after running the suite against the new CLI — not because a warning was annoying.
 */
export const TESTED_CLI_MAJOR = 2;

/**
 * `2.1.288 (Claude Code)`, tolerant of a `v` prefix and a `-beta.1` suffix. The `v` is matched but
 * left out of the capture, and the lookbehind keeps `1.2.3` out of the middle of `10.1.2.3`.
 */
const CLI_VERSION = /(?<![\w.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

/**
 * The version `claude --version` reports, or null when the output is not a shape we recognise.
 *
 * Null is not a failure: the binary ran, so it is far better to say nothing than to accuse a
 * working install of being the wrong version because the banner was reworded.
 */
export function parseCliVersion(output: string): string | null {
  return CLI_VERSION.exec(stripAnsi(output))?.[1] ?? null;
}

/**
 * How a run answers permission prompts.
 * `ask` is the default everywhere: the CLI's own prompting behaviour, no bypass flag.
 * `bypassPermissions` is a deliberate per-task opt-in and is the only mode that passes
 * `--dangerously-skip-permissions`.
 */
export type PermissionMode = "ask" | "bypassPermissions";

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "bypassPermissions"];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export interface BackgroundSession {
  id: string;
  sessionId: string;
  pid?: number;
  cwd: string;
  kind: string;
  name?: string;
  /** `busy` | `waiting` | `idle`. Absent means the CLI did not report one — unknown, not idle. */
  status?: string;
  /** `working` | `blocked` | `done` | `failed` | `stopped`. */
  state?: string;
  /** Only ever set alongside `status: "waiting"`; says what the session is waiting for. */
  waitingFor?: string;
  startedAt?: number;
}

/**
 * What the CLI says a session is doing. The raw `status`/`state`/`waitingFor` strings are
 * read here and nowhere else in the codebase.
 */
export type SessionPhase = "waiting" | "done" | "failed" | "stopped" | "idle" | "working";

/** The CLI's `waitingFor` for a pending tool permission. */
const PERMISSION_WAIT = "permission prompt";

export interface SessionWait {
  /** `permission` only when the CLI named a permission prompt; everything else is `other`. */
  reason: "permission" | "other";
  /** The CLI's own `waitingFor`, verbatim. Empty when it reported a wait with no reason. */
  detail: string;
}

export function sessionPhase(session: BackgroundSession): SessionPhase {
  // A terminal `state` is the CLI's own verdict, and it outranks the liveness fields below:
  // those go stale the moment the background job record is reaped.
  if (session.state === "failed") return "failed";
  if (session.state === "stopped") return "stopped";
  if (session.state === "done") return "done";
  // The CLI reports `waiting` ahead of idle/busy, so a session parked on a prompt never
  // looks idle — but without this branch it is indistinguishable from one doing work.
  if (session.status === "waiting") return "waiting";
  // No pid and no status: the job record is gone and we were never told how it ended.
  if (session.pid === undefined && session.status === undefined) return "stopped";
  if (session.status === "idle") return "idle";
  return "working";
}

/** Null unless the session is parked waiting for a human. */
export function sessionWait(session: BackgroundSession): SessionWait | null {
  if (sessionPhase(session) !== "waiting") return null;
  const detail = typeof session.waitingFor === "string" ? session.waitingFor : "";
  return { reason: detail === PERMISSION_WAIT ? "permission" : "other", detail };
}

const BG_ID = /backgrounded\s*·\s*([0-9a-f]+)/;

export function parseBgOutput(text: string): string {
  const match = BG_ID.exec(text);
  if (!match) throw new CliError(text.trim() || "claude --bg printed no session id", text);
  return match[1];
}

export function parseSessions(json: string): BackgroundSession[] {
  const data = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error("claude agents --json did not return an array");
  return data.filter((s) => s && typeof s.sessionId === "string");
}

export const UNATTENDED_PROMPT =
  "You are running unattended in a background session: no human is watching and nobody can answer questions. " +
  "Never ask the user anything or wait for input, and tell any subagent or skill you run the same. " +
  "Decide minor or conventional choices yourself and record them in your final report. " +
  "If a major question you cannot resolve from the available context blocks the work, stop and end the session with a final message " +
  'that starts with "BLOCKED:" and states the question, what you checked, and what you need from the user.';

export interface StartBackgroundOptions {
  agent: string;
  cwd: string;
  prompt: string;
  unattended?: boolean;
  /** Defaults to `ask`; only `bypassPermissions` skips the permission prompts. */
  permissionMode?: PermissionMode;
}

export class ClaudeCli {
  constructor(private readonly run: CliRunner) {}

  async startBackground(opts: StartBackgroundOptions): Promise<string> {
    const args = ["--bg", "--agent", opts.agent];
    // Skipping permissions is destructive, so it is opt-in per run and never implied by a default.
    if ((opts.permissionMode ?? DEFAULT_PERMISSION_MODE) === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }
    // Nobody watches a background run, so a question would hang it forever: remove the tool and say what to do instead.
    if (opts.unattended) args.push("--disallowedTools=AskUserQuestion", "--append-system-prompt", UNATTENDED_PROMPT);
    // "--" ends option parsing so a prompt starting with "-" is never read as a flag.
    args.push("--", opts.prompt);
    let out: CliResult;
    try {
      out = await this.run(args, { cwd: opts.cwd, timeoutMs: 60_000 });
    } catch (err) {
      if (err instanceof CliError) throw new CliError(stripAnsi(err.message), err.output);
      throw err;
    }
    return parseBgOutput(stripAnsi(`${out.stdout}\n${out.stderr}`));
  }

  /** Includes stopped sessions (`--all`) so the UI can show them as stopped rather than missing. */
  async listSessions(): Promise<BackgroundSession[]> {
    const { stdout } = await this.run(["agents", "--json", "--all"]);
    return parseSessions(stdout);
  }

  async stop(shortId: string): Promise<void> {
    await this.run(["stop", shortId]);
  }

  async remove(shortId: string): Promise<void> {
    await this.run(["rm", shortId]);
  }
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
