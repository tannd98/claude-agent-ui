import { stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PERMISSION_MODE, type PermissionMode, isPermissionMode } from "../claude/claudeCli.ts";
import { expandHome } from "../config.ts";

/**
 * The input a background session needs, validated in one place.
 *
 * Both a run (`POST /api/runs`) and a task (`POST /api/tasks`) end up in the same
 * `claude --bg` argv, so they have to agree on what a valid agent name, prompt and working
 * directory are. Two copies of these rules is two places for the dangerous one to drift.
 */

/** Something the caller can fix by sending a different body; carries the status to answer with. */
export class InputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const MAX_PROMPT_LENGTH = 100_000;

// Plugin agents are "<plugin>:<agent>"; never allow a leading "-" (would be read as a CLI option).
const RUN_NAME = /^([a-z0-9][\w.-]*:)?[a-z0-9][\w.-]*$/i;

export function checkRunName(agent: unknown): string {
  if (typeof agent !== "string" || !RUN_NAME.test(agent)) throw new InputError(`invalid agent name: ${String(agent)}`);
  return agent;
}

/** A blank or missing prompt falls back to the configured starter prompt. */
export function checkPrompt(value: unknown, starterPrompt: string): string {
  const custom = value ?? "";
  if (typeof custom !== "string") throw new InputError("prompt must be a string");
  if (custom.length > MAX_PROMPT_LENGTH) {
    throw new InputError(`prompt is too long (max ${MAX_PROMPT_LENGTH} characters)`);
  }
  // execFile rejects NUL in argv; report it as bad input rather than a CLI failure.
  if (custom.includes("\0")) throw new InputError("prompt must not contain NUL characters");
  return custom.trim() ? custom : starterPrompt;
}

export function checkPermissionMode(
  value: unknown,
  fallback: PermissionMode = DEFAULT_PERMISSION_MODE,
): PermissionMode {
  const mode = value ?? fallback;
  if (!isPermissionMode(mode)) throw new InputError(`permissionMode must be "ask" or "bypassPermissions"`);
  return mode;
}

export function checkUnattended(value: unknown, fallback: boolean): boolean {
  const unattended = value ?? fallback;
  if (typeof unattended !== "boolean") throw new InputError("unattended must be a boolean");
  return unattended;
}

/** Expands `~`, then requires an absolute path that exists and is a directory. */
export async function checkCwd(value: unknown, home: string, fallback: string): Promise<string> {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new InputError("working directory must be a string");
  }
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const cwd = expandHome(raw, home);
  if (!cwd || !path.isAbsolute(cwd)) throw new InputError("working directory must be an absolute path");
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error();
  } catch {
    throw new InputError(`working directory does not exist: ${cwd}`);
  }
  return cwd;
}
