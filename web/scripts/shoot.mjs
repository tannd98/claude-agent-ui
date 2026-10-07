#!/usr/bin/env node
/** Renders the shell at a real viewport in both themes and writes PNGs. Dev tool, not shipped. */
import { chromium } from "playwright";
import path from "node:path";

const out = process.argv[2] ?? ".";
const base = "http://127.0.0.1:5174";
const shot = (name) => path.join(out, `${name}.png`);

// Use the installed Google Chrome rather than a downloaded build: this box has Chrome and
// the sandbox redirects Playwright's browser cache.
const browser = await chromium.launch({ channel: "chrome" });

async function capture(name, { theme, url = "/", width = 1440, height = 900, before }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme === "light" ? "light" : "dark",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(base + url, { waitUntil: "networkidle" });
  // The theme toggle defaults to "system", so colorScheme above decides it.
  await page.waitForTimeout(600);
  if (before) {
    await before(page);
    // Let the 150-250ms transitions settle, or the shot catches them mid-flight.
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: shot(name) });
  console.log(`${name}  ${width}x${height} ${theme}${errors.length ? `  CONSOLE ERRORS: ${errors.join(" | ")}` : ""}`);
  await context.close();
  return errors;
}

const allErrors = [];

allErrors.push(...(await capture("01-agents-dark", { theme: "dark", url: "/agents" })));
allErrors.push(...(await capture("02-agents-light", { theme: "light", url: "/agents" })));
allErrors.push(
  ...(await capture("03-agents-selected-dark", {
    theme: "dark",
    url: "/agents",
    before: (p) => p.getByRole("button", { name: /release-notes/ }).click(),
  })),
);
allErrors.push(...(await capture("04-tasks-dark", { theme: "dark", url: "/tasks" })));
allErrors.push(...(await capture("05-schedule-light", { theme: "light", url: "/schedule" })));

// Keyboard-only walkthrough: tab through the sidebar and photograph the focus ring.
allErrors.push(
  ...(await capture("06-focus-ring-dark", {
    theme: "dark",
    url: "/agents",
    before: async (p) => {
      await p.keyboard.press("Tab"); // skip link
      await p.keyboard.press("Tab"); // Agents
      await p.keyboard.press("Tab"); // Skills
      await p.keyboard.press("Tab"); // Tasks
    },
  })),
);
allErrors.push(
  ...(await capture("07-skip-link-light", {
    theme: "light",
    url: "/agents",
    before: (p) => p.keyboard.press("Tab"),
  })),
);

// The SSE proof: read the status bar, push an event from the mock, read it again.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${base}/agents`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  const bar = page.getByRole("contentinfo", { name: "System status" });
  const live = await bar.textContent();
  await page.screenshot({ path: shot("08-statusbar-before-sse") });

  await page.request.post("http://127.0.0.1:3000/__mock/start-run");
  await page.waitForTimeout(900);

  const after = await bar.textContent();
  await page.screenshot({ path: shot("09-statusbar-after-sse") });
  console.log(`SSE status bar: ${JSON.stringify(live)}  ->  ${JSON.stringify(after)}`);
  await context.close();
}

// 390x844 — the shell is not a phone app, but it must not be broken at phone width.
allErrors.push(...(await capture("10-agents-mobile-dark", { theme: "dark", url: "/agents", width: 390, height: 844 })));

await browser.close();

if (allErrors.length) {
  console.error(`\n${allErrors.length} console errors:\n${allErrors.join("\n")}`);
  process.exit(1);
}
console.log("\nno console errors");
