/**
 * Multi-work search regression shots.
 *
 * Two fixtures, both served in place of /api/search so the shots do not depend
 * on live indexers:
 *
 *  1. `dune` — five different works sharing one wrong catalog match. This is
 *     the reported bug: a single "DUNE · 2017 · 127 releases" card whose "S01"
 *     tab interleaved Dune: Prophecy and Children of Dune episodes.
 *  2. `the bridge` — two multi-season shows that genuinely co-occur on one
 *     search (the Danish/Swedish original and the US remake), so the page
 *     carries two "S01" tab groups at once. That is the case the accessible
 *     names have to disambiguate, and the Dune page happens not to produce it.
 *
 * Beyond the screenshots the script asserts, in the rendered DOM, the three
 * things the fix is about: one heading per work, headings that differ, and no
 * season panel drawing rows from two works.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const OUT = process.env.SHOT_DIR ?? "qa-screens/dune";

/** Every row claims the same wrong catalog row, exactly as the real bug did. */
const WRONG_CATALOG = {
  source: "tmdb",
  mediaType: "movie",
  externalId: "438631",
  title: "Dune",
  year: 2017,
  posterUrl: null,
  synopsis: "A mismatched catalog row that used to relabel the whole page.",
};

/** [release title, season, episode] — season null means "not a TV release". */
const DUNE_TITLES = [
  // Dune: Prophecy (2024 series) — two seasons, so its card draws tabs.
  ["Dune.Prophecy.S01E01.The.Hidden.Hand.2160p.MAX.WEB-DL.DDP5.1.H.265-NTb", 1, 1],
  ["Dune.Prophecy.S01E02.Two.Wolves.2160p.MAX.WEB-DL.DDP5.1.H.265-NTb", 1, 2],
  ["Dune.Prophecy.S01E03.Sisterhood.Above.All.1080p.WEB-DL.H264-FLUX", 1, 3],
  ["Dune Prophecy (2024) S01 (1080p BluRay x265 10bit EAC3 Atmos 5.1 Ghost)", 1, null],
  ["Dune.Prophecy.S01E04.720p.WEB-DL.x264-GalaxyTV", 1, 4],
  ["Dune.Prophecy.S02E01.2160p.MAX.WEB-DL.DDP5.1.H.265-NTb", 2, 1],
  ["Dune.Prophecy.S02E02.1080p.WEB-DL.H264-FLUX", 2, 2],
  // Children of Dune (2003 miniseries) — also an "S01", which is the tab that
  // used to swallow Prophecy's episodes.
  ["Children.of.Dune.S01.COMPLETE.720p.BluRay.x264-GalaxyTV", 1, null],
  ["Children.of.Dune.S01E01.1080p.BluRay.x264-SHORTBREHD", 1, 1],
  ["Children.of.Dune.S01E02.1080p.BluRay.x264-SHORTBREHD", 1, 2],
  ["Children.of.Dune.S01E03.2160p.BluRay.x265-TERMiNAL", 1, 3],
  // Dune (1984)
  ["Dune.1984.2160p.UHD.BluRay.x265-TERMiNAL", null, null],
  ["Dune 1984 1080p BluRay DTS x264-DON", null, null],
  // Dune (2021)
  ["Dune.2021.2160p.WEB-DL.DDP5.1.Atmos.HDR.HEVC-CMRG", null, null],
  ["Dune.2021.1080p.BluRay.x264-RARBG", null, null],
  ["Dune 2021 720p WEBRip x264-GalaxyRG", null, null],
  // Dune: Part Two (2024)
  ["Dune.Part.Two.2024.2160p.WEB-DL.HDR.H265-FLUX", null, null],
  ["Dune.Part.Two.2024.1080p.WEBRip.x264-RARBG", null, null],
];

const BRIDGE_TITLES = [
  ["The.Bridge.US.S01E01.1080p.BluRay.x264-DEMAND", 1, 1],
  ["The.Bridge.US.S01E02.1080p.BluRay.x264-DEMAND", 1, 2],
  ["The.Bridge.US.S02E01.720p.HDTV.x264-KILLERS", 2, 1],
  ["The.Bridge.US.S02E02.720p.HDTV.x264-KILLERS", 2, 2],
  ["The.Bridge.S01E01.SWEDiSH.1080p.BluRay.x264-GROUP", 1, 1],
  ["The.Bridge.S01E02.SWEDiSH.1080p.BluRay.x264-GROUP", 1, 2],
  ["The.Bridge.S02E01.SWEDiSH.720p.WEB-DL.x264-GROUP", 2, 1],
  ["The.Bridge.S02E02.SWEDiSH.720p.WEB-DL.x264-GROUP", 2, 2],
];

function payloadFor(titles) {
  const results = titles.map(([title, season, episode], i) => ({
    id: `fixture-${i}`,
    title,
    size: 12_000_000_000 - i * 100_000_000,
    seeders: 500 - i * 7,
    leechers: 12,
    magnet: `magnet:?xt=urn:btih:${String(i).padStart(40, "0")}`,
    source: "yts",
    publishDate: new Date(Date.UTC(2024, 10, 20 - i)).toISOString(),
    category: season != null ? "tv" : "movies",
    metadata: WRONG_CATALOG,
    episode:
      season == null
        ? null
        : {
            season,
            episode,
            isBatch: episode == null,
            isSeasonPack: episode == null,
            isMultiSeason: false,
          },
  }));
  return {
    results,
    sources: [{ id: "yts", count: results.length, error: null }],
    totalCount: results.length,
    // tookMs is not optional on SearchResponse. Omitting it rendered a bare
    // "ms" with no number in the results meta line, which looked like a
    // product bug in the screenshots until traced back to this fixture.
    tookMs: 725,
    page: 1,
    pageSize: 200,
    totalPages: 1,
    cached: false,
  };
}

const SCENARIOS = [
  { name: "dune", query: "dune", titles: DUNE_TITLES, minWorks: 5, minTabs: 2 },
  { name: "bridge", query: "the bridge", titles: BRIDGE_TITLES, minWorks: 2, minTabs: 4 },
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const problems = [];

for (const [vpName, width, height] of [
  ["desktop", 1440, 900],
  ["mobile", 390, 844],
]) {
  for (const scenario of SCENARIOS) {
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

    const body = JSON.stringify(payloadFor(scenario.titles));
    await page.route("**/api/search*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body }),
    );

    await page.goto(`${BASE}/search?q=${encodeURIComponent(scenario.query)}`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForSelector("[data-torrent-card]", { timeout: 90_000 });
    await page.waitForTimeout(1200);
    await page.screenshot({
      path: join(OUT, `${vpName}-${scenario.name}.png`),
      fullPage: true,
    });

    const headings = await page.$$eval("section > div h2", (ns) =>
      ns.map((n) => n.textContent?.trim() ?? ""),
    );
    const tabs = await page.$$eval('[role="tab"]', (ns) =>
      ns.map((n) => ({
        id: n.getAttribute("data-season-tab"),
        name: n.getAttribute("aria-label"),
      })),
    );
    const panels = await page.$$eval("[data-season-panel]", (ns) =>
      ns.map((n) => ({
        panel: n.getAttribute("data-season-panel"),
        rows: Array.from(n.querySelectorAll("[data-torrent-card]")).map(
          (r) => r.textContent?.trim().slice(0, 80) ?? "",
        ),
      })),
    );

    console.log(`\n=== ${tag} ===`);
    console.log("headings:", JSON.stringify(headings));
    console.log("tabs:", JSON.stringify(tabs.map((t) => t.name)));
    for (const p of panels) console.log("panel", p.panel, "->", p.rows.length, "rows");

    if (headings.length < scenario.minWorks)
      problems.push(`${tag}: ${headings.length} headings, expected >= ${scenario.minWorks}`);
    if (new Set(headings).size !== headings.length)
      problems.push(`${tag}: duplicate headings ${JSON.stringify(headings)}`);
    // A heading's year is spaced with a CSS margin, which assistive tech does
    // not see: without an explicit text space the two adjacent text nodes are
    // announced as "Dune1984". This caught exactly that regression, and it is
    // invisible both on screen and to axe, so nothing else can catch it.
    for (const h of headings) {
      const glued = /[A-Za-z](\d{4})$/.exec(h);
      if (glued)
        problems.push(
          `${tag}: heading "${h}" glues the year to the title with no space — ` +
            `a screen reader announces it as one word`,
        );
    }
    if (tabs.length < scenario.minTabs)
      problems.push(`${tag}: ${tabs.length} tabs, expected >= ${scenario.minTabs}`);
    // Two works sharing a season number must still yield two distinguishable
    // tabs — both as DOM ids and, more importantly, to a screen reader.
    const ids = tabs.map((t) => t.id);
    const names = tabs.map((t) => t.name);
    if (new Set(ids).size !== ids.length) problems.push(`${tag}: duplicate tab ids`);
    if (new Set(names).size !== names.length)
      problems.push(`${tag}: duplicate tab names ${JSON.stringify(names)}`);
    // Each tab's accessible name must name the work it belongs to.
    for (const t of tabs) {
      const work = t.id?.split(":").slice(0, -1).join(":") ?? "";
      const bare = work.replace(/^(series|film):/, "").split(":")[0];
      if (!t.name?.toLowerCase().includes(bare.split(" ")[0]))
        problems.push(`${tag}: tab "${t.name}" does not name its work (${work})`);
    }
    // The defect itself: one panel drawing rows from more than one work. Each
    // panel is checked against the headings on the page.
    for (const p of panels) {
      const owner = p.panel?.split(":").slice(0, -1).join(":") ?? "";
      const bare = owner.replace(/^series:/, "");
      const foreign = p.rows.filter((r) => {
        const flat = r.toLowerCase().replace(/[^a-z0-9]+/g, " ");
        return !flat.includes(bare);
      });
      if (foreign.length)
        problems.push(`${tag}: panel ${p.panel} holds ${foreign.length} foreign row(s)`);
    }
    if (consoleErrors.length) problems.push(`${tag}: console ${JSON.stringify(consoleErrors)}`);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 1) problems.push(`${tag}: horizontal overflow of ${overflow}px`);

    await context.close();
  }
}

await browser.close();

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(" -", p);
  process.exit(1);
}
console.log("\nmulti-work render clean");
