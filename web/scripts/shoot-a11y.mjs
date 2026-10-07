#!/usr/bin/env node
/**
 * The M7 render pass: four screens x two themes x two viewports, plus the states that only
 * exist transiently. Dev tool, not shipped.
 *
 *   node scripts/mock-api.mjs --port 3000 &
 *   npm run dev &
 *   node scripts/shoot-a11y.mjs <outdir>
 */
import { chromium } from "playwright";
import path from "node:path";

const out = process.argv[2] ?? ".";
const base = "http://127.0.0.1:5174";
const browser = await chromium.launch({ channel: "chrome" });

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

async function capture(name, { url = "/", theme = "dark", viewport = DESKTOP, before, full = false }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  if (before) {
    await before(page);
    await page.waitForTimeout(450);
  }
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: full });
  console.log(
    `${name.padEnd(34)} ${viewport.width}x${viewport.height} ${theme}${errors.length ? `  ERRORS: ${errors.join(" | ")}` : ""}`,
  );
  await context.close();
}

const SCREENS = [
  ["agents", "/agents"],
  ["skills", "/skills"],
  ["tasks", "/tasks"],
  ["schedule", "/schedule"],
];

// Four screens, both themes, desktop.
for (const [name, url] of SCREENS) {
  await capture(`${name}-dark-1440`, { url, theme: "dark" });
  await capture(`${name}-light-1440`, { url, theme: "light" });
}

// Four screens, both themes, mobile.
for (const [name, url] of SCREENS) {
  await capture(`${name}-dark-390`, { url, theme: "dark", viewport: MOBILE });
  await capture(`${name}-light-390`, { url, theme: "light", viewport: MOBILE });
}

// Focus rings: tab to the first nav item and to a table row action.
await capture("focus-sidebar-dark-1440", {
  url: "/tasks",
  before: async (p) => {
    await p.keyboard.press("Tab");
    await p.keyboard.press("Tab");
  },
});
await capture("focus-sidebar-light-1440", {
  url: "/tasks",
  theme: "light",
  before: async (p) => {
    await p.keyboard.press("Tab");
    await p.keyboard.press("Tab");
  },
});
await capture("focus-skiplink-dark-1440", {
  url: "/tasks",
  before: (p) => p.keyboard.press("Tab"),
});

// Dialogs, both themes and mobile.
await capture("dialog-newtask-dark-1440", {
  url: "/tasks",
  before: (p) =>
    p
      .getByRole("button", { name: /new task/i })
      .first()
      .click(),
});
await capture("dialog-newtask-light-1440", {
  url: "/tasks",
  theme: "light",
  before: (p) =>
    p
      .getByRole("button", { name: /new task/i })
      .first()
      .click(),
});
await capture("dialog-newtask-dark-390", {
  url: "/tasks",
  viewport: MOBILE,
  before: (p) =>
    p
      .getByRole("button", { name: /new task/i })
      .first()
      .click(),
});
await capture("dialog-newschedule-dark-1440", {
  url: "/schedule",
  before: (p) =>
    p
      .getByRole("button", { name: /new schedule/i })
      .first()
      .click(),
});

await browser.close();
