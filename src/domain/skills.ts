import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentInfo } from "./agents.ts";
import { checkDefinition, describeFields, parseFrontmatter } from "./frontmatter.ts";
import { enabledUserPlugins } from "./plugins.ts";
import { READ_ONLY_PLUGIN, type Scope, type WritableScope, scopeRoots } from "./scopes.ts";

/** The one filename Claude Code recognises inside a skill directory. */
export const SKILL_FILE = "SKILL.md";

export interface SkillInfo {
  id: string;
  /** Frontmatter `name`, falling back to the directory name — which Claude Code does too. */
  name: string;
  /**
   * How the skill is referenced in a prompt or an agent's `skills:` list: the bare name for user
   * and project skills, `<plugin>:<skill>` for a plugin's.
   */
  ref: string;
  description: string;
  scope: Scope;
  plugin: string | null;
  editable: boolean;
  /** Why the skill cannot be edited, in a sentence; null when it can. */
  readOnlyReason: string | null;
  /** The frontmatter block parsed, so the body can be shown — even if a field is wrong. */
  parses: boolean;
  /** Claude Code would load this skill: it parses and its required fields are there. */
  valid: boolean;
  /** Every problem `valid: false` stands for, in one sentence; null when there are none. */
  error: string | null;
  /** The skill's directory name, which Claude Code expects to match `name`. */
  dirName: string;
  /** Absolute paths; server-side only, never sent to the client. */
  dir: string;
  filePath: string;
}

export type PublicSkill = Omit<SkillInfo, "dir" | "filePath">;

/** A skill plus its file, for the detail view. The list deliberately carries no bodies. */
export interface SkillDetail extends PublicSkill {
  /** The whole SKILL.md, frontmatter included — what the editor loads. */
  content: string;
  /** Just the markdown after the frontmatter block. Empty when the frontmatter does not parse. */
  body: string;
}

export function skillsDir(home: string): string {
  return path.join(home, ".claude", "skills");
}

export function skillId(scope: string, filePath: string): string {
  return createHash("sha1").update(`${scope}\0${filePath}`).digest("hex").slice(0, 16);
}

export function toPublicSkill({ dir: _dir, filePath: _file, ...rest }: SkillInfo): PublicSkill {
  return rest;
}

/** Directories directly under `root` that contain a SKILL.md. */
async function listSkillDirs(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const e of entries) {
    const dir = path.join(root, e.name);
    // Symlinked skill directories (a dotfiles repo, a checked-out skill pack) count as directories.
    const isDir =
      e.isDirectory() ||
      (e.isSymbolicLink() &&
        (await stat(dir).then(
          (st) => st.isDirectory(),
          () => false,
        )));
    if (!isDir) continue;
    const ok = await stat(path.join(dir, SKILL_FILE)).then(
      (st) => st.isFile(),
      () => false,
    );
    if (ok) dirs.push(dir);
  }
  return dirs.sort();
}

interface Origin {
  scope: Scope;
  plugin: string | null;
  editable: boolean;
  /** Prefixed onto `ref`, so a plugin skill is addressed the way Claude Code expects. */
  refPrefix: string;
}

async function readSkillDir(dir: string, origin: Origin): Promise<SkillInfo> {
  const dirName = path.basename(dir);
  const filePath = path.join(dir, SKILL_FILE);
  const base = {
    id: skillId(origin.scope, filePath),
    scope: origin.scope,
    plugin: origin.plugin,
    editable: origin.editable,
    readOnlyReason: origin.editable ? null : READ_ONLY_PLUGIN(origin.plugin ?? "its", "skill"),
    dirName,
    dir,
    filePath,
  };
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      ...base,
      name: dirName,
      ref: origin.refPrefix + dirName,
      description: "",
      parses: false,
      valid: false,
      error: `cannot be read: ${(err as Error).message}`,
    };
  }

  // Checked exactly as the editor checks a draft, so the list and the editor never disagree about
  // whether a skill is usable. `forNewPath` is off: the directory already exists.
  const { data, fields } = checkDefinition(content, { kind: "skill" });
  const name = typeof data?.name === "string" && data.name.trim() ? data.name.trim() : dirName;
  return {
    ...base,
    name,
    ref: origin.refPrefix + name,
    description: typeof data?.description === "string" ? data.description : "",
    parses: data !== undefined,
    valid: fields.length === 0,
    error: describeFields(fields),
  };
}

const writable = (scope: WritableScope): Origin => ({ scope, plugin: null, editable: true, refPrefix: "" });

/**
 * Every skill reachable from `home`, plus `projectDir` when one is given.
 *
 * Plugin skills are listed read-only: the plugin owns the file, and an edit would be lost the next
 * time it updates. As with agents, an unparseable SKILL.md is listed with the reason rather than
 * dropped — that is the file the user most needs to find.
 */
export async function discoverSkills(home: string, projectDir?: string): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  for (const { scope, dir } of scopeRoots("skills", home, projectDir)) {
    const dirs = await listSkillDirs(dir);
    skills.push(...(await Promise.all(dirs.map((d) => readSkillDir(d, writable(scope))))));
  }

  for (const { plugin, installPath } of await enabledUserPlugins(home)) {
    const dirs = await listSkillDirs(path.join(installPath, "skills"));
    const origin: Origin = { scope: "plugin", plugin, editable: false, refPrefix: `${plugin}:` };
    skills.push(...(await Promise.all(dirs.map((d) => readSkillDir(d, origin)))));
  }
  return skills;
}

export async function findSkill(home: string, id: string, projectDir?: string): Promise<SkillInfo | undefined> {
  return (await discoverSkills(home, projectDir)).find((s) => s.id === id);
}

/** Loads a skill's file for the editor. */
export async function readSkill(skill: SkillInfo): Promise<SkillDetail> {
  const content = await readFile(skill.filePath, "utf8");
  let body = "";
  try {
    body = parseFrontmatter(content).body;
  } catch {
    // An unparseable file still opens in the editor; `error` already says why there is no body.
  }
  return { ...toPublicSkill(skill), content, body };
}

/* ---------------------------------------------------------------------------------------
 * Which skills an agent can reach
 * ------------------------------------------------------------------------------------ */

export interface AgentSkillAccess {
  /**
   * `all` — the agent can use every skill discovered here.
   * `allowlist` — its frontmatter names the skills it may use.
   * `none` — its `tools:` list leaves out `Skill`, so it cannot invoke one at all.
   */
  kind: "all" | "allowlist" | "none";
  /** A sentence for the detail view, explaining the kind above. */
  reason: string;
  skills: PublicSkill[];
  /** Allowlisted names that match no skill on disk — almost always a typo worth surfacing. */
  unknown: string[];
}

/** Accepts both `skills: [a, b]` and the comma-separated `skills: a, b` the CLI also takes. */
function asList(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").map((v) => v.trim());
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return null;
}

/**
 * Resolves the skills `agent` can reach, for the agent detail view.
 *
 * The rules mirror the CLI: an explicit `skills:` list in the frontmatter wins, otherwise an agent
 * reaches everything unless its `tools:` list is narrow enough to exclude the `Skill` tool. A file
 * that does not parse gets no access, because nothing in it can be trusted to say otherwise.
 */
export function resolveAgentSkills(
  agent: AgentInfo,
  skills: SkillInfo[],
  frontmatter: Record<string, unknown>,
): AgentSkillAccess {
  const published = skills.map(toPublicSkill);
  // Keyed on `parses`, not `valid`: a missing `description` makes an agent unrunnable but leaves
  // its `skills:`/`tools:` lists perfectly readable, and the sentence below would then be a lie.
  if (!agent.parses) {
    return {
      kind: "none",
      reason: "This agent's frontmatter does not parse, so its skills cannot be resolved.",
      skills: [],
      unknown: [],
    };
  }

  const allowed = asList(frontmatter.skills);
  if (allowed) {
    const byRef = new Map(published.flatMap((s) => [[s.ref, s] as const, [s.name, s] as const]));
    const found: PublicSkill[] = [];
    const unknown: string[] = [];
    for (const ref of allowed) {
      const skill = byRef.get(ref);
      if (skill && !found.includes(skill)) found.push(skill);
      else if (!skill) unknown.push(ref);
    }
    return {
      kind: "allowlist",
      reason: "This agent's frontmatter lists the skills it may use.",
      skills: found,
      unknown,
    };
  }

  const tools = asList(frontmatter.tools);
  if (tools && !tools.some((t) => t === "Skill" || t === "*")) {
    return {
      kind: "none",
      reason: "This agent's `tools` list does not include `Skill`, so it cannot invoke one.",
      skills: [],
      unknown: [],
    };
  }

  return { kind: "all", reason: "This agent can use every skill installed here.", skills: published, unknown: [] };
}
