import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { TESTED_CLI_MAJOR, parseCliVersion } from "../src/claude/claudeCli.ts";
import { checkClaudeBinary, checkClaudeCliVersion, checkNodeVersion, main, readVersion } from "../src/cli.ts";
import { fakeClaudeBin, tempHome } from "./helpers.ts";

test("the Node preflight explains what to do, and passes on supported versions", () => {
  assert.match(checkNodeVersion("v18.20.0")!, /needs Node 20 or newer/);
  assert.match(checkNodeVersion("v18.20.0")!, /nvm install 20/);
  assert.equal(checkNodeVersion("v20.0.0"), null);
  assert.equal(checkNodeVersion("v24.21.0"), null);
  assert.equal(checkNodeVersion("not-a-version"), null);
});

test("the claude preflight names the binary and how to point at another one", async () => {
  // A path that cannot exist, so this never depends on a real claude install.
  const { problem } = await checkClaudeBinary("/nonexistent/claude-agent-ui-preflight-probe");
  assert.match(problem!, /Could not run the Claude Code CLI/);
  assert.match(problem!, /--claude-bin/);
  assert.match(problem!, /CLAUDE_AGENT_UI_CLAUDE_BIN/);
});

test("the claude preflight passes for a binary that exits cleanly", async () => {
  // node --version succeeds everywhere, so this does not assume a POSIX shell environment.
  // Only `problem` is asserted: node prints its own version, not the one this check is about.
  assert.equal((await checkClaudeBinary(process.execPath)).problem, null);
});

test("parseCliVersion reads the version out of what the CLI actually prints", () => {
  assert.equal(parseCliVersion("2.1.288 (Claude Code)"), "2.1.288");
  assert.equal(parseCliVersion("\x1b[1m2.1.288\x1b[0m (Claude Code)\n"), "2.1.288");
  assert.equal(parseCliVersion("v3.0.0-beta.1 (Claude Code)"), "3.0.0-beta.1");
  // Unreadable is not "wrong version": the binary ran, so we must not accuse it of anything.
  assert.equal(parseCliVersion("Claude Code"), null);
  assert.equal(parseCliVersion(""), null);
});

test("the version check is silent on the tested major and loud on either side of it", () => {
  assert.equal(checkClaudeCliVersion(`${TESTED_CLI_MAJOR}.1.288 (Claude Code)`), null);
  // A minor bump is where the CLI adds things; warning on those would train people to ignore it.
  assert.equal(checkClaudeCliVersion(`${TESTED_CLI_MAJOR}.99.0 (Claude Code)`), null);
  assert.equal(checkClaudeCliVersion("nothing version-shaped here"), null);

  const newer = checkClaudeCliVersion("3.0.0 (Claude Code)", 2);
  assert.match(newer!, /^Warning: Claude Code CLI 3\.0\.0 is a major version/);
  assert.match(newer!, /expects 2\.x/);
  assert.match(newer!, /Starting anyway/);
  assert.match(newer!, /npm view claude-agent-ui version/);

  // Older points at the CLI instead: there is no older claude-agent-ui to go back to.
  const older = checkClaudeCliVersion("1.9.9 (Claude Code)", 2);
  assert.match(older!, /npm i -g @anthropic-ai\/claude-code/);
  assert.doesNotMatch(older!, /npm view/);
});

test("readVersion reports the package version", () => {
  assert.match(readVersion(), /^\d+\.\d+\.\d+/);
});

/** Runs main() with both streams captured, so a test can read what the CLI advertises and warns. */
async function runMain(
  argv: string[],
): Promise<{ server: Awaited<ReturnType<typeof main>>; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const capture = (into: string[]) =>
    ((chunk: unknown) => {
      into.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = capture(out);
  process.stderr.write = capture(err);
  try {
    return { server: await main(argv), out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

// Regression: --port 0 used to print a working-looking URL that the loopback guard then refused,
// because the guard was built from the requested 0 rather than the port the OS actually bound.
test("--port 0 prints a URL the server actually serves", async () => {
  const home = await tempHome();
  const { server, out, err } = await runMain([
    "--port",
    "0",
    "--data-dir",
    path.join(home, ".claude-agent-ui"),
    "--claude-bin",
    await fakeClaudeBin(),
    // Without this the default would launch a real browser on whoever runs the suite.
    "--no-open",
  ]);
  assert.ok(server, "main should return the listening server");
  try {
    const url = /Claude Agent UI: (\S+)/.exec(out)?.[1];
    assert.ok(url, `no URL in output: ${out}`);
    assert.doesNotMatch(url, /:0$/);
    const res = await fetch(`${url}/api/config`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { permissionMode: string }).permissionMode, "ask");
    // A supported CLI starts in silence. Nothing on stderr at all, so the warning below is a
    // signal rather than one more line in a startup that always says something.
    assert.equal(err, "");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an untested CLI major warns on stderr and starts anyway", async () => {
  const home = await tempHome();
  const { server, out, err } = await runMain([
    "--port",
    "0",
    "--data-dir",
    path.join(home, ".claude-agent-ui"),
    "--claude-bin",
    await fakeClaudeBin(`${TESTED_CLI_MAJOR + 1}.0.0`),
    "--no-open",
  ]);
  // Starting is the point: an untested CLI is usually fine, and refusing would strand someone
  // on the day the CLI bumps.
  assert.ok(server, "an untested CLI major must not stop the server starting");
  try {
    assert.match(err, /Warning: Claude Code CLI .* has not been tested against/);
    // stderr, so redirecting stdout to capture the URL does not swallow the warning — and so the
    // warning can never be mistaken for part of the URL line.
    assert.match(out, /Claude Agent UI: http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(out, /Warning:/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
