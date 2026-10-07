#!/usr/bin/env node
/**
 * The only test that exercises what we actually publish.
 *
 * Everything else in test/ runs the TypeScript in src/. This runs the tarball: it packs the
 * package, installs it into an empty directory the way `npx` would, starts the installed binary
 * and walks all four screens in a real browser. A bundler config that drops a file, a runtime
 * dependency we forgot to declare, a `files` entry that leaves the client behind — none of those
 * are visible to a test that imports from src, and all of them are fatal to a stranger.
 *
 *   node test/smoke/packedTarball.mjs        # packs, installs, walks, cleans up
 *   KEEP=1 node test/smoke/packedTarball.mjs # leaves the temp install for inspection
 *
 * Hermetic: `claude` is a synthetic stub on PATH, HOME is a temp directory holding synthetic
 * definitions, and the data directory is thrown away at the end. No real CLI, no real home.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The sidebar's four areas, each keyed by the <h1> its screen puts in the header. */
const SCREENS = [
  { url: "/agents", heading: "Agents" },
  { url: "/skills", heading: "Skills" },
  { url: "/tasks", heading: "Tasks" },
  { url: "/schedule", heading: "Schedule" },
];

const log = (msg) => process.stdout.write(`${msg}\n`);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${err || out}`)),
    );
  });
}

const write = (file, content, mode) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined) chmodSync(file, mode);
};

/**
 * A `claude` that answers --version and nothing else.
 *
 * Preflight runs `claude --version` and refuses to start without it, so CI needs something on
 * PATH. It must never be a real CLI: this test starts no runs, and a binary that could would
 * make the suite depend on a login.
 */
function stubClaude(dir) {
  const bin = path.join(dir, "claude");
  write(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.0.0-smoke-stub"; exit 0; fi\nexit 0\n', 0o755);
  return dir;
}

/** A home with one agent and one skill, so the two definition screens render a list and not just an empty state. */
function syntheticHome(home) {
  const c = path.join(home, ".claude");
  write(
    path.join(c, "agents", "smoke-agent.md"),
    "---\nname: smoke-agent\ndescription: A synthetic agent.\n---\n\nBody.\n",
  );
  write(
    path.join(c, "skills", "smoke-skill", "SKILL.md"),
    "---\nname: smoke-skill\ndescription: A synthetic skill.\n---\n\n# smoke-skill\n",
  );
  return home;
}

/** Starts the installed binary and resolves the URL it prints, or rejects with what it said instead. */
function startServer(bin, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "--port", "0", "--no-open", "--cwd", cwd], { env, stdio: "pipe" });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the server printed no URL within 30s\nstdout: ${out}\nstderr: ${err}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const url = /Claude Agent UI: (http:\/\/\S+)/.exec(out)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve({ child, url, stderr: () => err });
      }
    });
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited ${code} before printing a URL\nstdout: ${out}\nstderr: ${err}`));
    });
  });
}

/** Bundled chromium when it has been downloaded, the system Chrome when it has not. */
async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (err) {
    log(`  bundled chromium unavailable (${String(err.message).split("\n")[0]}); falling back to installed Chrome`);
    return chromium.launch({ channel: "chrome" });
  }
}

const tmp = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(), "cau-smoke-"));
let server;
let browser;
let failed = false;

try {
  log("1/5  building");
  await run("npm", ["run", "build"], { cwd: repo });

  log("2/5  packing");
  const packDir = path.join(tmp, "pack");
  mkdirSync(packDir, { recursive: true });
  await run("npm", ["pack", "--pack-destination", packDir], { cwd: repo });
  const tarball = path.join(
    packDir,
    readdirSync(packDir).find((f) => f.endsWith(".tgz")),
  );

  // Anything outside dist/ in the tarball is either npm's own or a leak. npm adds package.json,
  // README and LICENSE whatever `files` says, so those three are not strays. Asserted here rather
  // than by eye, because the next person to touch `files` will not think to look.
  const ALWAYS_PACKED = new Set(["package.json", "README.md", "LICENSE"]);
  const listing = (await run("tar", ["-tzf", tarball]))
    .split("\n")
    .map((l) => l.replace(/^package\//, "").trim())
    .filter((l) => l && !l.endsWith("/"));
  const strays = listing.filter((f) => !f.startsWith("dist/") && !ALWAYS_PACKED.has(f));
  if (strays.length > 0) throw new Error(`the tarball ships files outside dist/: ${strays.join(", ")}`);
  if (!listing.includes("dist/cli.js")) throw new Error("the tarball has no dist/cli.js, which is the bin entry");
  if (!listing.includes("dist/web/index.html")) throw new Error("the tarball has no built client at dist/web");
  log(`     ${listing.length} files, nothing outside dist/ but the three npm always packs`);

  log("3/5  installing into an empty directory");
  const host = path.join(tmp, "host");
  mkdirSync(host, { recursive: true });
  write(path.join(host, "package.json"), '{"name":"smoke-host","version":"1.0.0","private":true}\n');
  await run("npm", ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: host });
  const bin = path.join(host, "node_modules", "claude-agent-ui", "dist", "cli.js");

  log("4/5  starting the installed binary");
  const home = syntheticHome(path.join(tmp, "home"));
  const project = path.join(tmp, "project");
  mkdirSync(project, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${stubClaude(path.join(tmp, "bin"))}${path.delimiter}${process.env.PATH}`,
    CLAUDE_AGENT_UI_DATA_DIR: path.join(tmp, "data"),
  };
  server = await startServer(bin, env, project);
  log(`     listening on ${server.url}`);
  if (!server.url.startsWith("http://127.0.0.1:")) {
    throw new Error(`the server bound something other than loopback: ${server.url}`);
  }

  log("5/5  walking the four screens");
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e}`));
  // A 4xx/5xx on an asset still paints something; without this the walk would pass anyway.
  page.on("response", (r) => r.status() >= 400 && problems.push(`${r.status()} ${new URL(r.url()).pathname}`));

  for (const screen of SCREENS) {
    // Navigating by URL, not by clicking the sidebar: a deep link is how a reload and a shared
    // link arrive, and it is the path that needs the server's history fallback.
    await page.goto(server.url + screen.url, { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1, name: screen.heading, exact: true }).waitFor({ timeout: 10_000 });
    log(`     ${screen.url} → "${screen.heading}"`);
  }
  // And once by clicking, which is the only thing that proves the sidebar is wired to the router.
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "Tasks", exact: true }).waitFor({ timeout: 10_000 });
  log('     sidebar "Tasks" → "Tasks"');

  if (problems.length > 0) throw new Error(`the browser reported problems:\n  ${problems.join("\n  ")}`);
  log("\nPASS  the packed tarball installs, starts on loopback and serves all four screens");
} catch (err) {
  failed = true;
  process.stderr.write(`\nFAIL  ${err.message}\n`);
  if (server) process.stderr.write(`server stderr:\n${server.stderr()}\n`);
} finally {
  await browser?.close();
  server?.child.kill("SIGTERM");
  if (process.env.KEEP) log(`\nkept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
