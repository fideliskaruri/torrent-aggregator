/**
 * Photograph and interrogate the home page of a **brand-new install**.
 *
 * This is the case the whole discovery layer exists for, and the case every
 * previous QA script in this repo got wrong in the opposite direction: they
 * all ran against an empty database and photographed an empty page, so nobody
 * ever looked at the *product*. `shoot-browse.mjs` was written to fix that by
 * seeding a library. This script is its mirror image — it seeds **nothing**,
 * and asserts that the page is full anyway.
 *
 * What it is actually checking, in the order it matters:
 *
 *  1. A fresh install renders discovery rails with real titles. Not "renders
 *     something": rails with names in them, and names that are *works*
 *     ("House of the Dragon") rather than release files ("House of the Dragon
 *     S03E05 480p x264-mSD"). That distinction is the crux of the feature and
 *     the part most likely to look like garbage.
 *  2. The "What this page becomes" essay is gone, along with its dashed
 *     placeholder-rail diagram. The user's word for that copy was "slop".
 *  3. Nothing on those cards claims an availability nobody checked. A trending
 *     title is not on disk and no indexer has been searched for it, so its
 *     card must be a neutral, clickable affordance — never a disabled control
 *     and never the word "Unavailable".
 *
 * ## The database
 *
 * Point `DATABASE_URL` at a scratch file, not at `dev.db` — the whole premise
 * is a fresh install. The script *refuses to run* if the database it is given
 * contains any personal rows, rather than deleting them: `local` is the app's
 * real single user and a blanket delete would destroy real data.
 *
 * Having established there is no user data, it does clear `CatalogEntry`,
 * which is a refetchable cache and nothing else — that is what makes the run
 * a genuine cold start rather than a read of whatever a previous run left.
 *
 * Run:
 *   $env:DATABASE_URL="file:./qa-fresh.db"; npx prisma migrate deploy
 *   $env:DATABASE_URL="file:./qa-fresh.db"; npm run build; npx next start -p 3312
 *   $env:DATABASE_URL="file:./qa-fresh.db"; $env:BASE_URL="http://127.0.0.1:3312"; node scripts/shoot-discovery.mjs
 */
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
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

const TRENDING = "trending-now";
const POPULAR = "popular-series";
const BECAUSE = "because-you-are-watching";
const DISCOVERY_RAILS = [TRENDING, POPULAR];

/**
 * The film phase 2 pretends to have watched.
 *
 * Chosen because it is a *movie* and is not in the trending feed, which is
 * exactly the combination that produced a related row identical to the
 * trending row: with no anchor in the catalog, "things like this" degenerates
 * to "the most popular films", which is what the row below already shows.
 */
const SEED_TITLE = "Dune Part Two";
const SEED_INFO_HASH = "qa00discovery00seed00000000000000000dune2";
const SEED_USER = "local";

/** How a rail looks to a human, read out of the DOM. */
async function readRails(page) {
  return await page.$$eval("[data-rail]", (els) =>
    els.map((el) => ({
      id: el.getAttribute("data-rail"),
      heading: el.querySelector("h2")?.textContent?.trim() ?? "",
      // The caption's first paragraph carries the untruncated title in its
      // `title` attribute; the second is the subtitle. Reading the attribute
      // rather than the text avoids picking up the year as if it were a
      // title, and avoids CSS line-clamping the value being asserted on.
      captions: Array.from(el.querySelectorAll("li div.mt-2")).map((cap) => {
        const ps = Array.from(cap.querySelectorAll("p"));
        return {
          title: ps[0]?.getAttribute("title")?.trim() ?? ps[0]?.textContent?.trim() ?? "",
          subtitle: ps[1]?.textContent?.trim() ?? "",
        };
      }),
      cards: Array.from(el.querySelectorAll("[data-rail-card]")).map((c) => ({
        tag: c.tagName,
        disabled: c.getAttribute("aria-disabled") === "true" || c.hasAttribute("disabled"),
        availability: c.querySelector("[data-availability]")?.getAttribute("data-availability") ?? null,
      })),
    })),
  );
}

/**
 * Seed exactly one half-watched film.
 *
 * Scoped to a fixed info hash so {@link unseedWatched} can remove precisely
 * what was added: `local` is the app's real single user, so a blanket delete
 * of that user's progress would destroy somebody's actual viewing history.
 */
async function seedWatched(prisma) {
  // A virgin database has no rows at all, including no user. The app creates
  // its single local user lazily, so on a genuinely fresh install this row
  // may not exist yet and the progress row's foreign key would be violated.
  await prisma.user.upsert({
    where: { id: SEED_USER },
    update: {},
    create: { id: SEED_USER, name: "Local" },
  });
  await prisma.playbackProgress.create({
    data: {
      userId: SEED_USER,
      infoHash: SEED_INFO_HASH,
      filePath: "QA/dune.part.two.mkv",
      positionSec: 1800,
      durationSec: 9000,
      title: SEED_TITLE,
    },
  });
  console.log(`  seeded one half-watched film: "${SEED_TITLE}"`);
}

async function unseedWatched(prisma) {
  const progress = await prisma.playbackProgress.deleteMany({
    where: { infoHash: SEED_INFO_HASH },
  });
  // The related partition is derived from that row, so it goes with it rather
  // than being left behind to name a film nobody is watching.
  const related = await prisma.catalogEntry.deleteMany({
    where: { source: "related", seedTitle: SEED_TITLE },
  });
  console.log(`  cleaned up: ${progress.count} progress row, ${related.count} derived catalog rows`);
}

/**
 * Copy that must not come back.
 *
 * Matched as prose rather than by a marker on purpose: the point of the check
 * is that these *sentences* are gone from the product, wherever they might be
 * reintroduced from.
 */
const BANNED_COPY = [
  "What this page becomes",
  "Five rows fill themselves in",
  "Nothing here is hidden",
  "these are simply still empty",
];

/**
 * Tokens that only ever appear in a release filename.
 *
 * A rail title containing any of these means the collapse from releases to
 * works did not happen, which is the exact failure that makes the home page
 * "a website you go to view torrent lists".
 */
const RELEASE_NAME_TOKENS =
  /\b(1080p|720p|2160p|480p|WEB[- .]?DL|WEBRip|BluRay|BRRip|HDTV|x264|x265|HEVC|H\.?26[45]|DDP?5\.1|AAC2\.0|XviD|TELESYNC|REMUX|PROPER|REPACK|S\d{2}E\d{2})\b/i;

/** Three or more dot-joined words: `House.of.the.Dragon`. */
const DOTTED_FILENAME = /\w+\.\w+\.\w+/;

/**
 * Scroll the whole page — and every rail — once, so lazily-loaded artwork is
 * actually fetched.
 *
 * `fullPage: true` photographs the layout, not the network: an image that
 * never entered the viewport screenshots as an empty frame. There are two
 * axes to this and missing either one produces a page that looks broken for
 * reasons that are entirely the script's fault. Vertically, a rail below the
 * fold is never reached. Horizontally, a rail is a *scroller*: at 1440px about
 * seven of its twenty-four cards are on screen, and the other seventeen are as
 * unfetched as if they were on another page.
 *
 * Every scroller is returned to the start afterwards, so the screenshot shows
 * the page as a user would first meet it.
 */
async function warmLazyImages(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const step = Math.max(200, window.innerHeight * 0.8);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await sleep(180);
    }
    window.scrollTo(0, 0);
    await sleep(200);

    for (const rail of document.querySelectorAll("[data-rail]")) {
      // The *widest* overflow, not the first: a rail's own <section> overflows
      // its container by a few pixels of card shadow, and picking that one
      // scrolls twelve pixels and calls the job done. The real scroller is the
      // <ul>, which overflows by thousands.
      let scroller = null;
      let widest = 100;
      for (const el of [rail, ...rail.querySelectorAll("*")]) {
        const over = el.scrollWidth - el.clientWidth;
        if (over > widest) {
          widest = over;
          scroller = el;
        }
      }
      if (!scroller) continue;

      const end = scroller.scrollWidth - scroller.clientWidth;
      const across = Math.max(120, scroller.clientWidth * 0.8);
      for (let x = 0; x < end; x += across) {
        scroller.scrollLeft = x;
        await sleep(180);
      }
      scroller.scrollLeft = end;
      await sleep(300);
      scroller.scrollLeft = 0;
    }

    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1_500);
}

async function assertFreshInstall(prisma) {
  const [torrents, progress, watchlist] = await Promise.all([
    prisma.engineTorrent.count(),
    prisma.playbackProgress.count(),
    prisma.watchListItem.count(),
  ]);
  const total = torrents + progress + watchlist;
  if (total > 0) {
    console.error(
      `\nRefusing to run: ${process.env.DATABASE_URL} holds user data ` +
        `(${torrents} torrents, ${progress} progress rows, ${watchlist} library rows).\n` +
        `This script tests a brand-new install and will not delete anybody's ` +
        `library to create one. Point DATABASE_URL at a scratch database.\n`,
    );
    process.exit(2);
  }
  // Cache only, and only now that there is provably no user data behind it.
  const cleared = await prisma.catalogEntry.deleteMany({});
  console.log(`  database is a fresh install; cleared ${cleared.count} cached catalog rows`);
}

async function main() {
  const prisma = createPrisma();
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    console.log("── A brand-new install ──");
    await assertFreshInstall(prisma);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.log("\n── The home page, seeded with nothing ──");
    const started = Date.now();
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 120_000 });
    await page.waitForTimeout(2_000);
    console.log(`  first load: ${Date.now() - started}ms (cold catalog)`);

    // --- Is there a product here at all? ---
    const board = await page.locator("[data-browse-board]").count();
    const empty = await page.locator("[data-browse-empty]").count();
    record("a fresh install renders the real board, not an empty state", board > 0 && empty === 0,
      `data-browse-board: ${board}, data-browse-empty: ${empty}`);

    const rails = await readRails(page);

    for (const rail of rails) {
      console.log(`  rail ${rail.id} (${rail.cards.length}): ${JSON.stringify(rail.captions.slice(0, 6).map((c) => c.title))}`);
    }

    record("the fresh board has at least two rails", rails.length >= 2, `${rails.length} rails`);
    record("every rendered rail has cards in it",
      rails.length > 0 && rails.every((r) => r.cards.length > 0),
      JSON.stringify(rails.map((r) => [r.id, r.cards.length])));

    // --- The discovery rails specifically ---
    for (const id of DISCOVERY_RAILS) {
      const rail = rails.find((r) => r.id === id);
      record(`the "${id}" rail exists on a fresh install`, Boolean(rail),
        rail ? "" : `rails present: ${JSON.stringify(rails.map((r) => r.id))}`);
      if (!rail) continue;

      record(`"${id}" is a full row, not a token one`, rail.cards.length >= 8,
        `${rail.cards.length} cards`);
      record(`"${id}" has a heading`, rail.heading.length > 0, JSON.stringify(rail.heading));

      const titles = rail.captions.map((c) => c.title).filter(Boolean);
      record(`"${id}" cards all carry a title`, titles.length === rail.cards.length,
        `${titles.length} titles / ${rail.cards.length} cards`);

      // The crux. A rail of filenames is the thing the user complained about.
      const filenames = titles.filter(
        (t) => RELEASE_NAME_TOKENS.test(t) || DOTTED_FILENAME.test(t),
      );
      record(`"${id}" shows works, not release filenames`, filenames.length === 0,
        filenames.length ? JSON.stringify(filenames.slice(0, 5)) : `${titles.length} titles clean`);

      // Distinct *works*, not distinct strings. Four resolutions of one show
      // must be one card — but two films really can share a name (there is an
      // "Obsession" from 2025 and another from 2026), and collapsing those
      // would be the five-Dune-works bug in reverse. So the assertion is the
      // one a user could actually make: no two cards look the same. A shared
      // title is fine as long as the year distinguishes them on screen.
      const shown = rail.captions.map((c) => `${c.title} (${c.subtitle || "—"})`);
      const unique = new Set(shown.map((s) => s.toLowerCase()));
      const repeated = shown.filter((s, i) => shown.indexOf(s) !== i);
      record(`"${id}" shows no two cards a user could not tell apart`,
        unique.size === shown.length,
        repeated.length ? JSON.stringify([...new Set(repeated)]) : `${unique.size} distinct`);

      // Invariant 1. `null` availability is "nobody checked", and it must
      // render as something the user can act on.
      const dead = rail.cards.filter((c) => c.disabled);
      record(`"${id}" has no disabled cards — null availability is not "unavailable"`,
        dead.length === 0, `${dead.length} disabled of ${rail.cards.length}`);

      const claimed = rail.cards.filter(
        (c) => c.availability !== null && c.availability !== "unresolved",
      );
      record(`"${id}" claims no availability it never checked`, claimed.length === 0,
        claimed.length ? JSON.stringify(claimed.slice(0, 5)) : "all unresolved");

      const clickable = rail.cards.filter((c) => c.tag === "A" || c.tag === "BUTTON");
      record(`"${id}" cards are clickable affordances`, clickable.length === rail.cards.length,
        `${clickable.length}/${rail.cards.length}`);
    }

    // --- The essay is gone ---
    const bodyText = await page.evaluate(() => document.body.innerText);
    for (const phrase of BANNED_COPY) {
      record(`the page no longer says "${phrase}"`, !bodyText.includes(phrase));
    }
    const previews = await page.locator("[data-rail-preview]").count();
    record("no dashed placeholder rails are drawn", previews === 0, `${previews} preview rails`);

    // --- Is it actually current? ---
    // A "Trending now" row full of 1998 is a cache nobody refreshed. At least
    // one of this year's or last year's films should be on it.
    const trending = rails.find((r) => r.id === TRENDING);
    if (trending) {
      const thisYear = new Date().getFullYear();
      const railText = await page.locator(`[data-rail="${TRENDING}"]`).innerText();
      const recent = [thisYear, thisYear - 1].some((y) => railText.includes(String(y)));
      record("trending shows something from this year or last", recent,
        recent ? "" : "no recent year found in the rail");
    }

    // --- The hero ---
    // With no personal rows the hero falls back to the top of the first rail,
    // so a fresh install still opens on a title rather than on a grey box.
    const hero = await page.locator("[data-browse-hero]").count();
    record("a fresh install still has a hero", hero > 0, `data-browse-hero: ${hero}`);

    // --- Artwork: the difference between "full" and "attractive" ---
    // The catalog is only worth having because it arrives with posters. A rail
    // of correctly-named titles over empty grey frames is still not a product,
    // and it is a failure no amount of DOM text can see — the URL can be
    // perfect and the image still 404.
    await warmLazyImages(page);
    for (const id of DISCOVERY_RAILS) {
      const sel = `[data-rail="${id}"]`;
      if ((await page.locator(sel).count()) === 0) continue;

      const art = await page.$$eval(`${sel} li img`, (imgs) =>
        imgs.map((img) => ({
          src: img.currentSrc || img.getAttribute("src") || "",
          // `naturalWidth` is zero until the bytes actually arrive, so this is
          // the only check that distinguishes a real poster from a broken URL.
          width: img.naturalWidth,
        })),
      );

      const loaded = art.filter((a) => a.width > 0);
      record(`"${id}" cards show artwork that really loaded`,
        art.length >= 8 && loaded.length >= art.length - 2,
        `${loaded.length}/${art.length} images decoded`);

      // Next rewrites the src through its optimiser, so the origin is read out
      // of the encoded upstream URL rather than off the attribute directly.
      const fromCatalog = art.filter((a) => {
        try {
          return decodeURIComponent(a.src).includes("image.tmdb.org");
        } catch {
          return false;
        }
      });
      record(`"${id}" artwork comes from the catalog, not from a guess`,
        art.length > 0 && fromCatalog.length >= Math.ceil(art.length * 0.8),
        `${fromCatalog.length}/${art.length} from image.tmdb.org`);
    }

    // --- What the catalog actually stored ---
    // The rails render a projection; these are the columns behind it. A poster
    // that is on screen but not in the row means something is being resolved
    // at render time, which is the one thing this layer must never do.
    const stored = await prisma.catalogEntry.findMany({
      where: { source: { in: ["trending", "popular"] } },
      select: { title: true, posterUrl: true, overview: true, rating: true,
                seeders: true, bestRelease: true, year: true },
    });

    record("the catalog cached rows rather than resolving them per request",
      stored.length >= 24, `${stored.length} CatalogEntry rows`);

    const withPoster = stored.filter((r) => r.posterUrl);
    record("nearly every cached row has a poster",
      stored.length > 0 && withPoster.length >= stored.length * 0.9,
      `${withPoster.length}/${stored.length}`);

    const withOverview = stored.filter((r) => r.overview && r.overview.length > 20);
    const withRating = stored.filter((r) => typeof r.rating === "number" && r.rating > 0);
    record("the catalog stores synopses and ratings, not just names",
      withOverview.length >= 10 && withRating.length >= 10,
      `${withOverview.length} synopses, ${withRating.length} ratings`);

    // Honesty, on the numbers. The torrent charts and the catalog chart are
    // different lists; a *complete* match would mean the cross-reference is
    // rubber-stamping rather than checking.
    const matched = stored.filter((r) => r.seeders > 0);
    record("seeder counts come from a real cross-reference, not from every row",
      matched.length > 0 && matched.length < stored.length,
      `${matched.length}/${stored.length} rows matched a chart release`);

    const unbacked = stored.filter((r) => r.seeders > 0 && !r.bestRelease);
    record("no row reports a swarm without naming the release it counted",
      unbacked.length === 0,
      unbacked.length ? JSON.stringify(unbacked.slice(0, 3).map((r) => r.title)) : "");

    await page.screenshot({ path: path.join(OUT, "discovery-1440.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1_000);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
    record("at 390px the fresh board does not overflow", overflow <= 391, `scrollWidth ${overflow}`);
    await warmLazyImages(page);
    await page.screenshot({ path: path.join(OUT, "discovery-390.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    // ---------------------------------------------------------------------
    // Phase 2: one personal row, which turns on "Because you're watching…".
    //
    // The seed is deliberately a *film that is not in the trending feed*.
    // That is the case that exposed the defect this phase guards: the related
    // row is drawn from the same cache the discovery rails render, so when
    // the cache was only as deep as one rail, an unanchored movie seed
    // produced a verbatim copy of "Trending now" sitting directly above
    // "Trending now".
    // ---------------------------------------------------------------------
    console.log("\n── One thing watched, which is what turns the related row on ──");
    await seedWatched(prisma);
    try {
      await page.goto(BASE, { waitUntil: "networkidle", timeout: 120_000 });
      await page.waitForTimeout(2_500);

      const withPersonal = await readRails(page);
      await warmLazyImages(page);
      for (const rail of withPersonal) {
        console.log(`  rail ${rail.id} (${rail.cards.length}): ${JSON.stringify(rail.captions.slice(0, 6).map((c) => c.title))}`);
      }

      const order = withPersonal.map((r) => r.id);
      const because = withPersonal.find((r) => r.id === BECAUSE);
      record(`the "${BECAUSE}" rail appears once something has been watched`, Boolean(because),
        JSON.stringify(order));

      if (because) {
        record("the related row names the thing actually being watched",
          because.heading.includes(SEED_TITLE),
          `heading: "${because.heading}"`);

        // Personal before discovery: Continue Watching is the most valuable
        // row in the product and must not be pushed under a trending row.
        const firstDiscovery = order.findIndex((id) => DISCOVERY_RAILS.includes(id));
        const continueIdx = order.indexOf("continue-watching");
        record("personal rails come before discovery rails",
          continueIdx >= 0 && firstDiscovery > continueIdx,
          `order: ${JSON.stringify(order)}`);

        const trendingRail = withPersonal.find((r) => r.id === TRENDING);
        if (trendingRail) {
          const titlesOf = (r) => r.captions.map((c) => `${c.title} (${c.subtitle})`);
          const becauseTitles = titlesOf(because);
          const trendingTitles = titlesOf(trendingRail);

          record("the related row is not a verbatim copy of the trending row",
            JSON.stringify(becauseTitles) !== JSON.stringify(trendingTitles),
            `because[0..3]=${JSON.stringify(becauseTitles.slice(0, 3))} trending[0..3]=${JSON.stringify(trendingTitles.slice(0, 3))}`);

          // A reorder of the same titles is just as obviously broken to a
          // human as an exact copy, so overlap is measured as a set.
          const shared = becauseTitles.filter((t) => trendingTitles.includes(t));
          const overlap = becauseTitles.length ? shared.length / becauseTitles.length : 0;
          record("the related row is mostly titles the page is not already showing",
            overlap <= 0.5,
            `${shared.length}/${becauseTitles.length} shared with "${TRENDING}" (${Math.round(overlap * 100)}%)`);
        }

        record("the related row never suggests the thing being watched",
          !because.captions.some((c) => c.title.toLowerCase() === SEED_TITLE.toLowerCase()),
          `titles: ${JSON.stringify(because.captions.slice(0, 4).map((c) => c.title))}`);

        // The related row is built from the catalog's own recommendations, so
        // its cards carry the catalog's artwork like any other. A row of named
        // titles over empty frames would be the one row on the page that
        // looked unfinished.
        const becauseArt = await page.$$eval(`[data-rail="${BECAUSE}"] li img`, (imgs) =>
          imgs.map((img) => img.naturalWidth),
        );
        record("the related row has artwork of its own",
          becauseArt.length > 0 && becauseArt.filter((w) => w > 0).length >= becauseArt.length - 2,
          `${becauseArt.filter((w) => w > 0).length}/${becauseArt.length} images decoded`);
      }

      await warmLazyImages(page);
      await page.screenshot({ path: path.join(OUT, "personal-plus-discovery-1440.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(1_000);
      await warmLazyImages(page);
      await page.screenshot({ path: path.join(OUT, "personal-plus-discovery-390.png"), fullPage: true });    } finally {
      await unseedWatched(prisma);
    }

    await context.close();
  } finally {
    // Nothing was seeded, so there is nothing to unseed. The catalog rows the
    // page filled itself with are left in place: they are cache, and deleting
    // them would only make the next run slower.
    await prisma.$disconnect().catch(() => {});
    await browser.close();
  }

  console.log(`\nScreenshots: ${OUT}`);
  if (failures.length) {
    console.log(`\nshoot-discovery: ${failures.length} FAILED — ${JSON.stringify(failures)}`);
    process.exit(1);
  }
  console.log("\na brand-new install is full of real titles");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
