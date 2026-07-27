/**
 * Invariant 6, checked rather than asserted in a comment: a dead network must
 * never hang or crash the home page.
 *
 * Run it against a server started with **both** upstreams pointed at something
 * unreachable — `TMDB_BASE_URL` (the catalog) and `APIBAY_BASE_URL` (the
 * availability overlay) — and a `DATABASE_URL` holding no cached catalog rows.
 * Killing only one is not the test: the whole point of the two-source design
 * is that either can carry the page alone, so an outage of one is a *degraded
 * success* and would pass this script for the wrong reason.
 *
 * That is the genuinely worst case — a brand-new install with nothing cached
 * to fall back to — and it must still answer, quickly, with an honest error
 * and a retry rather than a spinner, a stack trace, or an essay about what the
 * page will one day contain.
 *
 * Run:
 *   $env:DATABASE_URL="file:./qa-dead.db"
 *   $env:APIBAY_BASE_URL="http://127.0.0.1:9"; $env:TMDB_BASE_URL="http://127.0.0.1:9"
 *   npx next start -p 3312
 *   $env:BASE_URL="http://127.0.0.1:3312"; node scripts/shoot-offline.mjs
 */
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import "dotenv/config";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3312";
const OUT = path.resolve(process.env.SHOT_DIR ?? "qa-screens/discovery");
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
function record(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

/** Long enough to be a real page load, short enough that a hang is a failure. */
const PATIENCE_MS = 45_000;

async function main() {
  const browser = await chromium.launch({ channel: "msedge" });
  const crashes = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => crashes.push(String(e)));

    console.log("── The home page with no network and no cache ──");
    const started = Date.now();
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: PATIENCE_MS });
    // The board settles asynchronously; give it room, but not forever.
    await page.waitForFunction(
      () => Boolean(document.querySelector("[data-browse-board], [data-browse-empty]")),
      undefined,
      { timeout: PATIENCE_MS },
    ).catch(() => {});
    const took = Date.now() - started;
    console.log(`  settled in ${took}ms`);

    record("a dead network does not hang the home page", took < PATIENCE_MS, `${took}ms`);
    record("the page does not throw in the browser", crashes.length === 0,
      crashes.length ? crashes[0].slice(0, 200) : "");

    const board = await page.locator("[data-browse-board]").count();
    const empty = await page.locator("[data-browse-empty]").count();
    // Error and empty are one exclusive chain, never two independent blocks.
    record("exactly one of board / empty state is rendered", board + empty === 1,
      `board: ${board}, empty: ${empty}`);

    const text = await page.evaluate(() => document.body.innerText);

    if (empty > 0) {
      const err = await page.locator("[data-error-state]").count();
      record("the failure is drawn as a failure, not as an empty result", err > 0,
        `data-error-state: ${err}`);

      const retry = await page.getByRole("button", { name: /try again|retry/i }).count();
      record("the failure offers a way out of it", retry > 0, `retry controls: ${retry}`);

      record("it says plainly that nothing could be reached",
        /could not reach any source/i.test(text));
    } else {
      // Cached rows survived, which is also a correct outcome: an outage must
      // never be able to empty a catalog that was fine a minute ago.
      const rails = await page.locator("[data-rail]").count();
      record("an outage serves the cache rather than emptying it", rails > 0, `${rails} rails`);
    }

    // Whatever happened, the essay stays dead.
    for (const phrase of ["What this page becomes", "Five rows fill themselves in"]) {
      record(`even offline the page does not say "${phrase}"`, !text.includes(phrase));
    }

    await page.screenshot({ path: path.join(OUT, "offline-1440.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, "offline-390.png"), fullPage: true });

    await context.close();
  } finally {
    await browser.close();
  }

  console.log(`\nScreenshots: ${OUT}`);
  if (failures.length) {
    console.log(`\nshoot-offline: ${failures.length} FAILED — ${JSON.stringify(failures)}`);
    process.exit(1);
  }
  console.log("\noffline degrades honestly");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
