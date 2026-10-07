#!/usr/bin/env node
/**
 * Renders the Agents and Skills screens at a real viewport in both themes and writes PNGs.
 * Dev tool, not shipped.
 *
 * Point it at a server started against a throwaway HOME, so the shots carry fixture content
 * rather than whatever happens to be in the operator's own ~/.claude:
 *
 *   HOME=/tmp/sandbox/home npx tsx src/cli.ts --port 3177 --cwd /tmp/sandbox/project
 *   CLAUDE_AGENT_UI_PORT=3177 npx vite --port 5274
 *   node scripts/shoot-definitions.mjs /tmp/shots 5274
 */
import { chromium } from "playwright";
import path from "node:path";

const out = process.argv[2] ?? ".";
const port = process.argv[3] ?? "5274";
const base = `http://127.0.0.1:${port}`;
const shot = (name) => path.join(out, `${name}.png`);

const browser = await chromium.launch({ channel: "chrome" });
const errors = [];

async function capture(name, { theme = "dark", url = "/", width = 1440, height = 900, before } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme === "light" ? "light" : "dark",
  });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));

  await page.goto(base + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  if (before) {
    await before(page);
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: shot(name) });
  console.log(`${name}  ${width}x${height} ${theme}`);
  await context.close();
}

const pick = (name) => (page) =>
  page
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();

// --- Agents ---------------------------------------------------------------------------
await capture("01-agents-dark", { url: "/agents" });
await capture("02-agents-light", { url: "/agents", theme: "light" });
await capture("03-agent-selected-dark", { url: "/agents", before: pick("release-notes") });
await capture("04-agent-selected-light", { url: "/agents", theme: "light", before: pick("release-notes") });
// An agent whose frontmatter does not parse: the warning in the list, the named field in the
// editor, and Run now disabled because the server would refuse it.
await capture("05-agent-invalid-dark", { url: "/agents", before: pick("broken-yaml") });
// The allowlist case, including a name that matches nothing on disk.
await capture("06-agent-allowlist-dark", { url: "/agents", before: pick("flaky-test-triage") });
// Inline validation while typing: break the name, do not save.
await capture("07-agent-typing-error-dark", {
  url: "/agents",
  before: async (page) => {
    await page
      .getByRole("button", { name: /release-notes/ })
      .first()
      .click();
    await page.waitForTimeout(400);
    const editor = page.getByLabel("File contents");
    await editor.fill("---\nname: Not A Valid Name\ndescription:\n---\n\n# Release notes\n");
    await page.waitForTimeout(900);
  },
});
await capture("08-agent-new-light", {
  url: "/agents",
  theme: "light",
  before: (page) =>
    page
      .getByRole("button", { name: /New agent/ })
      .first()
      .click(),
});
await capture("09-agent-run-now-dark", {
  url: "/agents",
  before: async (page) => {
    await page
      .getByRole("button", { name: /release-notes/ })
      .first()
      .click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Run now" }).click();
  },
});
await capture("10-agent-bypass-confirm-dark", {
  url: "/agents",
  before: async (page) => {
    await page
      .getByRole("button", { name: /release-notes/ })
      .first()
      .click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Run now" }).click();
    await page.waitForTimeout(400);
    // click(), not check(): the radio deliberately does not commit on the click — the
    // confirmation below it is what sets the mode, so its state has not changed yet.
    await page.getByLabel("Bypass permission prompts").click();
  },
});

// --- Skills ---------------------------------------------------------------------------
await capture("11-skills-dark", { url: "/skills" });
await capture("12-skills-light", { url: "/skills", theme: "light" });
await capture("13-skill-plugin-readonly-dark", { url: "/skills", before: pick("incident-drill") });
await capture("14-skill-plugin-readonly-light", { url: "/skills", theme: "light", before: pick("incident-drill") });
await capture("15-skill-delete-confirm-dark", {
  url: "/skills",
  before: async (page) => {
    await page
      .getByRole("button", { name: /changelog/ })
      .first()
      .click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: /Delete changelog/ }).click();
  },
});

// --- Keyboard and narrow width ---------------------------------------------------------
await capture("16-skills-focus-ring-dark", {
  url: "/skills",
  before: async (page) => {
    for (let i = 0; i < 7; i++) await page.keyboard.press("Tab");
  },
});
await capture("17-agents-mobile-dark", { url: "/agents", width: 390, height: 844 });
await capture("18-skills-mobile-detail-light", {
  url: "/skills",
  theme: "light",
  width: 390,
  height: 844,
  before: pick("incident-drill"),
});

await browser.close();

if (errors.length) {
  console.error(`\n${errors.length} console errors:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("\nno console errors");
