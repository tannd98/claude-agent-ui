import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PERMISSION_MODE, type PermissionMode, isPermissionMode } from "./claude/claudeCli.ts";

/** Thrown for anything the user can fix by changing a flag, an env var or the config file. */
export class ConfigError extends Error {}

export interface AppConfig {
  port: number;
  /** Absolute path to ~/.claude-agent-ui (or an override); all runtime state lives here. */
  dataDir: string;
  starterPrompt: string;
  defaultCwd: string;
  claudeBin: string;
  /** How many queued tasks may run at once. */
  concurrency: number;
  /** Attempts per task, including the first. 1 = retries off. */
  maxAttempts: number;
  /** Cap on stored task/run history entries. */
  historyLimit: number;
  /** Default permission mode for a run; `bypassPermissions` is always an explicit opt-in. */
  permissionMode: PermissionMode;
}

export const DEFAULTS = {
  port: 3000,
  starterPrompt: "Start your task.",
  defaultCwd: "~",
  claudeBin: "claude",
  concurrency: 2,
  maxAttempts: 1,
  historyLimit: 500,
  permissionMode: DEFAULT_PERMISSION_MODE,
} as const;

export function expandHome(p: string, home = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function defaultDataDir(home = os.homedir()): string {
  return path.join(home, ".claude-agent-ui");
}

export interface CliFlags extends Partial<Record<keyof AppConfig, unknown>> {
  /** Explicit path to a config file; otherwise `<dataDir>/config.json`. */
  config?: string;
  help?: boolean;
  version?: boolean;
  open?: boolean;
}

const FLAG_KEYS: Record<string, keyof CliFlags> = {
  "--port": "port",
  "--data-dir": "dataDir",
  "--config": "config",
  "--cwd": "defaultCwd",
  "--claude-bin": "claudeBin",
  "--starter-prompt": "starterPrompt",
  "--concurrency": "concurrency",
  "--max-attempts": "maxAttempts",
  "--history-limit": "historyLimit",
  "--permission-mode": "permissionMode",
};

const BOOLEAN_FLAGS: Record<string, { key: keyof CliFlags; value: boolean }> = {
  "--help": { key: "help", value: true },
  "-h": { key: "help", value: true },
  "--version": { key: "version", value: true },
  "-v": { key: "version", value: true },
  "--open": { key: "open", value: true },
  "--no-open": { key: "open", value: false },
};

export const USAGE = `claude-agent-ui — local web UI for Claude Code agents

Usage: claude-agent-ui [options]

Options:
  --port <n>              Port to listen on, 0 picks a free one (default ${DEFAULTS.port})
  --data-dir <path>       State directory (default ~/.claude-agent-ui)
  --config <path>         Config file (default <data-dir>/config.json)
  --cwd <path>            Default working directory for new runs
  --claude-bin <path>     Path to the claude binary (default "${DEFAULTS.claudeBin}")
  --starter-prompt <text> Prompt used when a run is started with no prompt
  --concurrency <n>       Tasks run at once (default ${DEFAULTS.concurrency})
  --max-attempts <n>      Attempts per task, 1 = retries off (default ${DEFAULTS.maxAttempts})
  --history-limit <n>     Stored history entries (default ${DEFAULTS.historyLimit})
  --permission-mode <m>   "ask" (default) or "bypassPermissions"
  --no-open               Do not open the UI in your browser (it opens by default)
  -h, --help              Show this help
  -v, --version           Show the version

The server always listens on 127.0.0.1 and has no option to do otherwise.
`;

/** Parses argv (without node/script), accepting both `--flag value` and `--flag=value`. */
export function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host" || arg.startsWith("--host=")) {
      throw new ConfigError(
        "--host is not supported: claude-agent-ui only ever listens on 127.0.0.1.\n" +
          "Use an SSH tunnel if you need to reach it from another machine.",
      );
    }
    const boolean = BOOLEAN_FLAGS[arg];
    if (boolean) {
      flags[boolean.key] = boolean.value as never;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const key = FLAG_KEYS[name];
    if (!key) throw new ConfigError(`unknown option: ${arg}\n\nRun claude-agent-ui --help to see the options.`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new ConfigError(`${name} needs a value`);
    flags[key] = value as never;
  }
  return flags;
}

const ENV_KEYS: Record<string, keyof AppConfig | "config"> = {
  CLAUDE_AGENT_UI_PORT: "port",
  CLAUDE_AGENT_UI_DATA_DIR: "dataDir",
  CLAUDE_AGENT_UI_CONFIG: "config",
  CLAUDE_AGENT_UI_CWD: "defaultCwd",
  CLAUDE_AGENT_UI_CLAUDE_BIN: "claudeBin",
  CLAUDE_AGENT_UI_STARTER_PROMPT: "starterPrompt",
  CLAUDE_AGENT_UI_CONCURRENCY: "concurrency",
  CLAUDE_AGENT_UI_MAX_ATTEMPTS: "maxAttempts",
  CLAUDE_AGENT_UI_HISTORY_LIMIT: "historyLimit",
  CLAUDE_AGENT_UI_PERMISSION_MODE: "permissionMode",
};

function fromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(ENV_KEYS)) {
    const value = env[name];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

function readConfigFile(file: string, required: boolean): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (!required && (err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`could not read config file ${file}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigError(`config file ${file} must contain a JSON object`);
  }
  return data as Record<string, unknown>;
}

function asInt(value: unknown, name: string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be a whole number between ${min} and ${max} (got ${String(value)})`);
  }
  return n;
}

export interface LoadConfigOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Layers defaults < config file < environment < CLI flags, validating as it goes. */
export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const flags = parseArgs(opts.argv ?? []);
  const envValues = fromEnv(env);

  const dataDirInput = flags.dataDir ?? envValues.dataDir;
  const dataDir = dataDirInput ? path.resolve(expandHome(String(dataDirInput), home)) : defaultDataDir(home);

  const configInput = flags.config ?? envValues.config;
  const configFile = configInput
    ? path.resolve(expandHome(String(configInput), home))
    : path.join(dataDir, "config.json");
  const file = readConfigFile(configFile, configInput !== undefined);

  const pick = (key: keyof AppConfig): unknown => flags[key] ?? envValues[key] ?? file[key];
  const permissionMode = pick("permissionMode") ?? DEFAULTS.permissionMode;
  if (!isPermissionMode(permissionMode)) {
    throw new ConfigError(`permissionMode must be "ask" or "bypassPermissions" (got ${String(permissionMode)})`);
  }

  return {
    // 0 is deliberate: it asks the OS for a free port, which listen() then reports back.
    port: asInt(pick("port") ?? DEFAULTS.port, "port", 0, 65535),
    dataDir,
    starterPrompt: String(pick("starterPrompt") ?? DEFAULTS.starterPrompt),
    defaultCwd: path.resolve(expandHome(String(pick("defaultCwd") ?? DEFAULTS.defaultCwd), home)),
    claudeBin: String(pick("claudeBin") ?? DEFAULTS.claudeBin),
    concurrency: asInt(pick("concurrency") ?? DEFAULTS.concurrency, "concurrency", 1, 64),
    maxAttempts: asInt(pick("maxAttempts") ?? DEFAULTS.maxAttempts, "maxAttempts", 1, 10),
    historyLimit: asInt(pick("historyLimit") ?? DEFAULTS.historyLimit, "historyLimit", 1, 100_000),
    permissionMode,
  };
}
