/**
 * Photograph and interrogate the title detail page — `/title/[workKey]` — in
 * the state a real user actually sees it.
 *
 * Why this exists, and why it seeds: the whole point of this page is that it
 * replaces "click a title, get a table of release names" with "click a title,
 * press Play". None of that is observable against an empty database, which is
 * exactly how this project's earlier QA passes managed to be green while the
 * product was visibly wrong. So this seeds a real shape of data — a series
 * with two seasons and a half-watched episode, a film already on disk, and a
 * film nothing local has ever heard of — then asserts against what renders.
 *
 * The second pass of assertions came from the owner looking at the rendered
 * pages and finding four things a green suite had missed: a film page that was
 * a hero over several hundred pixels of black, episode rows that said nothing
 * but "S02E01", a "Not checked" badge on every row, and a hero claiming
 * "1 season" above a list headed "5 in season 2". Each of those now has an
 * assertion here, measured off the live DOM rather than inferred.
 *
 * Auth note: TorrentFlow has no sign-in (`src/lib/auth.ts` returns a fixed
 * single-user session, `local`), so there is no cookie to mint; the rows just
 * have to belong to that user.
 *
 * Cleanup is scoped to exactly the rows seeded here, by hash / id / cacheKey.
 * `local` is the developer's real user and owns rows this script did not add;
 * a blanket delete by userId would destroy them.
 *
 * Run: node scripts/shoot-title.mjs   (BASE_URL overrides the host)
 */
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import path from "node:path";
import fs from "node:fs";
import "dotenv/config";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3210";
const OUT = path.resolve(process.env.SHOT_DIR ?? "qa-screens/title");
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
function record(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function createPrisma() {
  const raw = process.env.DATABASE_URL || "file:./dev.db";
  let url = raw;
  if (raw.startsWith("file:")) {
    const fp = raw.slice(5);
    if (!path.isAbsolute(fp)) {
      url = `file:${path.resolve(process.cwd(), fp.replace(/^\.\//, "")).replace(/\\/g, "/")}`;
    }
  }
  return new PrismaClient({ adapter: new PrismaLibSql({ url }) });
}

const userId = "local";

const pad = (seed) => seed.repeat(40).slice(0, 40);

/**
 * The work keys under test.
 *
 * These are not guesses: they are what `workKeyForRelease()` returns for the
 * release names seeded below. If the key derivation ever changes, these pages
 * 404-equivalent (they render "nothing local knows this title") and the
 * assertions below go red — which is the intended alarm, not a nuisance.
 */
const SERIES_KEY = "severance";
const FILM_KEY = "dune-part-two-2024";
const UNKNOWN_KEY = "the-quiet-cartographer-2019";

/**
 * A series with two seasons, one episode part-downloaded, and one episode the
 * viewer stopped in the middle of — so the page has a Resume to offer and the
 * episode rows have to disagree with each other.
 */
const SERIES_TORRENTS = [
  { hash: "q1", name: "Severance.S01E01.1080p.ATVP.WEB-DL.DDP5.1.Atmos", status: "seeding", progress: 1 },
  { hash: "q2", name: "Severance.S01E02.1080p.ATVP.WEB-DL.DDP5.1.Atmos", status: "seeding", progress: 1 },
  { hash: "q3", name: "Severance.S02E01.1080p.ATVP.WEB-DL.DDP5.1.Atmos", status: "seeding", progress: 1 },
  { hash: "q4", name: "Severance.S02E05.1080p.ATVP.WEB-DL.DDP5.1.Atmos", status: "downloading", progress: 0.31 },
];

/** A film already on disk: its page must offer Play, not a search. */
const FILM_TORRENTS = [
  { hash: "q5", name: "Dune.Part.Two.2024.2160p.UHD.BluRay.x265-SWTYBLZ", status: "seeding", progress: 1 },
];

const TORRENTS = [...SERIES_TORRENTS, ...FILM_TORRENTS];
const SEEDED_HASHES = TORRENTS.map((t) => pad(t.hash));

/** Half-watched: S02E01, which is what the primary Resume must point at. */
const WATCHING = [
  {
    hash: "q3",
    file: "severance.s02e01.mkv",
    pos: 640,
    dur: 2520,
    title: "Severance",
    season: 2,
    episode: 1,
  },
];

const CATALOG_IDS = ["qa-title-severance", "qa-title-quiet-cartographer"];
const CATALOG = [
  {
    id: CATALOG_IDS[0],
    workKey: SERIES_KEY,
    title: "Severance",
    year: null,
    mediaType: "tv",
    // Real TMDB paths. The point of this harness is to photograph a populated
    // page: with `null` here the 1.2s artwork budget loses on a cold cache and
    // the hero renders as a grey tile — which is correct behaviour but shows
    // nothing about the layout the owner is reviewing. The Severance backdrop
    // is also the one that carries the show's name inside the artwork, so it
    // is what the scrim has to be judged against.
    posterUrl: "https://image.tmdb.org/t/p/w500/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg",
    backdropUrl:
      "https://image.tmdb.org/t/p/w1280/ixgFmf1X59PUZam2qbAfskx2gQr.jpg",
    overview:
      "Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives.",
    rating: 8.7,
    source: "trending",
    rank: 901,
    seedTitle: null,
    seeders: 420,
  },
  {
    id: CATALOG_IDS[1],
    workKey: UNKNOWN_KEY,
    title: "The Quiet Cartographer",
    year: 2019,
    mediaType: "movie",
    // No artwork and no blurb on purpose. This is the shape of a work nothing
    // has ever catalogued, and it is the only fixture where the watchlist's
    // name-similarity enrichment can win the artwork/synopsis race — which is
    // exactly the claim this run has to catch the page making.
    posterUrl: null,
    backdropUrl: null,
    overview: null,
    rating: 7.1,
    source: "trending",
    rank: 902,
    seedTitle: null,
    seeders: 0,
  },
];

const WATCH_ITEM_ID = "qa-title-watch-severance";

async function seed(prisma) {
  // A run that dies mid-flight (a lost dev server, a SQLite writer lock)
  // leaves its rows behind and the next run then trips the unique index on
  // `EngineTorrent(userId, hash)` before it can assert anything. Clearing
  // first — with the same tightly scoped delete used at the end, never a
  // blanket delete by userId — makes the seed idempotent.
  await cleanup(prisma);

  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, name: "You", email: null },
  });

  await prisma.engineTorrent.createMany({
    data: TORRENTS.map((t) => ({
      userId,
      hash: pad(t.hash),
      name: t.name,
      status: t.status,
      progress: t.progress,
      origin: "user",
    })),
  });

  await prisma.playbackProgress.createMany({
    data: WATCHING.map((w) => ({
      userId,
      infoHash: pad(w.hash),
      filePath: w.file,
      positionSec: w.pos,
      durationSec: w.dur,
      title: w.title,
      season: w.season,
      episode: w.episode,
    })),
  });

  await prisma.watchListItem.create({
    data: {
      id: WATCH_ITEM_ID,
      userId,
      mediaType: "tv",
      externalId: "qa:severance",
      title: "Severance",
      monitored: true,
      cursorSeason: 2,
      cursorEpisode: 6,
    },
  });

  // refreshedAt = now so `ensureCatalogFresh` treats the catalog as fresh and
  // does not replace these rows out from under the run.
  await prisma.catalogEntry.createMany({
    data: CATALOG.map((c) => ({ ...c, refreshedAt: new Date() })),
  });
}

async function cleanup(prisma) {
  await prisma.playbackProgress
    .deleteMany({ where: { userId, infoHash: { in: SEEDED_HASHES } } })
    .catch(() => {});
  await prisma.engineTorrent
    .deleteMany({ where: { userId, hash: { in: SEEDED_HASHES } } })
    .catch(() => {});
  await prisma.watchListItem.delete({ where: { id: WATCH_ITEM_ID } }).catch(() => {});
  // The row the "Add to library" step created, identified by the invented
  // film's own title so nothing the developer owns can match it.
  await prisma.watchListItem
    .deleteMany({
      where: { userId, mediaType: "movie", title: "The Quiet Cartographer" },
    })
    .catch(() => {});
  await prisma.catalogEntry
    .deleteMany({ where: { id: { in: CATALOG_IDS } } })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Page probes
// ---------------------------------------------------------------------------

/** Everything the assertions need, read in one pass so the DOM is consistent. */
async function readTitlePage(page) {
  return page.evaluate(() => {
    const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const primary = document.querySelector("[data-title-primary]");
    const hero = document.querySelector("[data-title-hero]");
    const heading = document.querySelector("#title-heading");
    const chooseRelease = document.querySelector("[data-choose-release]");

    const rows = [...document.querySelectorAll("[data-episode-row]")].map((row) => {
      const buttons = row.querySelectorAll("[data-episode-action]");
      const button = buttons[0];
      const unaired = row.querySelector("[data-episode-unaired]");
      return {
        episode: row.getAttribute("data-episode"),
        availability: row.getAttribute("data-availability"),
        buttons: buttons.length,
        kind: button?.getAttribute("data-action-kind") ?? null,
        name: button?.getAttribute("aria-label") ?? "",
        label: text(button),
        tag: button?.tagName ?? null,
        href: button?.getAttribute("href") ?? null,
        disabled: button instanceof HTMLButtonElement ? button.disabled : false,
        episodeName: text(row.querySelector("[data-episode-name]")),
        // A chip is a `span` carrying the state; the row carries the same
        // attribute, so the tag name is what separates the badge from its row.
        unresolvedChips: row.querySelectorAll(
          'span[data-availability="unresolved"]',
        ).length,
        unaired: unaired ? text(unaired) : null,
      };
    });

    const detail = document.querySelector("[data-title-detail]");
    const appFooter = document.querySelector(".app-footer");
    // The dead space a short page leaves between its last content and the site
    // footer. `.app-main` is `flex: 1`, so a page with nothing under the hero
    // stretches and the footer floats in black.
    const voidPx =
      detail && appFooter && appFooter.getClientRects().length > 0
        ? Math.round(
            appFooter.getBoundingClientRect().top -
              detail.getBoundingClientRect().bottom,
          )
        : null;

    const similarCards = [...document.querySelectorAll("[data-similar-card]")].map(
      (card) => {
        const caption = text(card.querySelector("p"));
        // Any leaf inside the tile whose whole text is the caption: artwork
        // must be a mark, never a second printing of the name beneath it.
        const echoes = [...card.querySelectorAll("*")].filter(
          (el) =>
            el.children.length === 0 &&
            text(el).length > 0 &&
            text(el) === caption &&
            !el.closest("p"),
        ).length;
        return {
          href: card.getAttribute("href") ?? "",
          caption,
          echoes,
        };
      },
    );

    const listHeader = text(
      document.querySelector("[data-title-episodes] p"),
    );
    // Read the facts as elements, not out of the hero's flattened text:
    // `textContent` runs adjacent spans together ("8.4 rating3 seasons"), and
    // a regex over that is one word boundary away from silently matching
    // nothing — which is a test that passes because it looked in the wrong
    // place.
    const heroFacts = [
      ...document.querySelectorAll("[data-title-hero] [data-title-fact]"),
    ].map(text);
    const seasonFact = heroFacts
      .map((f) => /^(\d+)\s+seasons?$/.exec(f))
      .find(Boolean);
    const listSeason = /season\s+(\d+)/i.exec(listHeader);

    // Anything inside the hero whose entire text is the title, other than the
    // heading itself: the artwork must be a mark, never a second caption.
    const title = text(heading);
    const echoes = hero
      ? [...hero.querySelectorAll("*")].filter(
          (el) =>
            el !== heading &&
            el.children.length === 0 &&
            text(el).length > 0 &&
            text(el) === title,
        ).length
      : 0;

    return {
      hasDetail: Boolean(document.querySelector("[data-title-detail]")),
      hasHero: Boolean(hero),
      errorStates: document.querySelectorAll("[data-error-state]").length,
      emptyStates: document.querySelectorAll("[data-empty-state]").length,
      heading: title,
      primary: primary
        ? {
            tag: primary.tagName,
            kind: primary.getAttribute("data-action-kind"),
            label: text(primary),
            name: primary.getAttribute("aria-label") ?? "",
            href: primary.getAttribute("href"),
            disabled:
              primary instanceof HTMLButtonElement ? primary.disabled : false,
          }
        : null,
      heroSearchLinks: hero
        ? [...hero.querySelectorAll("a[href]")].filter((a) =>
            (a.getAttribute("href") ?? "").startsWith("/search"),
          ).length
        : 0,
      seasonTabs: [...document.querySelectorAll("[data-season-tab]")].map((el) => ({
        label: text(el),
        pressed: el.getAttribute("aria-pressed") === "true",
      })),
      episodeSection: Boolean(document.querySelector("[data-title-episodes]")),
      rows,
      listHeader,
      heroFacts,
      heroSeasonCount: seasonFact ? Number(seasonFact[1]) : null,
      listSeason: listSeason ? Number(listSeason[1]) : null,
      // "Not checked" is the chip for `availability: null`. Null is a real
      // state and must stay clickable — but a badge saying nobody looked, on
      // every row of a season, is a diagnostics dump, not information.
      notCheckedCount: (
        (detail?.textContent ?? "").match(/Not checked/g) ?? []
      ).length,
      similar: {
        section: Boolean(document.querySelector("[data-title-similar]")),
        cards: similarCards,
      },
      voidPx,
      overview: text(document.querySelector("[data-title-overview]")),
      // Every image the hero actually paints. The invented film has no
      // artwork anywhere, so anything here is borrowed from another work.
      heroArt: [...(hero?.querySelectorAll("img") ?? [])]
        .map((img) => img.getAttribute("src") ?? "")
        .filter(Boolean),
      titleEchoes: echoes,
      chooseReleaseHref: chooseRelease?.getAttribute("href") ?? null,
      library: {
        add: Boolean(document.querySelector("[data-add-to-library]")),
        inLibrary: Boolean(document.querySelector("[data-in-library]")),
        monitor: Boolean(document.querySelector("[data-monitor-toggle]")),
        monitorName:
          document
            .querySelector("[data-monitor-toggle]")
            ?.getAttribute("aria-label") ?? "",
      },
      unnamed: [...document.querySelectorAll("button, a[href]")].filter(
        (el) =>
          !text(el) &&
          !el.getAttribute("aria-label") &&
          !el.getAttribute("title"),
      ).length,
    };
  });
}

const looksLikeSearch = (s) => /search|browse releases|find it|check\b/i.test(s);

async function openTitle(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  // The page shell is server-rendered and the payload arrives from
  // /api/title/[workKey]; wait for the button the whole design hangs off.
  await page.waitForSelector("[data-title-primary]", { timeout: 30_000 });
  await page.waitForTimeout(400);
}

/**
 * Wait for the second round trip to land.
 *
 * Not folded into `openTitle`, because the whole design claim is that the page
 * is complete *before* this arrives — the primary action, the library controls
 * and the episode rows are all asserted without it. This only gates the
 * assertions that are specifically about enrichment.
 *
 * Failures are swallowed: an assertion that reports "no episode names" is a
 * better diagnostic than a timeout stack, and a silent pass is impossible
 * because the assertion still runs.
 */
async function waitForExtras(page) {
  await page
    .waitForSelector("[data-episode-name], [data-title-similar]", {
      timeout: 25_000,
    })
    .catch(() => {});
  await page.waitForTimeout(600);
}

async function main() {
  const prisma = createPrisma();
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    console.log("── Seeding a series, a film on disk, and an unknown film ──");
    await seed(prisma);

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    // ---- The series -----------------------------------------------------
    console.log("\n── /title/severance (two seasons, one half-watched) ──");
    const seriesStart = Date.now();
    await openTitle(page, `${BASE}/title/${SERIES_KEY}?t=Severance&type=tv`);
    const seriesMs = Date.now() - seriesStart;
    await waitForExtras(page);
    const series = await readTitlePage(page);
    console.log(`  primary: ${JSON.stringify(series.primary)}`);
    console.log(`  seasons: ${JSON.stringify(series.seasonTabs)}`);
    console.log(`  episode rows: ${series.rows.length}`);
    console.log(`  first rows: ${JSON.stringify(series.rows.slice(0, 3))}`);
    console.log(
      `  hero facts: ${JSON.stringify(series.heroFacts)} · list: "${series.listHeader}"`,
    );

    record("the title page rendered", series.hasDetail && series.hasHero);
    record(
      "a populated title page shows neither an error nor an empty state",
      series.errorStates === 0 && series.emptyStates === 0,
      `error:${series.errorStates} empty:${series.emptyStates}`,
    );
    record(
      "the heading is the work, not a release name",
      series.heading === "Severance",
      series.heading,
    );
    record(
      "there is a primary action and it is a control, not a link",
      series.primary?.tag === "BUTTON" && !series.primary?.href,
      `${series.primary?.tag} href:${series.primary?.href}`,
    );
    record(
      "the primary action is Play/Resume/Get — never a search",
      ["play", "get"].includes(series.primary?.kind ?? "") &&
        !looksLikeSearch(series.primary?.label ?? "") &&
        !looksLikeSearch(series.primary?.name ?? ""),
      `${series.primary?.kind} "${series.primary?.label}"`,
    );
    record(
      "a half-watched episode makes the primary action Resume",
      series.primary?.kind === "play" && /^Resume/.test(series.primary?.label ?? ""),
      `${series.primary?.kind} "${series.primary?.label}"`,
    );
    record(
      "the primary action is never disabled",
      series.primary?.disabled === false,
    );
    record(
      "the hero offers no route to the release table",
      series.heroSearchLinks === 0,
      `${series.heroSearchLinks} search links in hero`,
    );
    record(
      "both seeded seasons are selectable",
      series.seasonTabs.length >= 2,
      JSON.stringify(series.seasonTabs.map((t) => t.label)),
    );
    record(
      "exactly one season tab is current",
      series.seasonTabs.filter((t) => t.pressed).length === 1,
    );
    record("the episode list rendered", series.episodeSection && series.rows.length > 0, `${series.rows.length} rows`);
    record(
      "every episode row has exactly one action of its own",
      series.rows.length > 0 && series.rows.every((r) => r.buttons === 1),
      JSON.stringify(series.rows.map((r) => r.buttons)),
    );
    record(
      "every episode action is Play or Get, never a search",
      series.rows.length > 0 &&
        series.rows.every(
          (r) => ["play", "get"].includes(r.kind ?? "") && !looksLikeSearch(r.label),
        ),
      JSON.stringify([...new Set(series.rows.map((r) => `${r.kind}:${r.label}`))]),
    );
    record(
      "every episode action has an accessible name",
      series.rows.length > 0 && series.rows.every((r) => r.name.trim().length > 0),
      JSON.stringify(series.rows.slice(0, 2).map((r) => r.name)),
    );
    record(
      "an episode on disk offers Play, so the rows are not all one state",
      series.rows.some((r) => r.kind === "play"),
      JSON.stringify(series.rows.map((r) => `${r.episode}:${r.kind}`)),
    );
    record(
      "no episode row is disabled — an unchecked episode is still clickable",
      series.rows.every((r) => r.disabled === false),
    );
    record(
      "the hero never prints the title twice",
      series.titleEchoes === 0,
      `${series.titleEchoes} echoes`,
    );
    record(
      "the release table survives as a discreet secondary link",
      (series.chooseReleaseHref ?? "").startsWith("/search"),
      String(series.chooseReleaseHref),
    );
    record(
      "a title already in the library says so and can be un-monitored",
      series.library.inLibrary && series.library.monitor,
      JSON.stringify(series.library),
    );
    record(
      "every control on the page has an accessible name",
      series.unnamed === 0,
      `${series.unnamed} unnamed`,
    );
    record(
      "the page paints without waiting on an indexer",
      seriesMs < 15_000,
      `${seriesMs}ms to primary action`,
    );

    // ---- What a row actually says (the "filename list" complaint) --------
    const named = series.rows.filter((r) => r.episodeName.length > 0);
    record(
      "episode rows carry the episode's name, not just its number",
      named.length >= 3,
      `${named.length}/${series.rows.length} named; e.g. ${JSON.stringify(
        named.slice(0, 3).map((r) => `${r.episode}: ${r.episodeName}`),
      )}`,
    );
    record(
      "an episode name is not a re-print of the episode number",
      named.every((r) => !/^S\d+E\d+$/i.test(r.episodeName)),
      JSON.stringify(named.slice(0, 2).map((r) => r.episodeName)),
    );
    record(
      "no row wears a 'Not checked' badge — null is neutral, not a state chip",
      series.notCheckedCount === 0 &&
        series.rows.every((r) => r.unresolvedChips === 0),
      `${series.notCheckedCount} occurrences, ${series.rows.reduce(
        (n, r) => n + r.unresolvedChips,
        0,
      )} chips`,
    );
    record(
      "dropping the chip did not disable the row — every unchecked row still gets",
      series.rows
        .filter((r) => r.availability === "unresolved" && !r.unaired)
        .every((r) => r.kind === "get" && r.disabled === false),
      JSON.stringify(
        series.rows
          .filter((r) => r.availability === "unresolved")
          .slice(0, 3)
          .map((r) => `${r.episode}:${r.kind}:${r.disabled}`),
      ),
    );
    record(
      "the hero never prints a season count that contradicts the list",
      series.heroSeasonCount != null &&
        series.listSeason != null &&
        series.heroSeasonCount >= series.listSeason,
      `hero says ${series.heroSeasonCount}, list is showing season ${series.listSeason}`,
    );
    record(
      "the season count is the show's, not the number of seasons we hold",
      series.heroSeasonCount != null &&
        series.heroSeasonCount >= 2 &&
        series.heroSeasonCount >= series.seasonTabs.length,
      `hero says ${series.heroSeasonCount} with ${series.seasonTabs.length} tabs`,
    );

    await page.screenshot({
      path: path.join(OUT, "title-series-1440.png"),
      fullPage: true,
    });

    // Season switching must actually change the list.
    const otherTab = page
      .locator("[data-season-tab]")
      .filter({ hasText: "Season 1" })
      .first();
    if (await otherTab.count()) {
      await otherTab.click();
      await page.waitForTimeout(1_200);
      const switched = await readTitlePage(page);
      record(
        "choosing a season changes the episode list",
        switched.rows.length > 0 &&
          switched.seasonTabs.find((t) => t.pressed)?.label === "Season 1",
        `${switched.rows.length} rows, current ${JSON.stringify(
          switched.seasonTabs.find((t) => t.pressed)?.label,
        )}`,
      );
      record(
        "the primary action follows the viewer, not the season tab",
        switched.primary?.kind === "play" &&
          /^Resume/.test(switched.primary?.label ?? ""),
        `${switched.primary?.kind} "${switched.primary?.label}"`,
      );
      await page.screenshot({
        path: path.join(OUT, "title-series-season1-1440.png"),
        fullPage: true,
      });
    } else {
      record("choosing a season changes the episode list", false, "no Season 1 tab");
    }

    // ---- The film already on disk ---------------------------------------
    console.log("\n── /title/dune-part-two-2024 (film, on disk) ──");
    await openTitle(
      page,
      `${BASE}/title/${FILM_KEY}?t=Dune%3A%20Part%20Two&y=2024&type=movie`,
    );
    await waitForExtras(page);
    const film = await readTitlePage(page);
    console.log(`  primary: ${JSON.stringify(film.primary)}`);
    console.log(
      `  similar: ${film.similar.cards.length} cards, void below content: ${film.voidPx}px`,
    );
    record(
      "a film held locally offers Play",
      film.primary?.kind === "play" && /^(Play|Resume)/.test(film.primary?.label ?? ""),
      `${film.primary?.kind} "${film.primary?.label}"`,
    );
    record(
      "a film has no episode list",
      !film.episodeSection && film.rows.length === 0,
      `${film.rows.length} rows`,
    );
    record(
      "a film page still offers the release table as an override",
      (film.chooseReleaseHref ?? "").startsWith("/search"),
      String(film.chooseReleaseHref),
    );
    record("a film page never prints its title twice", film.titleEchoes === 0);

    // ---- The space under a film's hero (the "450px of black" complaint) --
    record(
      "a film carries real content below the hero, not an explanation",
      film.similar.section && film.similar.cards.length >= 4,
      `${film.similar.cards.length} cards`,
    );
    record(
      "every 'more like this' card leads to another title page",
      film.similar.cards.length > 0 &&
        film.similar.cards.every((c) => c.href.startsWith("/title/")),
      JSON.stringify(film.similar.cards.slice(0, 2).map((c) => c.href)),
    );
    record(
      "no 'more like this' tile repeats its own caption",
      film.similar.cards.every((c) => c.echoes === 0),
      JSON.stringify(
        film.similar.cards.filter((c) => c.echoes > 0).map((c) => c.caption),
      ),
    );
    record(
      "a film page does not end in a void above the footer",
      film.voidPx != null && film.voidPx <= 120,
      `${film.voidPx}px of empty space between the page and the footer`,
    );
    record(
      "a film page has no 'Not checked' badge either",
      film.notCheckedCount === 0,
      `${film.notCheckedCount} occurrences`,
    );
    await page.screenshot({
      path: path.join(OUT, "title-film-1440.png"),
      fullPage: true,
    });

    // ---- The film nothing local has heard of ----------------------------
    console.log("\n── /title/the-quiet-cartographer-2019 (unknown, availability null) ──");
    const unknownStart = Date.now();
    await openTitle(
      page,
      `${BASE}/title/${UNKNOWN_KEY}?t=The%20Quiet%20Cartographer&y=2019&type=movie`,
    );
    const unknownMs = Date.now() - unknownStart;
    const unknown = await readTitlePage(page);
    console.log(`  primary: ${JSON.stringify(unknown.primary)}`);
    record(
      "an unsearched title offers a working Get, not a disabled control",
      unknown.primary?.kind === "get" &&
        unknown.primary?.disabled === false &&
        !looksLikeSearch(unknown.primary?.label ?? ""),
      `${unknown.primary?.kind} "${unknown.primary?.label}" disabled:${unknown.primary?.disabled}`,
    );
    record(
      "an unsearched title never claims a local file",
      unknown.primary?.kind !== "play",
      String(unknown.primary?.kind),
    );
    record(
      "a title not in the library offers to add it",
      unknown.library.add && !unknown.library.inLibrary,
      JSON.stringify(unknown.library),
    );
    // The worst case for the void: a work no catalog knows, so there are no
    // episodes and nothing to recommend either. Nothing to put in the space
    // means the space itself has to go, or the footer floats in black.
    record(
      "a title with nothing known about it still leaves no void above the footer",
      unknown.voidPx != null && unknown.voidPx <= 120,
      `${unknown.voidPx}px of empty space, ${unknown.similar.cards.length} similar cards`,
    );
    record(
      "an unknown title paints without waiting on an indexer",
      unknownMs < 15_000,
      `${unknownMs}ms`,
    );
    await page.screenshot({
      path: path.join(OUT, "title-unknown-1440.png"),
      fullPage: true,
    });

    // ---- Add to library, and monitoring, from the title page ------------
    //
    // Exercised on the invented film rather than on the series, because the
    // series legitimately matches a row the developer already owns and this
    // must not flip a real setting. The row added here is removed in cleanup.
    console.log("\n── add to library / monitoring round trip ──");
    await page.locator("[data-add-to-library]").click();
    await page
      .waitForSelector("[data-in-library]", { timeout: 20_000 })
      .catch(() => {});
    const added = await prisma.watchListItem.findFirst({
      where: { userId, mediaType: "movie", title: "The Quiet Cartographer" },
      select: { id: true, monitored: true, externalId: true },
    });
    console.log(`  watchlist row: ${JSON.stringify(added)}`);
    record(
      "Add to library writes a real watchlist row",
      Boolean(added),
      JSON.stringify(added),
    );
    record(
      "adding from a title page does not silently start hunting",
      added?.monitored === false,
      `monitored:${added?.monitored}`,
    );
    // `POST /api/watchlist` enriches by name similarity alone, and for this
    // invented film TMDB hands back *The Quiet* (2005): poster, synopsis and
    // all. The page must not repeat that claim — it was filling the hero
    // full-bleed, wordmark of the wrong film visible behind the H1.
    const afterAdd = await readTitlePage(page);
    record(
      "adding to the library does not dress the page in another work's artwork",
      afterAdd.heroArt.length === 0,
      JSON.stringify(afterAdd.heroArt),
    );
    record(
      "and the borrowed synopsis is not printed as this work's own",
      !/deaf teenager|godparents/i.test(afterAdd.overview ?? ""),
      JSON.stringify((afterAdd.overview ?? "").slice(0, 60)),
    );

    const toggle = page.locator("[data-monitor-toggle]");    record("an added title exposes a monitoring toggle", (await toggle.count()) > 0);
    if (await toggle.count()) {
      await toggle.click();
      await page.waitForTimeout(1_500);
      const after = await prisma.watchListItem.findUnique({
        where: { id: added?.id ?? "" },
        select: { monitored: true },
      });
      record(
        "the monitoring toggle flips the stored setting",
        after?.monitored === true,
        `monitored:${after?.monitored}`,
      );
    } else {
      record("the monitoring toggle flips the stored setting", false, "no toggle");
    }

    // ---- Narrow ---------------------------------------------------------
    console.log("\n── 390px ──");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const narrowUnknown = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    record(
      "at 390px the title page does not overflow",
      narrowUnknown <= 391,
      `scrollWidth ${narrowUnknown}`,
    );
    await page.screenshot({
      path: path.join(OUT, "title-unknown-390.png"),
      fullPage: true,
    });

    await openTitle(page, `${BASE}/title/${SERIES_KEY}?t=Severance&type=tv`);
    await waitForExtras(page);
    const narrowSeries = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    record(
      "at 390px the episode list does not overflow",
      narrowSeries <= 391,
      `scrollWidth ${narrowSeries}`,
    );
    const narrow = await readTitlePage(page);
    record(
      "the narrow layout keeps one action per episode",
      narrow.rows.length > 0 && narrow.rows.every((r) => r.buttons === 1),
      `${narrow.rows.length} rows`,
    );
    await page.screenshot({
      path: path.join(OUT, "title-series-390.png"),
      fullPage: true,
    });

    // The bottom nav is `position: fixed`, so a page whose content ends level
    // with it leaves its last row permanently half-covered. Measure the lowest
    // real content element rather than the last episode row: the rail now sits
    // below the episodes, so asserting on a row that is no longer last would be
    // a check that can never fail. Measuring the outer container is no good
    // either — its own bottom padding is the very thing under test.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const navClearance = await page.evaluate(() => {
      const content = [
        ...document.querySelectorAll(
          "[data-episode-row],[data-similar-card],[data-choose-release]",
        ),
      ];
      const nav = document.querySelector('nav[aria-label="Primary"]');
      if (content.length === 0 || !nav) return null;
      const lowest = Math.max(
        ...content.map((el) => el.getBoundingClientRect().bottom),
      );
      return Math.round(nav.getBoundingClientRect().top - lowest);
    });
    record(
      "at 390px the last row of content clears the fixed bottom nav",
      navClearance != null && navClearance >= 8,
      `${navClearance}px between the lowest content and the nav`,
    );
    await page.screenshot({
      path: path.join(OUT, "title-series-390-bottom.png"),
    });

    // A film at 390 too: the void complaint was reported at both widths.
    await openTitle(
      page,
      `${BASE}/title/${FILM_KEY}?t=Dune%3A%20Part%20Two&y=2024&type=movie`,
    );
    await waitForExtras(page);
    const filmNarrow = await readTitlePage(page);
    record(
      "at 390px the film page does not overflow",
      (await page.evaluate(() => document.documentElement.scrollWidth)) <= 391,
    );
    record(
      "at 390px a film still carries content below the hero",
      filmNarrow.similar.cards.length >= 4,
      `${filmNarrow.similar.cards.length} cards`,
    );
    await page.screenshot({
      path: path.join(OUT, "title-film-390.png"),
      fullPage: true,
    });

    // ---- The browse board must now lead here ----------------------------
    console.log("\n── / (cards must lead to the title page) ──");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForTimeout(1_200);
    const cards = await page.$$eval("a[data-rail-card]", (els) =>
      els.map((el) => ({
        href: el.getAttribute("href") ?? "",
        target: el.getAttribute("data-card-target"),
      })),
    );
    const toSearch = cards.filter((c) => c.href.startsWith("/search"));
    const toTitle = cards.filter((c) => c.href.startsWith("/title/"));
    console.log(`  rail card links: ${cards.length} (title ${toTitle.length}, search ${toSearch.length})`);
    record(
      "discovery cards lead to the title page",
      toTitle.length > 0,
      `${toTitle.length} of ${cards.length}; e.g. ${toTitle[0]?.href ?? "-"}`,
    );
    record(
      "no card sends the user straight to the release table",
      toSearch.length === 0,
      toSearch.length ? JSON.stringify(toSearch.slice(0, 3)) : "",
    );
    // The magnifier escape hatch is not a rail card and must survive.
    const escapes = await page.$$eval(
      'a[href^="/search"]:not([data-rail-card])',
      (els) => els.length,
    );
    record(
      "the search escape hatch still exists somewhere on the board",
      escapes > 0,
      `${escapes} links`,
    );
    await page.screenshot({
      path: path.join(OUT, "browse-cards-1440.png"),
      fullPage: true,
    });

    await context.close();
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect().catch(() => {});
    await browser.close();
  }

  console.log(`\nScreenshots: ${OUT}`);
  if (failures.length) {
    console.log(`\nshoot-title: ${failures.length} FAILED`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("\ntitle page clean");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
