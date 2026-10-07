import path from "node:path";

/**
 * Where a definition came from.
 *
 * `user` is `~/.claude/...`, `project` is `<cwd>/.claude/...`, and `plugin` is a file owned by an
 * installed plugin. Only the first two are ever writable; see {@link READ_ONLY_PLUGIN}.
 */
export type Scope = "user" | "project" | "plugin";

/** The two scopes a user can write to. */
export type WritableScope = Exclude<Scope, "plugin">;

export function isWritableScope(value: unknown): value is WritableScope {
  return value === "user" || value === "project";
}

/** Shown verbatim in the UI, so a disabled editor explains itself instead of just being grey. */
export const READ_ONLY_PLUGIN = (plugin: string, kind: "agent" | "skill") =>
  `This ${kind} belongs to the ${plugin} plugin, which owns the file. Copy it to your user ${kind}s to make your own version.`;

export interface ScopeRoot {
  scope: WritableScope;
  /** Absolute path to `<base>/.claude/<kind>`. */
  dir: string;
}

/**
 * The user and project roots for `agents` or `skills`.
 *
 * The project root is dropped when it resolves to the same directory as the user root — the
 * default working directory is `~`, so without this every user definition would be listed twice.
 */
export function scopeRoots(kind: "agents" | "skills", home: string, projectDir?: string): ScopeRoot[] {
  const userDir = path.resolve(home, ".claude", kind);
  const roots: ScopeRoot[] = [{ scope: "user", dir: userDir }];
  if (projectDir) {
    const projectRoot = path.resolve(projectDir, ".claude", kind);
    if (projectRoot !== userDir) roots.push({ scope: "project", dir: projectRoot });
  }
  return roots;
}
