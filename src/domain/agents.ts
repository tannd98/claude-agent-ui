import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { checkDefinition, describeFields } from "./frontmatter.ts";
import { enabledUserPlugins } from "./plugins.ts";
import { READ_ONLY_PLUGIN, type Scope, type WritableScope, scopeRoots } from "./scopes.ts";

export interface AgentInfo {
  id: string;
  name: string;
  /** Value passed to `claude --agent`. */
  runName: string;
  description: string;
  model: string | null;
  /** Where the file lives: `user` (~/.claude), `project` (<cwd>/.claude) or `plugin`. */
  scope: Scope;
  /** The owning plugin's short name; null for user and project agents. */
  plugin: string | null;
  editable: boolean;
  /** Why the file cannot be edited, in a sentence; null when it can. */
  readOnlyReason: string | null;
  /** The frontmatter block parsed, so `skills:`/`tools:` can be read — even if a field is wrong. */
  parses: boolean;
  /** Claude Code would load this file: it parses and its required fields are there. */
  valid: boolean;
  /** Every problem `valid: false` stands for, in one sentence; null when there are none. */
  error: string | null;
  /** Absolute path; server-side only, never sent to the client. */
  filePath: string;
}

export type PublicAgent = Omit<AgentInfo, "filePath">;

export function agentsDir(home: string): string {
  return path.join(home, ".claude", "agents");
}

export function agentId(scope: string, filePath: string): string {
  return createHash("sha1").update(`${scope}\0${filePath}`).digest("hex").slice(0, 16);
}

export function toPublic({ filePath: _omit, ...rest }: AgentInfo): PublicAgent {
  return rest;
}

async function listMarkdown(dir: string, recursive: boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    if (!e.name.endsWith(".md")) continue;
    const file = path.join(e.parentPath, e.name);
    // Symlinked agent files (e.g. from a dotfiles repo) count if they point at a regular file.
    if (
      e.isFile() ||
      (e.isSymbolicLink() &&
        (await stat(file).then(
          (st) => st.isFile(),
          () => false,
        )))
    ) {
      files.push(file);
    }
  }
  return files.sort();
}

interface Origin {
  scope: Scope;
  plugin: string | null;
  editable: boolean;
  /** Prefixed onto `runName`, so a plugin agent is addressed the way the CLI expects. */
  runPrefix: string;
}

async function readAgent(filePath: string, origin: Origin): Promise<AgentInfo> {
  const fallbackName = path.basename(filePath, ".md");
  const base = {
    id: agentId(origin.scope, filePath),
    scope: origin.scope,
    plugin: origin.plugin,
    editable: origin.editable,
    readOnlyReason: origin.editable ? null : READ_ONLY_PLUGIN(origin.plugin ?? "its", "agent"),
    filePath,
  };
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      ...base,
      name: fallbackName,
      runName: origin.runPrefix + fallbackName,
      description: "",
      model: null,
      parses: false,
      valid: false,
      error: `cannot be read: ${(err as Error).message}`,
    };
  }

  // The file is checked the same way the editor checks a draft, so a definition the editor would
  // refuse to save never lists as runnable. `forNewPath` is off: this file already has its path.
  const { data, fields } = checkDefinition(content);
  const name = typeof data?.name === "string" && data.name.trim() ? data.name.trim() : fallbackName;
  return {
    ...base,
    name,
    runName: origin.runPrefix + name,
    description: typeof data?.description === "string" ? data.description : "",
    model: typeof data?.model === "string" ? data.model : null,
    parses: data !== undefined,
    valid: fields.length === 0,
    error: describeFields(fields),
  };
}

const writable = (scope: WritableScope): Origin => ({ scope, plugin: null, editable: true, runPrefix: "" });

/**
 * Every agent definition reachable from `home`, plus `projectDir` when one is given.
 *
 * A file that fails to parse is still listed — with `valid: false` and the reason — because the
 * whole point of the editor is to fix it. The project root is skipped when it is the user root.
 */
export async function discoverAgents(home: string, projectDir?: string): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = [];
  for (const { scope, dir } of scopeRoots("agents", home, projectDir)) {
    const files = await listMarkdown(dir, true);
    agents.push(...(await Promise.all(files.map((f) => readAgent(f, writable(scope))))));
  }

  for (const { plugin, installPath } of await enabledUserPlugins(home)) {
    const files = await listMarkdown(path.join(installPath, "agents"), false);
    const origin: Origin = { scope: "plugin", plugin, editable: false, runPrefix: `${plugin}:` };
    agents.push(...(await Promise.all(files.map((f) => readAgent(f, origin)))));
  }
  return agents;
}

export async function findAgent(home: string, id: string, projectDir?: string): Promise<AgentInfo | undefined> {
  return (await discoverAgents(home, projectDir)).find((a) => a.id === id);
}
