/**
 * Drive the new "everything" surfaces in a real browser and report what a
 * person would actually see.
 *
 * Why this exists: the owner's machine is locked, so the computer-use path
 * cannot verify the UI. This is not a substitute for a human look, and it does
 * not pretend to be — but a real Chromium rendering the production build,
 * clicking real controls and reading the resulting DOM is genuine evidence,
 * where "the unit tests pass" is not.
 *
 * It asserts behaviour, not pixels: which request each scope fires, whether the
 * resting state says anything, whether Play appears where it must not, and
 * whether the destination folder is stated before a download.
 *
 * Run:  node scripts\probes\everything-ui.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = path.resolve("qa-shots", "everything");
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const notes = [];

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function note(msg) {
  notes.push(msg);
  console.log(`  note  ${msg}`);
}

/** Wait for rows to appear, rather than guessing a sleep length. */
async function waitForRows(page, timeout = 25000) {
  try {
    await page.waitForSelector("[data-artifact-row]", { timeout });
    return await page.locator("[data-artifact-row]").count();
  } catch {
    return 0;
  }
}

const browser = await chromium.launch({ headless: true });

try {
  // ── The section page ─────────────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    const requests = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/api/search")) requests.push(u);
    });

    await page.goto(`${BASE}/everything`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(OUT, "01-resting.png"), fullPage: true });

    const bodyText = await page.innerText("body");

    check(
      "the resting state is not blank — it says what this section holds",
      bodyText.trim().length > 120,
      `only ${bodyText.trim().length} chars of text`,
    );

    // Every scope must be reachable as a tab.
    const tabLabels = await page.$$eval(
      '[role="tab"], button',
      (els) => els.map((e) => e.textContent?.trim()).filter(Boolean),
    );
    for (const label of ["Music", "Games", "Software", "Books", "Anime"]) {
      check(
        `the ${label} shelf is reachable`,
        tabLabels.some((t) => t === label),
        `tabs seen: ${JSON.stringify(tabLabels.slice(0, 14))}`,
      );
    }

    // The destination folder must be stated BEFORE anything is downloaded —
    // "where did my file go" has been the owner's recurring complaint. Assert
    // the dedicated element rather than searching prose for the word "folder":
    // the copy reads "Files land in D:\…\Music", which is the better wording
    // and contains no such word.
    const destEl = page.locator("[data-destination]");
    check("the destination is stated on the resting page", (await destEl.count()) > 0);
    if (await destEl.count()) {
      const destText = (await destEl.first().innerText()).replace(/\s+/g, " ").trim();
      check(
        "the destination names a real path or category",
        destText.length > 12 && /land|folder|\\|\//i.test(destText),
        destText,
      );
      note(`resting destination: ${destText}`);
    }

    // ── Search inside a scope actually queries that category ──────────────
    const musicTab = page.locator('[role="tab"]', { hasText: "Music" }).first();
    if (await musicTab.count()) {
      await musicTab.click();
      await page.waitForTimeout(300);
    }
    const input = page.locator('input[type="search"], input[type="text"]').first();
    await input.fill("daft punk discovery");
    const rowCount = await waitForRows(page);
    await page.waitForTimeout(400);

    const musicReq = requests.filter((u) => u.includes("category=music"));
    check(
      "the Music shelf queries category=music",
      musicReq.length > 0,
      `requests: ${JSON.stringify(requests.slice(-4))}`,
    );

    await page.screenshot({ path: path.join(OUT, "02-music-results.png"), fullPage: true });

    check("Music returned rows a person can act on", rowCount > 0, `rows=${rowCount}`);

    if (rowCount > 0) {
      // Play must NOT be offered on an album: the player addresses one file and
      // an album is a folder of tracks.
      const playCount = await page
        .locator('[data-artifact-row] [data-action="play"]')
        .count();
      check(
        "no Play button on music rows (it could not work)",
        playCount === 0,
        `found ${playCount} Play buttons`,
      );

      const dlCount = await page
        .locator('[data-artifact-row] [data-action="download"]')
        .count();
      check("every music row offers Download", dlCount === rowCount, `${dlCount}/${rowCount}`);

      // Rows must carry facts, not just a filename.
      const firstRow = await page.locator("[data-artifact-row]").first().innerText();
      check(
        "a row states more than the bare title",
        firstRow.split("\n").filter((l) => l.trim()).length >= 2,
        JSON.stringify(firstRow),
      );
      note(`first music row: ${firstRow.replace(/\s+/g, " ").slice(0, 110)}`);

      // Video vocabulary must not leak onto an album row.
      check(
        "no resolution/episode vocabulary on a music row",
        !/\b(1080p|720p|2160p|WEB-DL|S\d{2}E\d{2})\b/i.test(firstRow),
        firstRow.replace(/\s+/g, " ").slice(0, 140),
      );

      check(
        "the Music destination is named on the results view too",
        (await page.locator("[data-destination]").count()) > 0 &&
          /music/i.test(await page.locator("[data-destination]").first().innerText()),
        await page.locator("[data-destination]").first().innerText().catch(() => "(none)"),
      );
    }

    // ── Anime is video, so Play SHOULD be offered ─────────────────────────
    const animeTab = page.locator('[role="tab"]', { hasText: "Anime" }).first();
    if (await animeTab.count()) {
      await animeTab.click();
      await page.waitForTimeout(400);
      await input.fill("frieren");
      const animeRows = await waitForRows(page, 30000);
      if (animeRows > 0) {
        const animePlay = await page
          .locator('[data-artifact-row] [data-action="play"]')
          .count();
        check(
          "anime rows DO offer Play (it is video)",
          animePlay > 0,
          `rows=${animeRows} play=${animePlay}`,
        );
      } else {
        note("anime search returned no rows — Play presence unverified");
      }
      await page.screenshot({ path: path.join(OUT, "03-anime.png"), fullPage: true });
    }

    await ctx.close();
  }

  // ── The search palette's scopes ──────────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const reqs = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/search")) reqs.push(r.url());
    });

    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.keyboard.press("/");
    await page.waitForTimeout(600);

    const overlay = page.locator("[data-search-overlay]");
    check("the / shortcut still opens the palette", (await overlay.count()) > 0);

    if ((await overlay.count()) > 0) {
      await page.screenshot({ path: path.join(OUT, "04-palette-open.png") });

      const chips = await page.$$eval('[data-search-overlay] [role="tab"]', (els) =>
        els.map((e) => e.textContent?.trim()),
      );
      check(
        "the palette offers scopes beyond films",
        chips.length >= 5,
        JSON.stringify(chips),
      );
      note(`palette scopes: ${JSON.stringify(chips)}`);

      // Films must still be TMDB-only — the oldest rule on this surface.
      const searchInput = page.locator("[data-search-overlay-input]");
      await searchInput.fill("dune");
      await page.waitForTimeout(1400);
      const filmReqs = reqs.filter((u) => u.includes("/api/search"));
      check(
        "a films query hits TMDB titles, never the indexers",
        filmReqs.every((u) => u.includes("/api/search/titles")),
        JSON.stringify(filmReqs.slice(-3)),
      );
      await page.screenshot({ path: path.join(OUT, "05-palette-films.png") });

      // Now switch to Music and confirm it re-queries the aggregator.
      const musicChip = page
        .locator('[data-search-overlay] [role="tab"]', { hasText: "Music" })
        .first();
      if (await musicChip.count()) {
        await musicChip.click();
        await waitForRows(page, 30000);
        const musicReqs = reqs.filter((u) => u.includes("category=music"));
        check(
          "switching to Music re-runs the search against the indexers",
          musicReqs.length > 0,
          JSON.stringify(reqs.slice(-3)),
        );
        const rows = await page.locator("[data-artifact-row]").count();
        check("the palette shows actionable music rows", rows > 0, `rows=${rows}`);
        await page.screenshot({ path: path.join(OUT, "06-palette-music.png") });
      }
    }
    await ctx.close();
  }

  // ── Mobile: the tab bar must not break at 390px ──────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/everything`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(OUT, "07-mobile-everything.png"), fullPage: true });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check("no horizontal overflow at 390px", overflow <= 1, `overflow ${overflow}px`);

    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const navOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check("browse has no horizontal overflow at 390px", navOverflow <= 1, `${navOverflow}px`);
    await page.screenshot({ path: path.join(OUT, "08-mobile-browse.png") });
    await ctx.close();
  }

  // ── Deep link round-trip ─────────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/everything?scope=games&q=stardew`, {
      waitUntil: "networkidle",
    });
    await waitForRows(page, 30000);
    const text = await page.innerText("body");
    const val = await page
      .locator('input[type="search"], input[type="text"]')
      .first()
      .inputValue()
      .catch(() => "");
    check("a deep link restores the query", val.toLowerCase().includes("stardew"), val);
    check("a deep link restores the scope", /games/i.test(text));
    const rows = await page.locator("[data-artifact-row]").count();
    check("a deep link renders results without another click", rows > 0, `rows=${rows}`);
    await page.screenshot({ path: path.join(OUT, "09-deeplink-games.png"), fullPage: true });
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\nscreenshots: ${OUT}`);
if (notes.length) console.log(`notes:\n  - ${notes.join("\n  - ")}`);
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall UI checks passed");
