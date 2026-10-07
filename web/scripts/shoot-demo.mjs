#!/usr/bin/env node
/**
 * Records the README demo: a real browser driving the real client against scripts/mock-api.mjs.
 *
 * Synthetic throughout — the mock serves invented agents, prompts and paths, so nothing from the
 * machine that records it ends up in a file we publish.
 *
 * Dev tool. In neither bundle, and the GIF it produces is not in the npm tarball either
 * (package.json ships "files": ["dist"]); it is there for the README on the repo page.
 *
 *   node scripts/mock-api.mjs --port 3000 &
 *   npm run dev &
 *   node scripts/shoot-demo.mjs ../docs/demo.gif
 *
 * Needs ffmpeg on PATH for the webm -> gif step, and playwright's own for the recording
 * (`npx playwright install ffmpeg`).
 *
 * CAU_DEMO_WEBM=<path> reuses an earlier recording instead of driving the browser again, which is
 * the difference between a 40-second loop and a 2-second one when tuning the encode. The script
 * writes the recording there on a normal run.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const target = path.resolve(process.argv[2] ?? "demo.gif");
const base = "http://127.0.0.1:5174";

// 1280x800 keeps the four-column task table readable once the GIF is scaled down for the README.
const VIEWPORT = { width: 1280, height: 800 };
/** Frames per second in the finished GIF. Low enough to keep it small, high enough to not stutter. */
const FPS = 12;
/** Width the GIF is scaled to. GitHub renders README images at roughly this, so there is no point
 *  shipping the pixels above it. */
const GIF_WIDTH = 760;
/**
 * A GIF in a README is downloaded by everyone who opens the page, so the budget is a hard one.
 * This UI is flat panels and a handful of accent hues, so a cut palette costs nothing visible —
 * at 900px, 256 colours and full dithering the same clip was 5.2MB; this is 2.3MB.
 */
const MAX_COLORS = 64;

const work = mkdtempSync(path.join(tmpdir(), "cau-demo-"));
const reuse = process.env.CAU_DEMO_WEBM;

/** A pause long enough for a human eye to land on what just changed and read it. */
const beat = (page, ms = 1_600) => page.waitForTimeout(ms);

/** Drives the browser and returns the path of the recording. */
async function record() {
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "dark",
    // Recorded at the viewport size: a deviceScaleFactor would be thrown away by the GIF scale.
    recordVideo: { dir: work, size: VIEWPORT },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  // 1. The queue, which is the thing this app is.
  await page.goto(`${base}/tasks`, { waitUntil: "networkidle" });
  await beat(page, 2_000);

  // 2. Queue a task. Typed rather than filled, because a GIF of a form being filled instantly
  //    reads as a screenshot slideshow.
  await page
    .getByRole("button", { name: /new task/i })
    .first()
    .click();
  await beat(page, 900);
  await page.getByLabel(/^agent$/i).selectOption({ label: "release-notes" });
  await beat(page, 600);
  await page.getByLabel(/^prompt$/i).type("Draft the release notes for 0.1.0 from the commits since the last tag.", {
    delay: 22,
  });
  await beat(page, 900);

  // 3. The permission choice, scrolled into view: it is the one control worth understanding
  //    before you use this, and "Ask before each tool" is where it starts. The dialog body
  //    scrolls, so this is below the fold until something asks for it.
  await page.getByRole("radio", { name: /bypass permission prompts/i }).scrollIntoViewIfNeeded();
  await beat(page, 2_600);

  await page.getByRole("button", { name: /add to queue/i }).click();
  await beat(page, 2_000);

  // 4. Schedules: the same queue, fed by cron.
  await page.getByRole("link", { name: /schedule/i }).click();
  await page.waitForLoadState("networkidle");
  await beat(page, 2_600);

  // 5. Agents: the definitions on disk, editable in place.
  await page.getByRole("link", { name: /^agents$/i }).click();
  await page.waitForLoadState("networkidle");
  await beat(page, 1_200);
  await page.getByText("release-notes", { exact: true }).first().click();
  await beat(page, 2_600);

  await context.close();
  await browser.close();
  if (errors.length) throw new Error(`console errors during the recording:\n${errors.join("\n")}`);

  const webm = readdirSync(work)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => path.join(work, f))[0];
  if (!webm) throw new Error("playwright produced no video");
  return webm;
}

try {
  const webm = reuse && existsSync(reuse) ? reuse : await record();
  // Recorded this run but asked to cache it: leave it where the next tuning pass will find it.
  if (reuse && webm !== reuse) copyFileSync(webm, reuse);

  // Two passes: one palette for the whole clip, then apply it. A per-frame palette is what makes
  // naive gifs flicker, and this UI is mostly flat dark panels where that would be obvious.
  const palette = path.join(work, "palette.png");
  const filters = `fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  mkdirSync(path.dirname(target), { recursive: true });
  execFileSync(
    "ffmpeg",
    ["-y", "-i", webm, "-vf", `${filters},palettegen=stats_mode=diff:max_colors=${MAX_COLORS}`, palette],
    { stdio: "inherit" },
  );
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      webm,
      "-i",
      palette,
      "-lavfi",
      // No dithering: a dither pattern is per-pixel noise that defeats the inter-frame delta
      // below, and on flat panels there is no gradient for it to rescue. It cost 1.3MB here.
      `${filters} [x]; [x][1:v] paletteuse=dither=none:diff_mode=rectangle`,
      "-loop",
      "0",
      target,
    ],
    { stdio: "inherit" },
  );
  console.log(`wrote ${target}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
