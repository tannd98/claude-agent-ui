import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ConfigError, DEFAULTS, defaultDataDir, expandHome, loadConfig, parseArgs } from "../src/config.ts";
import { put, tempHome } from "./helpers.ts";

const load = (opts: { argv?: string[]; env?: NodeJS.ProcessEnv; home: string }) =>
  loadConfig({ argv: opts.argv ?? [], env: opts.env ?? {}, home: opts.home });

test("expandHome only expands a leading ~", () => {
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("~/w", "/h"), "/h/w");
  assert.equal(expandHome("/abs/~/w", "/h"), "/abs/~/w");
  assert.equal(expandHome("~notahome", "/h"), "~notahome");
});

test("defaults match the locked plan: concurrency 2, retries off, ask, history 500", async () => {
  const home = await tempHome();
  const config = load({ home });
  assert.equal(config.concurrency, 2);
  assert.equal(config.maxAttempts, 1);
  assert.equal(config.permissionMode, "ask");
  assert.equal(config.historyLimit, 500);
  assert.equal(config.port, DEFAULTS.port);
  assert.equal(config.dataDir, defaultDataDir(home));
  assert.equal(config.dataDir, path.join(home, ".claude-agent-ui"));
});

test("state lives under the data dir, and the config file is read from it", async () => {
  const home = await tempHome();
  await put(path.join(home, ".claude-agent-ui", "config.json"), JSON.stringify({ port: 4100, concurrency: 5 }));
  const config = load({ home });
  assert.equal(config.port, 4100);
  assert.equal(config.concurrency, 5);
});

test("env overrides the config file, and flags override env", async () => {
  const home = await tempHome();
  await put(path.join(home, ".claude-agent-ui", "config.json"), JSON.stringify({ port: 4100 }));
  assert.equal(load({ home, env: { CLAUDE_AGENT_UI_PORT: "4200" } }).port, 4200);
  assert.equal(load({ home, env: { CLAUDE_AGENT_UI_PORT: "4200" }, argv: ["--port", "4300"] }).port, 4300);
  assert.equal(load({ home, argv: ["--port=4400"] }).port, 4400);
});

test("--data-dir moves the state directory and the config file with it", async () => {
  const home = await tempHome();
  const dataDir = path.join(home, "elsewhere");
  await put(path.join(dataDir, "config.json"), JSON.stringify({ starterPrompt: "from elsewhere" }));
  const config = load({ home, argv: ["--data-dir", dataDir] });
  assert.equal(config.dataDir, dataDir);
  assert.equal(config.starterPrompt, "from elsewhere");
});

test("--host is refused with an explanation, not silently accepted", async () => {
  const home = await tempHome();
  for (const argv of [["--host", "0.0.0.0"], ["--host=::"]]) {
    assert.throws(
      () => load({ home, argv }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /only ever listens on 127\.0\.0\.1/);
        return true;
      },
    );
  }
});

test("unknown options and missing values fail with a readable message", async () => {
  const home = await tempHome();
  assert.throws(() => load({ home, argv: ["--nope"] }), /unknown option: --nope/);
  assert.throws(() => load({ home, argv: ["--port"] }), /--port needs a value/);
});

test("out-of-range numbers and unknown permission modes are rejected", async () => {
  const home = await tempHome();
  assert.throws(() => load({ home, argv: ["--port", "99999"] }), /port must be a whole number/);
  assert.throws(() => load({ home, argv: ["--port", "-1"] }), /port must be a whole number/);
  assert.throws(() => load({ home, argv: ["--concurrency", "0"] }), /concurrency must be/);
  assert.throws(() => load({ home, argv: ["--max-attempts", "1.5"] }), /maxAttempts must be/);
  assert.throws(() => load({ home, argv: ["--permission-mode", "yolo"] }), /permissionMode must be/);
});

test("--port 0 is accepted: it asks the OS for a free port", async () => {
  const home = await tempHome();
  assert.equal(load({ home, argv: ["--port", "0"] }).port, 0);
});

test("a named config file must exist; the default one need not", async () => {
  const home = await tempHome();
  assert.throws(() => load({ home, argv: ["--config", path.join(home, "nope.json")] }), /could not read config file/);
  assert.doesNotThrow(() => load({ home }));
});

test("a malformed config file names the file and the problem", async () => {
  const home = await tempHome();
  await put(path.join(home, ".claude-agent-ui", "config.json"), "{not json");
  assert.throws(() => load({ home }), /config\.json is not valid JSON/);
});

test("--help and --version are parsed as boolean flags", () => {
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.deepEqual(parseArgs(["-v"]), { version: true });
  assert.deepEqual(parseArgs(["--open"]), { open: true });
  assert.deepEqual(parseArgs(["--no-open"]), { open: false });
});
