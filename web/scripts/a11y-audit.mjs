#!/usr/bin/env node
/**
 * Accessibility audit over the running app. Dev tool, not shipped.
 *
 * check-contrast.mjs proves the *token* pairs are AA. This proves the rendered page: that every
 * interactive element is reachable by Tab, that focus is always visible, that dialogs trap focus
 * and give it back, that no state is signalled by colour alone, and that reduced motion is
 * honoured. Those are properties of the DOM, so they can only be checked against a real one.
 *
 * Needs the dev server (vite, not the real server — from the repo root):
 *   npm run web:dev &
 *   npm --prefix web run check:a11y
 *
 * The mock API is this script's own: it starts `mock-api.mjs` on the port vite proxies to, and
 * restarts it per scenario (section 5). So port 3000 must be free — a mock you started yourself
 * would make the empty/error section audit whatever scenario *that* one was launched with, which
 * is the hole this arrangement closes. A taken port is refused, not worked around: startMock()
 * waits for its own child's ready line, so a squatter surfaces as that child's EADDRINUSE exit.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = "http://127.0.0.1:5174";
const SCREENS = ["/agents", "/skills", "/tasks", "/schedule"];

/** Must match vite.config.ts's proxy target, which reads the same variable. */
const MOCK_PORT = Number(process.env.CLAUDE_AGENT_UI_PORT ?? 3000);
const MOCK_SCRIPT = fileURLToPath(new URL("./mock-api.mjs", import.meta.url));

const findings = [];
const fail = (screen, check, detail) => findings.push({ screen, check, detail });

/* ---------------------------------------------------------------------------------------
 * The mock, under this script's control.
 *
 * Section 5 is the reason. A scenario is fixed when mock-api.mjs starts, so "render the empty
 * state" means "run this screen against a mock that was started with --scenario empty" — there
 * is no query parameter or header that switches it, and inventing one would mean the audit
 * exercised a code path the app does not otherwise have.
 * ------------------------------------------------------------------------------------ */
let mock = null;

async function stopMock() {
  if (!mock) return;
  const child = mock;
  mock = null;
  // A child that is already gone — crashed, or killed by the port guard below — never emits
  // `exit` again. Node emits it once, and a listener added afterwards simply never runs, so
  // awaiting one here would wedge the audit on a corpse instead of ending it.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  // And one that refuses SIGTERM must not wedge it either: this is teardown, nothing downstream
  // depends on a graceful close, and the `process.on("exit")` SIGKILL is still the backstop.
  await Promise.race([ended, new Promise((r) => setTimeout(r, 5_000).unref())]);
}

async function startMock(scenario) {
  await stopMock();
  const child = spawn(process.execPath, [MOCK_SCRIPT, "--port", String(MOCK_PORT), "--scenario", scenario], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  // Wait for *this child's* ready line, not for an answer on the port. A mock the caller already
  // started answers a probe exactly as well as ours does, and the audit would then run against
  // whatever scenario that one was launched with — the hole section 5 exists to close. Waiting on
  // the line means a taken port can only arrive here as the EADDRINUSE exit handled below.
  await new Promise((resolve, reject) => {
    let stdout = "";
    const settle = (fn, arg) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      fn(arg);
    };
    const onData = (chunk) => {
      stdout += chunk;
      if (stdout.includes(`on http://127.0.0.1:${MOCK_PORT}`)) settle(resolve);
    };
    const onExit = (code, signal) =>
      settle(
        reject,
        new Error(
          `mock API (--scenario ${scenario}) exited with ${signal ?? code ?? 0} before it was ready. Port ` +
            `${MOCK_PORT} is most likely already taken — this script starts its own mock, so stop yours ` +
            `and re-run.` +
            (stderr.trim() ? `\n${stderr.trim()}` : ""),
        ),
      );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(reject, new Error(`mock API (--scenario ${scenario}) was not ready on port ${MOCK_PORT} within 10s.`));
    }, 10_000);

    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });

  // Keep draining stdout; a full pipe buffer would block the mock mid-request.
  child.stdout.resume();
  mock = child;
}

// A killed browser or a thrown finding must not leave the mock holding the port.
process.on("exit", () => mock?.kill("SIGKILL"));

// vite is the one thing the caller still has to start, so say so in a sentence rather than
// letting playwright report ERR_CONNECTION_REFUSED from inside page.goto().
try {
  await fetch(base);
} catch {
  // `npm run web:dev`, never `npm run dev`: at the repo root that one is the real server, which
  // defaults to port 3000 and would then be the squatter startMock() refuses to run against.
  console.error(`Nothing is serving ${base}. Start the dev server first:\n\n  npm run web:dev\n`);
  process.exit(2);
}

await startMock("populated");
const browser = await chromium.launch({ channel: "chrome" });

async function withPage(opts, fn) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    colorScheme: opts.theme ?? "dark",
    reducedMotion: opts.reducedMotion,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(base + (opts.url ?? "/"), { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  try {
    await fn(page, consoleErrors);
  } finally {
    await context.close();
  }
  return consoleErrors;
}

/** Everything a keyboard user should be able to land on, in DOM order. */
const INTERACTIVE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* ---------------------------------------------------------------------------------------
 * 1. Keyboard reachability + visible focus, per screen.
 * ------------------------------------------------------------------------------------ */
for (const url of SCREENS) {
  await withPage({ url }, async (page, consoleErrors) => {
    // What the DOM says should be reachable...
    const expected = await page.$$eval(INTERACTIVE, (els) =>
      els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          // Offscreen-but-focusable (the skip link) counts; display:none does not.
          return cs.display !== "none" && cs.visibility !== "hidden" && (r.width > 0 || r.height > 0);
        })
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}:${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40)}`,
        ),
    );

    // ...and what Tab actually reaches.
    const reached = [];
    const focusRingMisses = [];
    await page.evaluate(() => document.body.focus());
    for (let i = 0; i < expected.length + 12; i += 1) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
        const ring = cs.boxShadow !== "none";
        const bordered = cs.borderColor !== cs.backgroundColor;
        return {
          key: `${el.tagName.toLowerCase()}:${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40)}`,
          visible: outline || ring || bordered,
          outlineWidth: cs.outlineWidth,
          outlineColor: cs.outlineColor,
        };
      });
      if (!info) break;
      if (reached.includes(info.key) && reached[0] === info.key) break; // wrapped around
      reached.push(info.key);
      if (!info.visible) focusRingMisses.push(info.key);
    }

    const unreachable = expected.filter((e) => !reached.includes(e));
    if (unreachable.length) fail(url, "keyboard-reachable", `not reached by Tab: ${unreachable.join(", ")}`);
    if (focusRingMisses.length) fail(url, "focus-visible", `no visible focus: ${focusRingMisses.join(", ")}`);
    if (consoleErrors.length) fail(url, "console", consoleErrors.join(" | "));

    // Accessible name on every control.
    const unnamed = await page.$$eval(INTERACTIVE, (els) =>
      els
        .filter((el) => {
          const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
          const labelled =
            el.getAttribute("aria-labelledby") || (el.id && document.querySelector(`label[for="${el.id}"]`));
          return !name && !labelled;
        })
        .map((el) => el.outerHTML.slice(0, 120)),
    );
    if (unnamed.length) fail(url, "accessible-name", unnamed.join(" | "));
  });
}

/* ---------------------------------------------------------------------------------------
 * 2. No colour-only state. Every status badge must carry a word.
 * ------------------------------------------------------------------------------------ */
for (const url of SCREENS) {
  await withPage({ url }, async (page) => {
    const bare = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("span, div")) {
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        // A tinted chip with no text is the failure mode we are hunting.
        if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.width > 320 || r.height > 40) continue;
        if (el.children.length > 2) continue;
        if (el.textContent.trim()) continue;
        // Decoration is exempt, but only when it is declared as such: `aria-hidden` means it
        // carries no information, so it cannot be the sole carrier of any. The brand dot and
        // the sidebar's active marker are this; the marker's state is also on `aria-current`.
        if (el.closest('[aria-hidden="true"]')) continue;
        // A control that exposes its own state to the platform is not colour-only: a `switch`
        // reports checked/unchecked, and moves its thumb. (The schedule rows additionally
        // print "Disabled — will not fire" next to it.)
        if (el.parentElement?.querySelector('[role="switch"], input[type="checkbox"], input[type="radio"]')) continue;
        out.push(`${el.className} ${bg} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    });
    if (bare.length) fail(url, "colour-only", bare.join(" | "));
  });
}

/* ---------------------------------------------------------------------------------------
 * 3. Dialogs: focus trap, Escape, and focus restored to the opener.
 * ------------------------------------------------------------------------------------ */
const DIALOGS = [
  { url: "/tasks", open: /new task/i, name: "New task" },
  { url: "/schedule", open: /new schedule/i, name: "New schedule" },
];

for (const d of DIALOGS) {
  await withPage({ url: d.url }, async (page) => {
    const opener = page.getByRole("button", { name: d.open }).first();
    if (!(await opener.count())) return fail(d.url, "dialog", `no opener matching ${d.open}`);
    const openerKey = await opener.evaluate((el) => el.textContent.trim());
    await opener.click();
    await page.waitForTimeout(400);

    const dialog = page.getByRole("dialog");
    if (!(await dialog.count())) return fail(d.url, "dialog", `${d.name} did not open`);

    // Focus must have moved inside the panel.
    const inside = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"], [role="alertdialog"]');
      return dlg?.contains(document.activeElement) ?? false;
    });
    if (!inside) fail(d.url, "dialog-focus", `${d.name}: focus did not enter the panel`);

    // Tab 25 times; focus must never leave the panel.
    let escaped = null;
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      const still = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"], [role="alertdialog"]');
        const el = document.activeElement;
        return {
          in: dlg?.contains(el) ?? false,
          at: `${el?.tagName}:${(el?.getAttribute("aria-label") || el?.textContent || "").trim().slice(0, 30)}`,
        };
      });
      if (!still.in) {
        escaped = still.at;
        break;
      }
    }
    if (escaped) fail(d.url, "dialog-trap", `${d.name}: focus escaped to ${escaped}`);

    // Escape closes, and focus goes back to the button that opened it.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    if (await page.getByRole("dialog").count()) fail(d.url, "dialog-escape", `${d.name}: Escape did not close`);
    const restored = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "<body>");
    if (restored !== openerKey) {
      fail(d.url, "dialog-restore", `${d.name}: focus went to "${restored}", expected "${openerKey}"`);
    }
  });
}

/* ---------------------------------------------------------------------------------------
 * 4. prefers-reduced-motion: nothing may animate.
 * ------------------------------------------------------------------------------------ */
await withPage({ url: "/tasks", reducedMotion: "reduce" }, async (page) => {
  const moving = await page.evaluate(() =>
    [...document.querySelectorAll("*")]
      .filter((el) => {
        const cs = getComputedStyle(el);
        const dur = (s) => s.split(",").some((v) => parseFloat(v) > 0.05);
        return (cs.animationName !== "none" && dur(cs.animationDuration)) || dur(cs.transitionDuration);
      })
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80)),
  );
  if (moving.length) fail("/tasks", "reduced-motion", moving.join(" | "));
});

/* ---------------------------------------------------------------------------------------
 * 5. Empty / loading / error states exist and carry copy, on all four screens.
 * ------------------------------------------------------------------------------------ */
/** What each screen must actually say when its list comes back empty. */
const EMPTY_COPY = {
  "/agents": "No agents found",
  "/skills": "No skills found",
  "/tasks": "No tasks yet",
  "/schedule": "No schedules yet",
};

await startMock("empty");
for (const url of SCREENS) {
  await withPage({ url }, async (page) => {
    const main = page.locator("main");
    // "Not blank" is what the old version checked, and it passed against a populated mock too.
    // The copy is what distinguishes an empty state from a list that happens to have rows.
    try {
      await main.getByText(EMPTY_COPY[url], { exact: false }).first().waitFor({ timeout: 15_000 });
    } catch {
      const text = (await main.innerText()).trim();
      fail(url, "empty-state", `main does not say "${EMPTY_COPY[url]}"; it says: ${text.slice(0, 160)}`);
    }
    // An empty state is a message *and* an action (ux-guidelines No. 79), and the action has to
    // be reachable, so it is a real control rather than a sentence.
    if (!(await main.locator("button, a[href]").count())) {
      fail(url, "empty-state", "nothing actionable in main");
    }
  });
}

await startMock("error");
for (const url of SCREENS) {
  await withPage({ url }, async (page) => {
    // ErrorState is the only thing on these screens with role="alert", which is also what makes
    // the failure audible rather than only visible.
    //
    // Waited for, not sampled: a 500 is retried twice before the query gives up (queryClient.ts),
    // and the screen is legitimately still a skeleton during the backoff — which has no network
    // traffic, so `networkidle` resolves right through the middle of it.
    const alert = page.locator('main [role="alert"]').first();
    try {
      await alert.waitFor({ timeout: 20_000 });
    } catch {
      const text = (await page.locator("main").innerText()).trim();
      return fail(url, "error-state", `no role="alert" in main; it says: ${text.slice(0, 160)}`);
    }
    const said = (await alert.innerText()).trim();
    if (said.length < 20) fail(url, "error-state", `the alert says only "${said}"`);
    // The server's message has to survive to the screen; a generic "something went wrong" hides
    // the one sentence the user could act on.
    if (!/EACCES|could not be read/i.test(said)) {
      fail(url, "error-state", `the alert does not carry the server's message: ${said.slice(0, 160)}`);
    }
  });
}

await browser.close();
await stopMock();

if (findings.length === 0) {
  console.log("a11y audit: no findings.");
} else {
  console.log(`a11y audit: ${findings.length} finding(s)\n`);
  for (const f of findings) console.log(`  [${f.screen}] ${f.check}\n      ${f.detail}\n`);
}
process.exit(findings.length ? 1 : 0);
