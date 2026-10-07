#!/usr/bin/env node
/**
 * Renders the Schedule screen at a real viewport in both themes and writes PNGs. Dev tool,
 * not shipped.
 *
 * Pointed at the **real** server started against a throwaway HOME, not at the mock: the states
 * that matter here — a suppressed fire, a fire that could not be queued, a real `nextFireAt`
 * computed by croner in a non-UTC zone — are the server's behaviour, and a mock reproducing
 * them would only be proving that the mock agrees with itself.
 *
 *   TMPDIR=/tmp/short HOME=/tmp/sandbox/home npx tsx src/cli.ts --port 3177 --cwd /tmp/sandbox/project --no-open
 *   CLAUDE_AGENT_UI_PORT=3177 npx vite --port 5274
 *   node scripts/shoot-schedules.mjs /tmp/shots 5274
 */
import { chromium } from "playwright";
import path from "node:path";

const out = process.argv[2] ?? ".";
const port = process.argv[3] ?? "5274";
const base = `http://127.0.0.1:${port}`;
const shot = (name) => path.join(out, `${name}.png`);

const browser = await chromium.launch({ channel: "chrome" });
const errors = [];

async function capture(name, { theme = "dark", url = "/schedule", width = 1440, height = 900, before } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme === "light" ? "light" : "dark",
  });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));

  await page.goto(base + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  if (before) {
    await before(page);
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: shot(name) });
  console.log(`${name}  ${width}x${height} ${theme}`);
  await context.close();
}

// --- The table, both themes ---------------------------------------------------------------
await capture("s01-schedule-dark");
await capture("s02-schedule-light", { theme: "light" });

// --- A row expanded: the task template this schedule enqueues ------------------------------
await capture("s03-expanded-dark", {
  before: (p) => p.getByRole("button", { name: "Hourly changelog tidy", exact: true }).click(),
});

// --- The form, empty and filled ------------------------------------------------------------
await capture("s04-new-schedule-dark", {
  before: (p) => p.getByRole("button", { name: "New schedule" }).first().click(),
});
await capture("s05-new-schedule-light", {
  theme: "light",
  before: (p) => p.getByRole("button", { name: "New schedule" }).first().click(),
});
// Editing: the stored values, and the plain-English preview under the cron field.
await capture("s06-edit-schedule-dark", {
  before: (p) => p.getByRole("button", { name: /Edit Weekday release notes/ }).click(),
});
// A pattern the describer refuses: the help text says so rather than inventing a sentence.
await capture("s07-cron-unknown-pattern-dark", {
  before: async (p) => {
    await p.getByRole("button", { name: "New schedule" }).first().click();
    await p.waitForTimeout(300);
    await p.getByLabel("Cron expression").fill("0 9 1 * 1");
  },
});

// --- Run once now, suppressed. The whole point of the screen. ------------------------------
// The previous task from this schedule is still running, so the fire is refused — with a 200
// and a reason, which the row has to render as the answer it is and not as a failure.
// Two presses: the first enqueues, the second is refused while that task is still live. The
// second press is the shot.
await capture("s08-run-now-suppressed-dark", {
  before: async (p) => {
    const button = p.getByRole("button", { name: /Run Weekday release notes once now/ });
    await button.click();
    await p.waitForTimeout(700);
    await button.click();
    await p.waitForTimeout(700);
  },
});
await capture("s08b-run-now-queued-light", {
  theme: "light",
  before: async (p) => {
    await p.getByRole("button", { name: /Run Hourly changelog tidy once now/ }).click();
    await p.waitForTimeout(700);
  },
});

// --- The delete confirmation ----------------------------------------------------------------
await capture("s09-delete-confirm-light", {
  theme: "light",
  before: (p) => p.getByRole("button", { name: /Delete Monthly advisory sweep/ }).click(),
});

// --- Keyboard only: focus the row's controls and photograph the ring ------------------------
await capture("s10-focus-toggle-dark", {
  before: (p) => p.getByRole("switch", { name: /Nightly dependency audit/ }).focus(),
});
await capture("s11-focus-run-now-light", {
  theme: "light",
  before: (p) => p.getByRole("button", { name: /Run Nightly dependency audit once now/ }).focus(),
});

// --- Responsive ------------------------------------------------------------------------------
await capture("s12-schedule-mobile-dark", { width: 390, height: 844 });
await capture("s13-schedule-mobile-light", { theme: "light", width: 390, height: 844 });

console.log(`\n${errors.length ? `${errors.length} console errors:\n${errors.join("\n")}` : "no console errors"}`);
await browser.close();
process.exit(errors.length ? 1 : 0);
