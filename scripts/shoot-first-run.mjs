/**
 * Fresh-install home shots.
 *
 * The state that matters most and is hardest to catch: a clean database, where
 * `GET /api/browse` correctly returns `{"rails":[]}` and the home page has
 * nothing real to show. Also shoots the failure path, because "empty" and
 * "broken" must not look alike — `/api/browse` is forced to 500 for those.
 *
 * The dev server on :3100 already has an empty DB, so the empty case needs no
 * fixture at all.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const OUT = process.env.SHOT_DIR ?? "qa-screens/after";

const CASES = [
  { name: "home-empty", fail: false },
  { name: "home-failed", fail: true },
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const problems = [];
const skipped = [];

for (const [vpName, width, height] of [
  ["desktop", 1440, 900],
  ["mobile", 390, 844],
]) {
  for (const scenario of CASES) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const tag = `${vpName}/${scenario.name}`;
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    if (scenario.fail) {
      await page.route("**/api/browse*", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Failed to build browse payload" }),
        }),
      );
    }

    await page.goto(`${BASE}/${scenario.fail ? "?forceBrowseError=1" : ""}`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForTimeout(2500);
    await page.screenshot({
      path: join(OUT, `${vpName}-${scenario.name}.png`),
      fullPage: true,
    });

    const seen = await page.evaluate(() => ({
      empty: Boolean(document.querySelector("[data-browse-empty]")),
      error: Boolean(document.querySelector("[data-error-state]")),
      board: Boolean(document.querySelector("[data-browse-board]")),
      rails: document.querySelectorAll("[data-rail]").length,
      text: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
      overflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));

    console.log(`\n=== ${tag} ===`);
    console.log(JSON.stringify(seen, null, 1));

    // Both scenarios here describe a library with nothing in it. The page is
    // server-rendered and only hands off to the client island in that case, so
    // against a populated database neither state is reachable: the server call
    // is in-process and route interception cannot touch it. That precondition
    // is ambient, so it is reported as a distinct SKIP — a red gate caused by
    // data alone gets ignored, and a silent pass would be worse still.
    if (seen.board) {
      skipped.push(
        `${tag}: server rendered the populated board — needs an empty library to assert against`,
      );
      await context.close();
      continue;
    }

    if (seen.overflow > 1) problems.push(`${tag}: horizontal overflow ${seen.overflow}px`);
    if (consoleErrors.length) {
      // The forced-failure case *is* a 500; the browser reporting it is not a
      // defect. Anything else is.
      const unexpected = consoleErrors.filter(
        (e) => !(scenario.fail && /500 \(Internal Server Error\)/.test(e)),
      );
      if (unexpected.length) problems.push(`${tag}: console ${JSON.stringify(unexpected)}`);
    }
    if (scenario.fail) {
      if (!seen.error) problems.push(`${tag}: a failed /api/browse drew no error state`);
      if (seen.empty) problems.push(`${tag}: a failure rendered the EMPTY state`);
    } else {
      if (!seen.empty) problems.push(`${tag}: fresh install drew no first-run state`);
      if (seen.error) problems.push(`${tag}: an empty library rendered an ERROR state`);
    }

    await context.close();
  }
}

await browser.close();

if (skipped.length) {
  console.log(`\n${skipped.length} skipped (precondition not met):`);
  for (const s of skipped) console.log(" -", s);
}
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(" -", p);
  process.exit(1);
}
console.log(
  skipped.length ? "\nfirst-run home: no failures (all cases skipped)" : "\nfirst-run home clean",
);
