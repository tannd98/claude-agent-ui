import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIN_TOKEN_LENGTH, generateToken } from "./auth.ts";
import { DEFAULT_PERMISSION_MODE, type PermissionMode, isPermissionMode } from "./claude/claudeCli.ts";

/** Thrown for anything the user can fix by changing a flag, an env var or the config file. */
export class ConfigError extends Error {}

export interface AppConfig {
  port: number;
  /** The single address to bind. Any one address is allowed; "every interface" is not. */
  host: string;
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
  /** The shared token every request must carry. `null` turns authentication off. */
  token: string | null;
  /** True when nobody chose a token and one was made at startup — the CLI has to show it. */
  tokenGenerated: boolean;
}

export const DEFAULTS = {
  port: 3000,
  host: "127.0.0.1",
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

/** Strips the brackets of an IPv6 literal and any zone id, so `[fe80::1%en0]` compares as `fe80::1`. */
function bareHost(host: string): string {
  const trimmed = host.trim();
  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unbracketed.split("%")[0].toLowerCase();
}

/** True when the address reaches this machine only: the whole 127/8 range, ::1, and localhost. */
export function isLoopback(host: string): boolean {
  const h = bareHost(host);
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** How the host appears in a URL and in a Host header: an IPv6 literal has to wear brackets. */
export function hostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * True when the address means "every interface on this machine" rather than one of them.
 *
 * Every spelling of all-zeroes counts: `0.0.0.0`, the bare `0` Node also accepts, `::` and its
 * longhand, the IPv4-mapped `::ffff:0.0.0.0`, and the empty string Node treats the same way.
 */
export function isWildcardHost(host: string): boolean {
  const h = bareHost(host);
  if (h === "" || h === "*") return true;
  if (/^0+(\.0+){0,3}$/.test(h)) return true;
  if (/^[0:]+$/.test(h) && h.includes(":")) return true;
  return /^::ffff:0+(\.0+){3}$/.test(h);
}

/**
 * Validates a bind address: one address, any address — a LAN address so another device on the
 * same network can reach the UI is a supported setup, and so is a hostname of your own.
 *
 * What is refused is the wildcard. Binding every interface puts a UI that starts Claude Code
 * sessions on whatever network the machine is attached to, including public ones, and it does it
 * without the user naming an interface. Naming the address keeps that a decision rather than a
 * side effect, so the error says which address to use instead.
 */
export function normalizeHost(value: unknown): string {
  const host = String(value).trim();
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!unbracketed) throw new ConfigError("host must not be empty — pass an address such as 127.0.0.1");
  if (isWildcardHost(unbracketed)) {
    throw new ConfigError(
      `host ${host} means every interface on this machine, which this server does not bind.\n` +
        "Name the one address you want instead: 127.0.0.1 for this machine only, or the machine's\n" +
        "LAN address (for example --host 192.168.1.42) to reach it from another device on the same\n" +
        "network. `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux) prints that address.",
    );
  }
  if (/[\s/@]/.test(unbracketed)) {
    throw new ConfigError(`host ${host} is not an address or hostname — pass something like 127.0.0.1 or my-box.local`);
  }
  return unbracketed;
}

/**
 * Decides whether the UI asks for a token, and which one.
 *
 * The default is the one that matches where the server can be reached from. On loopback the OS is
 * already the gate — only this machine can connect — so there is nothing for a token to add, and
 * `npx claude-agent-ui` stays a URL and nothing else. Bound anywhere else, every device on that
 * network can reach a UI that starts Claude Code sessions, so authentication comes on by itself
 * and a token is generated rather than waiting for someone to think of one.
 *
 * Both halves of that default are overridable: `--auth` turns it on over loopback, `--no-auth`
 * turns it off on a LAN address, and naming a token turns it on wherever you are.
 */
export function resolveAuth(
  setting: unknown,
  tokenInput: unknown,
  host: string,
  makeToken: () => string = generateToken,
): { token: string | null; tokenGenerated: boolean } {
  const chosen = tokenInput === undefined || tokenInput === null ? "" : String(tokenInput).trim();
  const on = setting === undefined ? chosen !== "" || !isLoopback(host) : asBool(setting, "auth");

  if (!on) {
    // Refused rather than silently honouring one of them: which was meant is unknowable, and
    // guessing "off" would leave a UI the user believed was protected wide open.
    if (chosen !== "") {
      throw new ConfigError(
        "a token is set but authentication is turned off — drop --no-auth to use the token, or remove the token",
      );
    }
    return { token: null, tokenGenerated: false };
  }
  if (chosen === "") return { token: makeToken(), tokenGenerated: true };
  if (chosen.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `token must be at least ${MIN_TOKEN_LENGTH} characters (got ${chosen.length}).\n` +
        "Leave it unset to have one generated for you.",
    );
  }
  return { token: chosen, tokenGenerated: false };
}

export interface CliFlags extends Partial<Record<keyof AppConfig, unknown>> {
  /** Explicit path to a config file; otherwise `<dataDir>/config.json`. */
  config?: string;
  /** `--auth` / `--no-auth`. Absent means "decide from the bound address" — see {@link resolveAuth}. */
  auth?: unknown;
  help?: boolean;
  version?: boolean;
  open?: boolean;
}

const FLAG_KEYS: Record<string, keyof CliFlags> = {
  "--port": "port",
  "--host": "host",
  "--data-dir": "dataDir",
  "--config": "config",
  "--cwd": "defaultCwd",
  "--claude-bin": "claudeBin",
  "--starter-prompt": "starterPrompt",
  "--concurrency": "concurrency",
  "--max-attempts": "maxAttempts",
  "--history-limit": "historyLimit",
  "--permission-mode": "permissionMode",
  "--token": "token",
};

const BOOLEAN_FLAGS: Record<string, { key: keyof CliFlags; value: boolean }> = {
  "--auth": { key: "auth", value: true },
  "--no-auth": { key: "auth", value: false },
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
  --host <addr>           Address to bind (default ${DEFAULTS.host}); use the machine's LAN
                          address to reach the UI from another device on the same network
  --data-dir <path>       State directory (default ~/.claude-agent-ui)
  --config <path>         Config file (default <data-dir>/config.json)
  --cwd <path>            Default working directory for new runs
  --claude-bin <path>     Path to the claude binary (default "${DEFAULTS.claudeBin}")
  --starter-prompt <text> Prompt used when a run is started with no prompt
  --concurrency <n>       Tasks run at once (default ${DEFAULTS.concurrency})
  --max-attempts <n>      Attempts per task, 1 = retries off (default ${DEFAULTS.maxAttempts})
  --history-limit <n>     Stored history entries (default ${DEFAULTS.historyLimit})
  --permission-mode <m>   "ask" (default) or "bypassPermissions"
  --token <value>         Token the UI asks for (at least ${MIN_TOKEN_LENGTH} characters); turns authentication on
  --auth, --no-auth       Force authentication on or off, whatever the address says
  --no-open               Do not open the UI in your browser (it opens by default)
  -h, --help              Show this help
  -v, --version           Show the version

--host takes one address. It does not take 0.0.0.0, :: or any other way of saying "every
interface": name the single address you want the UI reachable on.

Authentication follows the address unless you say otherwise: off on 127.0.0.1, where only this
machine can connect, and on everywhere else, with a token generated and printed at startup.
`;

/** Parses argv (without node/script), accepting both `--flag value` and `--flag=value`. */
export function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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

const ENV_KEYS: Record<string, keyof AppConfig | "config" | "auth"> = {
  CLAUDE_AGENT_UI_PORT: "port",
  CLAUDE_AGENT_UI_HOST: "host",
  CLAUDE_AGENT_UI_DATA_DIR: "dataDir",
  CLAUDE_AGENT_UI_CONFIG: "config",
  CLAUDE_AGENT_UI_CWD: "defaultCwd",
  CLAUDE_AGENT_UI_CLAUDE_BIN: "claudeBin",
  CLAUDE_AGENT_UI_STARTER_PROMPT: "starterPrompt",
  CLAUDE_AGENT_UI_CONCURRENCY: "concurrency",
  CLAUDE_AGENT_UI_MAX_ATTEMPTS: "maxAttempts",
  CLAUDE_AGENT_UI_HISTORY_LIMIT: "historyLimit",
  CLAUDE_AGENT_UI_PERMISSION_MODE: "permissionMode",
  CLAUDE_AGENT_UI_TOKEN: "token",
  CLAUDE_AGENT_UI_AUTH: "auth",
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

/** Reads a boolean from a JSON `true`, or from the spellings an env var or a shell can carry. */
function asBool(value: unknown, name: string): boolean {
  if (typeof value === "boolean") return value;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(`${name} must be true or false (got ${String(value)})`);
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

  const host = normalizeHost(pick("host") ?? DEFAULTS.host);
  const { token, tokenGenerated } = resolveAuth(flags.auth ?? envValues.auth ?? file.auth, pick("token"), host);

  return {
    // 0 is deliberate: it asks the OS for a free port, which listen() then reports back.
    port: asInt(pick("port") ?? DEFAULTS.port, "port", 0, 65535),
    host,
    dataDir,
    starterPrompt: String(pick("starterPrompt") ?? DEFAULTS.starterPrompt),
    defaultCwd: path.resolve(expandHome(String(pick("defaultCwd") ?? DEFAULTS.defaultCwd), home)),
    claudeBin: String(pick("claudeBin") ?? DEFAULTS.claudeBin),
    concurrency: asInt(pick("concurrency") ?? DEFAULTS.concurrency, "concurrency", 1, 64),
    maxAttempts: asInt(pick("maxAttempts") ?? DEFAULTS.maxAttempts, "maxAttempts", 1, 10),
    historyLimit: asInt(pick("historyLimit") ?? DEFAULTS.historyLimit, "historyLimit", 1, 100_000),
    permissionMode,
    token,
    tokenGenerated,
  };
}
