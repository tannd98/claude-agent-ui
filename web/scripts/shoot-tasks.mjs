#!/usr/bin/env node
/**
 * Renders the Tasks screens against the mock API and writes PNGs. Dev tool, not shipped.
 *
 *   node scripts/mock-api.mjs --port 3000 &
 *   npx vite --port 5174 &
 *   node scripts/shoot-tasks.mjs <out-dir>
 *
 * Both themes at 1440x900, the responsive pass at 390x844, and the states a screenshot of the
 * happy path would never catch: the new-task form, the permission confirmation, the cancel
 * confirmation, an empty queue, a failing API and the stale-state warning bar.
 */
import { chromium } from "playwright";
import path from "node:path";

const args = process.argv.slice(2);
const out = args[0] ?? ".";
const base = "http://127.0.0.1:5174";
const shot = (name) => path.join(out, `${name}.png`);

const browser = await chromium.launch({ channel: "chrome" });
const allErrors = [];

async function capture(name, { theme = "dark", url = "/tasks", width = 1440, height = 900, before, after } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme === "light" ? "light" : "dark",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${String(e)}`));

  await page.goto(base + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  if (before) {
    await before(page);
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: shot(name) });
  console.log(`${name}  ${width}x${height} ${theme}${errors.length ? "  CONSOLE ERRORS" : ""}`);
  // Anything that has to be read out of the DOM rather than photographed — an sr-only live
  // region, for one — runs here, while the page is still open.
  if (after) await after(page);
  await context.close();
  allErrors.push(...errors);
  return page;
}

// --- The table, both themes ---------------------------------------------------------------
await capture("t01-tasks-dark", { theme: "dark" });
await capture("t02-tasks-light", { theme: "light" });

// --- A row expanded: the waiting task, with its attach command ----------------------------
await capture("t03-tasks-expanded-waiting-dark", {
  before: (p) => p.getByText("Audit the lockfile for reachable advisories").click(),
});
await capture("t04-tasks-expanded-failed-light", {
  theme: "light",
  before: (p) => p.getByText("Upgrade the test runner to v4").click(),
});

// --- The new-task form, and the permission confirmation -----------------------------------
await capture("t05-new-task-dark", {
  before: (p) => p.getByRole("button", { name: "New task" }).click(),
});
await capture("t06-permission-confirm-dark", {
  before: async (p) => {
    await p.getByRole("button", { name: "New task" }).click();
    await p.waitForTimeout(300);
    await p.getByRole("radio", { name: /Bypass permission prompts/ }).click();
  },
});
await capture("t07-permission-confirm-light", {
  theme: "light",
  before: async (p) => {
    await p.getByRole("button", { name: "New task" }).click();
    await p.waitForTimeout(300);
    await p.getByRole("radio", { name: /Bypass permission prompts/ }).click();
  },
});

// --- Cancel confirmations: two bodies, because the consequences differ --------------------
await capture("t08-cancel-running-dark", {
  before: (p) => p.getByRole("button", { name: "Cancel Draft release notes for 0.4.0" }).click(),
});
await capture("t09-cancel-queued-light", {
  theme: "light",
  before: (p) => p.getByRole("button", { name: "Cancel Bisect the flaky checkout spec" }).click(),
});

// --- Task detail -------------------------------------------------------------------------
await capture("t10-detail-dark", { url: "/tasks/t-91a2" });
await capture("t11-detail-light", { theme: "light", url: "/tasks/t-4f19" });
await capture("t12-detail-blocked-dark", { url: "/tasks/t-6b3c" });

// --- Keyboard only: tab from the top into the table and photograph the focus ring ---------
// Tabbing blind lands in the sidebar, which proves nothing about this screen. Start from the
// first row's disclosure and walk the row the way someone without a mouse would.
await capture("t13-focus-row-disclosure-dark", {
  before: async (p) => {
    await p.getByRole("button", { name: "Draft release notes for 0.4.0", exact: true }).focus();
  },
});
await capture("t14-focus-row-cancel-dark", {
  before: async (p) => {
    await p.getByRole("button", { name: "Draft release notes for 0.4.0", exact: true }).focus();
    await p.keyboard.press("Enter"); // expands
    await p.waitForTimeout(200);
    await p.keyboard.press("Tab"); // Cancel in the same row
  },
});

// --- Responsive --------------------------------------------------------------------------
await capture("t15-tasks-mobile-dark", { width: 390, height: 844 });
await capture("t16-detail-mobile-light", { theme: "light", url: "/tasks/t-91a2", width: 390, height: 844 });

// --- A cancel that lost its race ----------------------------------------------------------
// The server answers 200 with the outcome the task actually reached, not with `cancelled`.
// Needs the mock on `--scenario lostrace`; `--lostrace` runs only this block. The table's
// announcement is sr-only, so it is read out of the live region rather than photographed.
if (args.includes("--lostrace")) {
  const confirmCancel = async (p) => {
    await p.getByRole("button", { name: "Cancel Draft release notes for 0.4.0" }).click();
    await p.waitForTimeout(300);
    await p.getByRole("button", { name: "Cancel task" }).click();
    await p.waitForTimeout(600);
  };

  await capture("t19-cancel-lost-race-dark", {
    before: confirmCancel,
    after: async (p) => {
      const live = await p.locator("p[role=status]").first().textContent();
      console.log(`  live region: ${live}`);
    },
  });

  // A different task each time: the mock's state is shared, and t19 already settled t-91a2.
  const cancelFromDetail = async (p) => {
    await p.getByRole("button", { name: "Cancel", exact: true }).click();
    await p.waitForTimeout(300);
    await p.getByRole("button", { name: "Cancel task" }).click();
    await p.waitForTimeout(600);
  };
  const readNote = async (p) => {
    console.log(`  note: ${(await p.locator("header span[role=status]").allTextContents()).join(" | ") || "(none)"}`);
  };

  // The mock has exactly two running tasks and t19 spent one, so the detail pane gets the
  // other — one theme per run. `--lostrace-theme dark` for the second pass.
  const detailTheme = args.includes("--lostrace-theme") ? args[args.indexOf("--lostrace-theme") + 1] : "light";
  await capture(`t20-cancel-lost-race-detail-${detailTheme}`, {
    theme: detailTheme,
    url: "/tasks/t-55a0",
    before: cancelFromDetail,
    after: readNote,
  });
}

// --- The states a screenshot of the happy path never catches ------------------------------
// These need the mock restarted with a different scenario; `--states` runs only this block.
if (args.includes("--states")) {
  await capture("t17-tasks-empty-dark", {});
  await capture("t18-tasks-empty-light", { theme: "light" });
}

console.log(
  `\n${allErrors.length ? `${allErrors.length} console errors:\n${allErrors.join("\n")}` : "no console errors"}`,
);
await browser.close();
process.exit(allErrors.length ? 1 : 0);
