import { mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { assertInsideRoots, createDefFile, removeDefPath, replaceDefFile } from "./defFile.ts";
import { ValidationError } from "./errors.ts";
import { type CheckOptions, checkDefinition } from "./frontmatter.ts";
import { type WritableScope, isWritableScope, scopeRoots } from "./scopes.ts";
import { SKILL_FILE, findSkill, skillId } from "./skills.ts";

export const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when Claude should reach for it
---

# My skill

Describe the procedure step by step. Keep it short enough to read in one pass.
`;

/**
 * Throws a 400 carrying every bad field, so the editor can mark them rather than show one sentence.
 *
 * `forNewPath` is set only by `createSkill`, which turns `name` into the skill's directory. An
 * edit is pinned to the existing directory by the `name === dirName` rule below instead.
 *
 * `name` comes back undefined for the one file Claude Code accepts without it: a SKILL.md that
 * leaves `name` out and takes the directory name instead.
 */
export function validateSkillContent(content: unknown, opts: CheckOptions = {}): { name: string | undefined } {
  const { fields, name } = checkDefinition(content, { ...opts, kind: "skill" });
  if (fields.length > 0) throw new ValidationError(fields.map((f) => f.message).join("; "), 400, fields);
  return { name };
}

function writableRoots(home: string, projectDir?: string) {
  return scopeRoots("skills", home, projectDir);
}

function rootFor(home: string, scope: WritableScope, projectDir?: string): string {
  const root = writableRoots(home, projectDir).find((r) => r.scope === scope);
  if (!root) {
    throw new ValidationError("there is no separate project directory: the project is your home directory", 400);
  }
  return root.dir;
}

/** Resolves `target` and refuses anything outside a `.claude/skills` directory. */
export function assertInsideSkillsDir(home: string, target: string, projectDir?: string): string {
  return assertInsideRoots(
    writableRoots(home, projectDir).map((r) => r.dir),
    target,
    ".claude/skills",
  );
}

export interface CreateSkillOptions {
  projectDir?: string;
  /** Which `.claude/skills` directory to write to. Defaults to the user one. */
  scope?: unknown;
}

/**
 * Creates `<root>/<name>/SKILL.md`.
 *
 * The directory is created first but the file is what decides whether the skill already exists:
 * a leftover directory holding only assets must not permanently block the name. An empty
 * directory we just made is removed again when the write fails, so a 409 leaves nothing behind.
 */
export async function createSkill(
  home: string,
  content: unknown,
  opts: CreateSkillOptions = {},
): Promise<{ id: string; file: string; dir: string; scope: WritableScope }> {
  // `forNewPath` keeps `name` required even for a skill, because the directory is built from it.
  const name = validateSkillContent(content, { forNewPath: true }).name as string;
  const scope = opts.scope === undefined ? "user" : opts.scope;
  if (!isWritableScope(scope)) throw new ValidationError('scope must be "user" or "project"', 400);
  const dir = assertInsideSkillsDir(home, path.join(rootFor(home, scope, opts.projectDir), name), opts.projectDir);
  const created = await mkdir(dir, { recursive: true });
  const file = path.join(dir, SKILL_FILE);
  try {
    await createDefFile(file, content as string, `a skill named ${name} already exists`);
  } catch (err) {
    if (created !== undefined) await rmdir(dir).catch(() => {});
    throw err;
  }
  return { id: skillId(scope, file), file, dir, scope };
}

async function editable(home: string, id: string, projectDir?: string) {
  const skill = await findSkill(home, id, projectDir);
  if (!skill) throw new ValidationError("skill not found", 404);
  if (!skill.editable) throw new ValidationError(skill.readOnlyReason ?? "this skill is read-only", 403);
  assertInsideSkillsDir(home, skill.filePath, projectDir);
  return skill;
}

export async function updateSkill(home: string, id: string, content: unknown, projectDir?: string): Promise<string> {
  const skill = await editable(home, id, projectDir);
  const { name } = validateSkillContent(content);
  // No `name` at all is the one case that cannot drift: Claude Code then reads the skill under
  // its directory name, which is the value this rule is trying to pin it to anyway.
  if (name !== undefined && name !== skill.dirName) {
    // Claude Code finds a skill by its directory, so a `name` that drifts from it is invisible.
    // Renaming the directory under an open editor would strand its assets, so say so instead.
    throw new ValidationError(`\`name\` must stay "${skill.dirName}" to match the skill's directory`, 400, [
      { field: "name", message: `\`name\` must stay "${skill.dirName}" to match the skill's directory` },
    ]);
  }
  return replaceDefFile(skill.filePath, content as string);
}

/** Deletes the whole skill directory: a skill is its folder, assets included. */
export async function deleteSkill(home: string, id: string, projectDir?: string): Promise<string> {
  const skill = await editable(home, id, projectDir);
  const roots = writableRoots(home, projectDir).map((r) => path.resolve(r.dir));
  // Stricter than the file check above: only a direct child of a skills root is ever removed,
  // so a recursive delete can never walk up into ~/.claude or a nested tree.
  if (!roots.includes(path.dirname(path.resolve(skill.dir)))) {
    throw new ValidationError("path is outside .claude/skills", 403);
  }
  await removeDefPath(skill.dir);
  return skill.dir;
}
