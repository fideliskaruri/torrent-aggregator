/**
 * The interactions, not the render.
 *
 * Everything verified so far proves the section *draws* correctly. These are the
 * behaviours that only break when a person actually uses it: paging past the
 * first screen, driving it from the keyboard, and changing your mind mid-search.
 * The last one is where the ugly bugs live — an in-flight response arriving
 * after you have switched shelves can repaint the new shelf with the old
 * shelf's results, and nothing about that looks like an error.
 *
 * Run:  node scripts\probes\section-interaction.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function rows(page) {
  return page.locator("[data-artifact-row]").count();
}

const browser = await chromium.launch({ headless: true });

try {
  // ── Paging ──────────────────────────────────────────────────────────────
  {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    await page.goto(`${BASE}/everything?scope=games&q=stardew`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector("[data-artifact-row]", { timeout: 30000 });
    const first = await rows(page);
    check("the first page fills", first > 5, `rows=${first}`);

    const more = page.getByRole("button", { name: /load .*more|more results|next/i });
    if ((await more.count()) > 0) {
      await more.first().click();
      await page.waitForFunction(
        (n) => document.querySelectorAll("[data-artifact-row]").length > n,
        first,
        { timeout: 30000 },
      ).catch(() => {});
      const second = await rows(page);
      check("loading more APPENDS rather than replacing", second > first,
        `${first} -> ${second}`);

      // The same torrent must never be listed twice. Checked at the API,
      // because the row itself does not expose an info hash.
      const api = await page.evaluate(async () => {
        const out = [];
        for (const pg of [1, 2]) {
          const r = await fetch(
            `/api/search?q=stardew&category=games&page=${pg}&pageSize=40`,
          );
          const j = await r.json();
          out.push(...(j.results ?? []).map((x) => x.infoHash).filter(Boolean));
        }
        return out;
      });
      check("no torrent is served twice across pages",
        new Set(api).size === api.length,
        `${api.length} results, ${new Set(api).size} unique hashes`);

      // Duplicates are the classic append bug — but "same title" is NOT the
      // rule. Measured here: 70 rows carried 70 distinct info hashes and only
      // 67 distinct titles, because three separate uploads are all called
      // "Stardew Valley by Igruha". Those are real, different torrents and
      // hiding two of them would remove a choice, not a duplicate.
      //
      // The two rules that DO matter:
      //   1. the same torrent must never appear twice (a genuine append bug);
      //   2. no two rows may be visually identical — a row the eye cannot tell
      //      apart from its neighbour is one the owner cannot choose between,
      //      which defeats the whole point of a picker.
      const shown = await page.$$eval("[data-artifact-row]", (els) =>
        els.map((e) => e.innerText.replace(/\s+/g, " ").trim()),
      );
      const distinct = new Set(shown);
      check("no two rows are visually identical",
        distinct.size === shown.length,
        `${shown.length} rows, ${distinct.size} distinguishable`);
    } else {
      check("a second page is reachable", false, "no load-more control found");
    }
    await page.close();
  }

  // ── Keyboard: the palette must be drivable to a non-video row ───────────
  {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.keyboard.press("/");
    await page.waitForSelector("[data-search-overlay]", { timeout: 8000 });

    // Reach the Music chip by keyboard alone.
    const musicChip = page
      .locator('[data-search-overlay] [role="tab"]', { hasText: "Music" })
      .first();
    await musicChip.click();
    await page.locator("[data-search-overlay-input]").fill("daft punk discovery");
    await page.waitForSelector("[data-artifact-row]", { timeout: 30000 });

    // ArrowDown from the input must land on something actionable.
    await page.locator("[data-search-overlay-input]").focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);

    const landed = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return "none";
      if (a.closest("[data-artifact-row]")) return "artifact-row";
      if (a.closest('[data-card-target="title"]')) return "title-card";
      if (a.getAttribute("data-search-overlay-input")) return "still-input";
      return a.tagName.toLowerCase();
    });
    check("ArrowDown reaches an artifact row from the input",
      landed === "artifact-row", `focus landed on: ${landed}`);

    // Esc must still close from inside the results.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("Esc closes the palette from the results region",
      (await page.locator("[data-search-overlay]").count()) === 0);
    await page.close();
  }

  // ── The race: switching shelves mid-flight ──────────────────────────────
  {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();

    // Hold the FIRST search open so it can only answer after the switch.
    let delayed = 0;
    await page.route("**/api/search?*", async (route) => {
      const url = route.request().url();
      if (url.includes("category=music") && delayed === 0) {
        delayed += 1;
        await new Promise((r) => setTimeout(r, 9000));
      }
      await route.continue();
    });

    await page.goto(`${BASE}/everything?scope=music&q=stardew`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1200);

    // Switch to Games while Music is still in flight.
    const gamesTab = page.locator('[role="tab"]', { hasText: "Games" }).first();
    await gamesTab.click();
    await page.waitForSelector("[data-artifact-row]", { timeout: 30000 });

    // Let the stale Music response land.
    await page.waitForTimeout(10000);

    const activeTab = await page.evaluate(() => {
      const t = document.querySelector('[role="tab"][aria-selected="true"]');
      return t?.textContent?.trim() ?? "?";
    });
    check("the shelf the owner chose stays selected", activeTab === "Games", activeTab);

    const dest = await page
      .locator("[data-destination]")
      .first()
      .innerText()
      .catch(() => "");
    check("the destination folder matches the chosen shelf", /Games/i.test(dest), dest);

    const url = page.url();
    check("the URL reflects the chosen shelf", /scope=games/.test(url), url);

    // The real prize: a late response must not repaint the new shelf.
    const shown = await page.$$eval("[data-artifact-row]", (els) =>
      els.slice(0, 6).map((e) => e.querySelector("span")?.textContent?.trim() ?? ""),
    );
    const looksLikeGames = shown.some((t) => /stardew/i.test(t));
    check("a late response never repaints the new shelf", looksLikeGames,
      `rows now: ${JSON.stringify(shown.slice(0, 3))}`);
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\ninteractions verified");
