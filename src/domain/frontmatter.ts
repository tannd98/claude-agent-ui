import { parse } from "yaml";
import type { FieldError } from "./errors.ts";

export interface ParsedFile {
  data: Record<string, unknown>;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

/** Parses YAML frontmatter; throws with a readable message when missing or invalid. */
export function parseFrontmatter(content: string): ParsedFile {
  const match = FRONTMATTER.exec(content);
  if (!match) throw new Error("missing frontmatter (file must start with a --- block)");
  let data: unknown;
  try {
    data = parse(match[1]);
  } catch (err) {
    throw new Error(`invalid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  return { data: data as Record<string, unknown>, body: match[2] };
}

/**
 * `name` doubles as a filename (agents) or a directory name (skills), so a name we are about to
 * build a path from has to be path-safe.
 *
 * This is deliberately stricter than what Claude Code itself accepts, and it is therefore applied
 * only on create. A file already on disk is addressed by its own path, so `Code-Reviewer` — legal
 * to Claude Code, and unreachable through this regex — must still be editable and runnable here.
 */
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface Checked extends Partial<ParsedFile> {
  /** Empty when the content is valid. Reported together so an editor can mark every bad key at once. */
  fields: FieldError[];
  /**
   * Trimmed `name` from the frontmatter. Unset when `name` is wrong, and also when a skill simply
   * left it out — a legal file whose name comes from its directory instead.
   */
  name?: string;
}

export interface CheckOptions {
  /**
   * Also require `name` to satisfy `NAME_RE`, because the caller is about to turn it into a new
   * file or directory name. Off for every check of a file that already exists.
   */
  forNewPath?: boolean;
  /**
   * Which kind of definition this is, because Claude Code treats the two names differently: an
   * agent's `name` is its id, a skill's is only a display label. Defaults to `"agent"`, the
   * stricter rule.
   */
  kind?: "agent" | "skill";
}

/**
 * Checks the `name`/`description` frontmatter shared by agent and skill files.
 *
 * The default rules are the ones Claude Code applies before it will load a definition at all:
 * the frontmatter has to parse, `name` has to be there and carry neither a leading `-` nor the
 * `:` reserved for plugin-scoped ids, and `description` has to say when to reach for the file.
 * `forNewPath` adds our own, stricter path-safety rule on top.
 *
 * `kind: "skill"` keeps only the `description` rule, because none of the `name` rules are real
 * for a skill — measured against claude 2.1.288, not assumed. A skill's id is its *directory*
 * name; the frontmatter `name` is read as a display label and nothing else, so it is never
 * required, never parsed as a flag the way `claude --agent <name>` parses one, and never carries
 * a plugin-scoped id. A SKILL.md writing `name: -weird` or `name: a:b` loads either way.
 *
 * A skill we are about to *create* is the one case that still needs a usable `name`, since its
 * directory is built from it, so `forNewPath` brings both the requirement and `NAME_RE` back —
 * and `NAME_RE` already excludes a leading `-` and a `:`.
 *
 * Every rule is applied to the trimmed `name`, which is also the one returned, so surrounding
 * whitespace can neither smuggle a name past a rule nor fail one: `name: "ok-1 "` creates `ok-1`.
 *
 * Never throws: it returns the problems so callers can turn them into either a structured 400 or
 * the live feedback the editor shows while the user is still typing.
 */
export function checkDefinition(content: unknown, opts: CheckOptions = {}): Checked {
  if (typeof content !== "string" || !content.trim()) {
    return { fields: [{ field: "content", message: "the file is empty" }] };
  }
  let parsed: ParsedFile;
  try {
    parsed = parseFrontmatter(content);
  } catch (err) {
    return { fields: [{ field: "frontmatter", message: (err as Error).message }] };
  }

  const fields: FieldError[] = [];
  const { description } = parsed.data;
  // Trimmed first, then checked: the trimmed name is the one we export, store as `runName` and
  // hand to `claude --agent`, so a rule tested against the raw string guards the wrong value —
  // `name: " -dash"` would pass the leading-`-` rule and still run as `-dash`.
  const raw = parsed.data.name;
  const name = typeof raw === "string" ? raw.trim() : raw;
  // A skill may leave `name` out entirely, and the `name` it does write is only a display label.
  // Both rules below therefore apply to agents alone, where `name` is the id we run.
  const omitted = raw === undefined || raw === null;
  const skill = opts.kind === "skill";
  const nameRequired = !skill || opts.forNewPath === true || !omitted;
  if (typeof name !== "string" || !name) {
    if (nameRequired) fields.push({ field: "name", message: "`name` is required" });
  } else if (!skill && name.includes(":")) {
    // Claude Code reserves `:` for plugin-scoped ids and refuses to load the file otherwise.
    fields.push({ field: "name", message: "`name` cannot contain `:`, which is reserved for plugin names" });
  } else if (!skill && name.startsWith("-")) {
    fields.push({ field: "name", message: "`name` cannot start with `-`" });
  } else if (opts.forNewPath && !NAME_RE.test(name)) {
    fields.push({
      field: "name",
      message: "`name` must match ^[a-z0-9][a-z0-9-]*$ (lowercase letters, digits, dashes)",
    });
  }
  if (typeof description !== "string" || !description.trim()) {
    fields.push({ field: "description", message: "`description` is required" });
  }

  const named = typeof name === "string" && !fields.some((f) => f.field === "name");
  return { ...parsed, fields, name: named ? (name as string) : undefined };
}

/**
 * One sentence for a list row, from the problems `checkDefinition` found. Null when there are none.
 *
 * A frontmatter failure keeps its own wording because it is the one problem that explains why
 * every other field is missing; the rest are joined so a row names each bad key.
 */
export function describeFields(fields: FieldError[]): string | null {
  if (fields.length === 0) return null;
  const broken = fields.find((f) => f.field === "frontmatter");
  if (broken) return `invalid frontmatter: ${broken.message}`;
  return fields.map((f) => f.message).join("; ");
}
