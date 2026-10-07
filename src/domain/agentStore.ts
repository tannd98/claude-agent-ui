import { mkdir } from "node:fs/promises";
import path from "node:path";
import { agentId, findAgent } from "./agents.ts";
import { assertInsideRoots, createDefFile, removeDefPath, replaceDefFile } from "./defFile.ts";
import { ValidationError } from "./errors.ts";
import { type CheckOptions, checkDefinition } from "./frontmatter.ts";
import { type WritableScope, isWritableScope, scopeRoots } from "./scopes.ts";

export { ValidationError } from "./errors.ts";
export type { FieldError } from "./errors.ts";

export const NEW_AGENT_TEMPLATE = `---
name: my-agent
description: One sentence on when this agent should be used
model: sonnet
---

You are ... (describe the agent's job, how it gathers its own context, and what it reports).
`;

/**
 * Throws a 400 carrying every bad field, so the editor can mark them rather than show one sentence.
 *
 * `forNewPath` is set only by `createAgent`, which turns `name` into `<name>.md`. An update writes
 * back over a path that already exists, so it holds the file to what Claude Code itself requires.
 */
export function validateAgentContent(content: unknown, opts: CheckOptions = {}): { name: string } {
  const { fields, name } = checkDefinition(content, opts);
  if (fields.length > 0) throw new ValidationError(fields.map((f) => f.message).join("; "), 400, fields);
  return { name: name! };
}

/** The directories an agent may be written to, in listing order. */
function writableRoots(home: string, projectDir?: string) {
  return scopeRoots("agents", home, projectDir);
}

function rootFor(home: string, scope: WritableScope, projectDir?: string): string {
  const root = writableRoots(home, projectDir).find((r) => r.scope === scope);
  if (!root) {
    throw new ValidationError("there is no separate project directory: the project is your home directory", 400);
  }
  return root.dir;
}

/** Resolves `target` and refuses anything outside a `.claude/agents` directory. */
export function assertInsideAgentsDir(home: string, target: string, projectDir?: string): string {
  return assertInsideRoots(
    writableRoots(home, projectDir).map((r) => r.dir),
    target,
    ".claude/agents",
  );
}

export interface CreateAgentOptions {
  projectDir?: string;
  /** Which `.claude/agents` directory to write to. Defaults to the user one. */
  scope?: unknown;
}

export async function createAgent(
  home: string,
  content: unknown,
  opts: CreateAgentOptions = {},
): Promise<{ id: string; file: string; scope: WritableScope }> {
  const { name } = validateAgentContent(content, { forNewPath: true });
  const scope = opts.scope === undefined ? "user" : opts.scope;
  if (!isWritableScope(scope)) throw new ValidationError('scope must be "user" or "project"', 400);
  const dir = rootFor(home, scope, opts.projectDir);
  await mkdir(dir, { recursive: true });
  const file = assertInsideAgentsDir(home, path.join(dir, `${name}.md`), opts.projectDir);
  await createDefFile(file, content as string, `an agent file named ${name}.md already exists`);
  return { id: agentId(scope, file), file, scope };
}

async function editable(home: string, id: string, projectDir?: string) {
  const agent = await findAgent(home, id, projectDir);
  if (!agent) throw new ValidationError("agent not found", 404);
  if (!agent.editable) throw new ValidationError(agent.readOnlyReason ?? "this agent is read-only", 403);
  assertInsideAgentsDir(home, agent.filePath, projectDir);
  return agent;
}

export async function updateAgent(home: string, id: string, content: unknown, projectDir?: string): Promise<string> {
  const agent = await editable(home, id, projectDir);
  validateAgentContent(content);
  return replaceDefFile(agent.filePath, content as string);
}

export async function deleteAgent(home: string, id: string, projectDir?: string): Promise<string> {
  const agent = await editable(home, id, projectDir);
  await removeDefPath(agent.filePath);
  return agent.filePath;
}
