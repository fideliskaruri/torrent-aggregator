/**
 * Unit tests for the catalog layer — the code that turns three static apibay
 * top-100 files into the rows a fresh install's home page is built from.
 *
 * Offline by construction. Nothing here opens a socket or touches Prisma: the
 * two things worth testing are pure, and both have a specific way of failing
 * that is invisible until a human looks at the page.
 *
 *   1. **Release names becoming works.** This is the crux and the part most
 *      likely to look like garbage. `House of the Dragon S03E05 480p
 *      x264-mSD` must produce the card "House of the Dragon" — not the
 *      filename, not "House", and not four separate cards for four
 *      resolutions.
 *   2. **Not claiming things.** `availability: null` is "nobody checked", and
 *      the moment it renders as "unavailable" the product is lying about
 *      titles it never searched for.
 *
 * The identity rules themselves belong to `@/lib/torrents/work-identity` and
 * are tested there. What is asserted below is that this module *uses* them —
 * that grouping, ranking and typing are built on that key rather than on a
 * second, subtly different notion of what a title is.
 */
import assert from "node:assert/strict";

import { workIdentity } from "@/lib/torrents/work-identity";
import { parseFeedBody, type FeedRelease } from "./feeds";
import {
  buildAvailabilityIndex,
  catalogWorkKey,
  emptyAvailabilityIndex,
  matchAvailability,
} from "./availability";
import { parseTmdbList, tmdbImageUrl, type TmdbTitle } from "./tmdb";
import {
  collapseToWorks,
  isRenderableWorkName,
  pickRelated,
  resolveWorkMediaType,
  seedWorkKeys,
  type RelatableWork,
  type TypedRelease,
} from "./works";
import { catalogEntryId, dedupeByWorkKey, draftFromTmdb, type CatalogRowDraft } from "./store";
import { CATALOG_TTL_MS, isStale, RAIL_HEAD, WORKS_PER_SOURCE } from "./refresh";
import { toRailItem, DISCOVERY_RAIL_SIZE } from "@/lib/browse/discovery";
import type { CatalogRow } from "./store";
import type { MediaType } from "@/lib/metadata/media-type";

// ---------------------------------------------------------------------------
// parseFeedBody — the shape apibay actually returns
// ---------------------------------------------------------------------------
// The precompiled files type their numbers as numbers; `q.php` types the same
// fields as strings. Both shapes reach this parser, and a `"9594"` that
// silently became `NaN` would rank the most popular film in the world last.

const FEED_SHAPE_CASES: Array<{
  what: string;
  body: unknown;
  expect: (releases: FeedRelease[]) => void;
}> = [
  {
    what: "numeric fields (precompiled shape)",
    body: [
      {
        id: 1,
        name: "Obsession.2026.1080p.AMZN.WEB-DL.DDP5.1.H264.MP4-BTM",
        info_hash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
        seeders: 9594,
        leechers: 812,
        size: 2_400_000_000,
      },
    ],
    expect: (r) => {
      assert.equal(r.length, 1);
      assert.equal(r[0].seeders, 9594);
      assert.equal(r[0].leechers, 812);
      assert.equal(r[0].sizeBytes, 2_400_000_000);
      // Hashes are compared case-insensitively everywhere else in this repo,
      // so they are stored one way here rather than at each comparison.
      assert.equal(r[0].infoHash, "abcdef0123456789abcdef0123456789abcdef01");
    },
  },
  {
    what: "string fields (q.php shape)",
    body: [
      { name: "Some Film 2024 1080p", seeders: "412", leechers: "9", size: "700" },
    ],
    expect: (r) => {
      assert.equal(r[0].seeders, 412);
      assert.equal(r[0].leechers, 9);
      assert.equal(r[0].sizeBytes, 700);
    },
  },
  {
    what: "apibay's placeholder for an empty list",
    // apibay answers "nothing found" with one fake row rather than `[]`.
    // Rendering it would put a card reading "No results returned" on the home
    // page of a brand-new install.
    body: [{ id: 0, name: "No results returned", info_hash: "0".repeat(40), seeders: 0 }],
    expect: (r) => assert.deepEqual(r, []),
  },
  {
    what: "rows with no usable name",
    body: [{ name: "" }, { name: "   " }, { seeders: 5 }, { name: 42 }],
    expect: (r) => assert.deepEqual(r, []),
  },
  {
    what: "missing numbers default to zero, not NaN",
    body: [{ name: "A Film With No Numbers" }],
    expect: (r) => {
      assert.equal(r[0].seeders, 0);
      assert.equal(r[0].leechers, 0);
      // Zero bytes is not a size anyone can act on, so it is null rather than 0.
      assert.equal(r[0].sizeBytes, null);
    },
  },
  {
    what: "a body that is not a list at all",
    // An edge that returns an error object, an HTML block page, or `null`
    // must read as "no data", never crash a refresh.
    body: { error: "rate limited" },
    expect: (r) => assert.deepEqual(r, []),
  },
  { what: "null body", body: null, expect: (r) => assert.deepEqual(r, []) },
  { what: "string body", body: "<html>403</html>", expect: (r) => assert.deepEqual(r, []) },
];

for (const c of FEED_SHAPE_CASES) {
  c.expect(parseFeedBody(c.body));
}

// ---------------------------------------------------------------------------
// isRenderableWorkName — structural rejection only
// ---------------------------------------------------------------------------
// The rule class is "a name a card cannot show", never "a title we don't like".
// A blocklist would eventually decide a real film is not real.

const RENDERABLE_CASES: Array<[string, boolean]> = [
  ["House of the Dragon", true],
  ["Dune: Prophecy", true],
  ["M", false], // one character reads as a typo on a card
  ["Up", true], // two characters is a real film
  ["12", false], // no letter at all reads as a code
  ["2012", false],
  ["...", false],
  ["", false],
  ["   ", false],
  [" F1 ", true], // trimmed, then judged
  ["Æon Flux", true], // non-ASCII letters are letters
  ["君の名は", true], // \p{L}, not [a-z]
];

for (const [name, expected] of RENDERABLE_CASES) {
  assert.equal(
    isRenderableWorkName(name),
    expected,
    `isRenderableWorkName(${JSON.stringify(name)}) should be ${expected}`,
  );
}

// ---------------------------------------------------------------------------
// resolveWorkMediaType — overridden in exactly one direction
// ---------------------------------------------------------------------------
// A feed category is a human's coarse guess; a release name that says S03E05
// is self-describing. So episode structure can promote a thing to a series,
// but the *absence* of episode structure can never demote one — season packs,
// specials and miniseries all lack a marker and are still television.

const MEDIA_TYPE_CASES: Array<[string | null | undefined, boolean, MediaType | null]> = [
  ["movie", false, "movie"],
  ["tv", false, "tv"], // a season pack in a TV feed stays TV
  ["tv", true, "tv"],
  ["anime", true, "anime"], // anime is already a series; do not rewrite it to tv
  ["anime", false, "anime"],
  ["movie", true, "tv"], // the one override: episodes beat the category
  ["Movie", true, "tv"], // casing must not change the verdict
  ["MOVIE", false, "movie"],

  // Nothing to normalise means nothing to claim. The caller drops the work
  // rather than defaulting it, because the type picks the search category a
  // card links to and a wrong one cannot contain what was clicked.
  [null, false, null],
  [undefined, false, null],
  ["music", false, null],

  // …but a release that declares episodes is a series whatever the feed said,
  // including when the feed said nothing intelligible.
  [null, true, "tv"],
  ["music", true, "tv"],
];

for (const [declared, isSeries, expected] of MEDIA_TYPE_CASES) {
  assert.equal(
    resolveWorkMediaType(declared, isSeries),
    expected,
    `resolveWorkMediaType(${JSON.stringify(declared)}, ${isSeries}) should be ${expected}`,
  );
}

// ---------------------------------------------------------------------------
// collapseToWorks — the crux
// ---------------------------------------------------------------------------

function release(name: string, seeders: number): FeedRelease {
  return { name, seeders, leechers: 0, infoHash: null, sizeBytes: null };
}

function typed(mediaType: MediaType, ...rows: FeedRelease[]): TypedRelease[] {
  return rows.map((r) => ({ release: r, mediaType }));
}

// --- One show, many files ---
// Four files at three resolutions across two feed categories are one card.
// This is the failure the user actually complained about: a home page that is
// "a website you go to view torrent lists".
{
  const works = collapseToWorks([
    ...typed(
      "tv",
      release("House of the Dragon S03E05 480p x264-mSD", 1200),
      release("House.of.the.Dragon.S03E05.1080p.HEVC.x265-MeGusta", 4800),
      release("House.of.the.Dragon.S03E04.2160p.MAX.WEB-DL.DDP5.1.Atmos.H.265-FLUX", 900),
    ),
    // Same show arriving from the *other* TV feed. 205 and 208 are merged on
    // purpose; counting one of them would rank a show by half its audience.
    ...typed("tv", release("House of the Dragon S03E06 720p WEBRip x264-GalaxyTV", 2100)),
  ]);

  assert.equal(works.length, 1, `four files must collapse to one work, got ${works.length}`);
  assert.equal(works[0].title, "House of the Dragon");
  assert.equal(works[0].releaseCount, 4);

  // Popularity is a sum: a show with four releases in the chart outranks one
  // with a single entry, and that is the whole ordering signal.
  assert.equal(works[0].totalSeeders, 1200 + 4800 + 900 + 2100);

  // Health is a maximum, never a sum. `CatalogEntry.seeders` is shown next to
  // a title as a hint about something the user could actually download;
  // "9,000 seeders" would be true of no single file in this group.
  assert.equal(works[0].peakSeeders, 4800);
  assert.equal(
    works[0].bestRelease,
    "House.of.the.Dragon.S03E05.1080p.HEVC.x265-MeGusta",
    "bestRelease must be the healthiest release, not the first seen",
  );

  // A series has no year: its releases disagree about which one, and storing
  // one would split a show into several works.
  assert.equal(works[0].year, null);
  assert.equal(works[0].mediaType, "tv");
}

// --- Distinct works must stay distinct ---
// This repo once merged five different Dune works into a single card. The
// identity rules that fixed it live in work-identity.ts; what is asserted here
// is that this module groups on that key and does not re-merge them behind it.
{
  const works = collapseToWorks(
    typed(
      "movie",
      release("Dune.2021.2160p.UHD.BluRay.x265-TERMINAL", 500),
      release("Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX", 400),
      release("Dune.Prophecy.S01E01.The.Hidden.Hand.2160p.MAX.WEB-DL.DDP5.1-NTb", 300),
    ),
  );

  const titles = works.map((w) => w.title).sort();
  assert.equal(works.length, 3, `expected three Dune works, got ${JSON.stringify(titles)}`);
  assert.equal(new Set(works.map((w) => w.workKey)).size, 3, "three works, three keys");

  // And the series among them is recognised as one despite sitting in a movie
  // feed — the single legal override.
  const prophecy = works.find((w) => w.title.toLowerCase().startsWith("dune") && w.mediaType === "tv");
  assert.ok(prophecy, `a Dune series should be typed tv, got ${JSON.stringify(works.map((w) => [w.title, w.mediaType]))}`);
  assert.equal(prophecy.year, null, "a series carries no year");
}

// --- A title is not a prefix of itself ---
// `Breaking Bad S01E01...` once produced a work called "Breaking", because a
// scene group joined with a bare space ate the second word. A card reading
// "Breaking" is indistinguishable from a bug to anyone looking at the page.
{
  const works = collapseToWorks(
    typed("tv", release("Breaking.Bad.S01E01.1080p.BluRay.x265-RARBG", 700)),
  );
  assert.equal(works.length, 1);
  assert.equal(works[0].title, "Breaking Bad", `expected "Breaking Bad", got ${JSON.stringify(works[0].title)}`);
}

// --- Ranking is a total order ---
// Without full tie-breaks two equally-seeded works swap places between
// refreshes, the rail visibly reorders under the user, and every stored rank
// churns for no reason.
{
  const build = () =>
    collapseToWorks(
      typed(
        "movie",
        release("Zeta.Film.2024.1080p.WEB-DL", 100),
        release("Alpha.Film.2024.1080p.WEB-DL", 100),
        release("Mid.Film.2024.1080p.WEB-DL", 100),
      ),
    ).map((w) => w.title);

  assert.deepEqual(build(), ["Alpha Film", "Mid Film", "Zeta Film"]);
  assert.deepEqual(build(), build(), "ranking must be deterministic across runs");
}

{
  // Sum beats peak: five modest releases outrank one blockbuster file.
  const works = collapseToWorks(
    typed(
      "tv",
      release("Popular Show S01E01 1080p WEB", 300),
      release("Popular Show S01E02 1080p WEB", 300),
      release("Popular Show S01E03 1080p WEB", 300),
      release("One Hit Wonder S01E01 1080p WEB", 800),
    ),
  );
  assert.equal(works[0].title, "Popular Show");
  assert.equal(works[0].totalSeeders, 900);
  assert.equal(works[0].peakSeeders, 300, "peak must not inherit the sum");
}

{
  // Junk in, nothing out — never a card with an unreadable name, and never a
  // crash. A top-100 list is user-uploaded and contains all of this.
  const works = collapseToWorks([
    ...typed("movie", release("...", 900), release("12", 900), release("   ", 900)),
    ...typed("movie", release("Real Film 2025 1080p WEB-DL", 5)),
  ]);
  assert.equal(works.length, 1, `expected only the real film, got ${JSON.stringify(works.map((w) => w.title))}`);
  assert.equal(works[0].title, "Real Film");
}

{
  // Negative seeders are not a thing, but a feed can print one. Clamping keeps
  // a bad row from dragging a work's rank below zero.
  const works = collapseToWorks(
    typed("movie", release("Odd Film 2025 1080p WEB", -50), release("Odd Film 2025 720p WEB", 10)),
  );
  assert.equal(works[0].totalSeeders, 10);
  assert.equal(works[0].peakSeeders, 10);
}

assert.deepEqual(collapseToWorks([]), [], "no releases is an empty list, not a throw");

// ---------------------------------------------------------------------------
// seedWorkKeys — the same show, keyed two ways
// ---------------------------------------------------------------------------
// A seed harvested from playback progress is a display title with no episode
// marker, so it keys as a *film*; the same show arriving from a feed keys as a
// *series*. Producing only one spelling means the seed is never recognised and
// "Because you're watching House of the Dragon" opens with House of the Dragon.
{
  const keys = seedWorkKeys("House of the Dragon");
  assert.equal(keys.size, 2, "a seed must produce both the film and series spellings");

  const [feedWork] = collapseToWorks(
    typed("tv", release("House of the Dragon S03E05 1080p WEB-DL", 10)),
  );
  assert.ok(
    keys.has(feedWork.workKey),
    `seed keys ${JSON.stringify([...keys])} must contain the feed key ${feedWork.workKey}`,
  );
}

// ---------------------------------------------------------------------------
// pickRelated — honest, and cheap on purpose
// ---------------------------------------------------------------------------
// A bespoke recommender is an explicit non-goal. This row promises "other
// popular things of the same kind", and that is exactly what it must deliver:
// no films under a series heading, and never the seed recommending itself.

function pool(...entries: Array<[string, string]>): RelatableWork[] {
  return entries.map(([workKey, mediaType]) => ({ workKey, mediaType }));
}

{
  const [dragon] = collapseToWorks(typed("tv", release("House of the Dragon S03E05 1080p WEB", 10)));
  const [morty] = collapseToWorks(typed("tv", release("Rick and Morty S08E03 1080p WEB", 10)));
  const [toy] = collapseToWorks(typed("movie", release("Toy.Story.5.2026.1080p.WEB-DL", 10)));
  const [silo] = collapseToWorks(typed("tv", release("Silo S02E04 1080p WEB", 10)));

  const candidates: RelatableWork[] = [dragon, morty, toy, silo];

  const related = pickRelated(candidates, "House of the Dragon", "tv", 10);
  const keys = related.map((r) => r.workKey);

  assert.ok(
    !keys.includes(dragon.workKey),
    "the seed must never appear on its own 'because you're watching' row",
  );
  assert.ok(
    !keys.includes(toy.workKey),
    `a film must not appear under a series heading, got ${JSON.stringify(keys)}`,
  );
  assert.deepEqual(keys, [morty.workKey, silo.workKey]);
}

{
  // No stated type means no filter — declining to guess rather than sending
  // half the row to a search category that cannot contain it.
  const p = pool(["a", "tv"], ["b", "movie"], ["c", "anime"]);
  assert.equal(pickRelated(p, "Nothing In The Pool", null, 10).length, 3);
}

{
  // Adjacent popularity, when the seed is in the pool: something with a
  // comparable audience is a better neighbour than the biggest title on the
  // internet, which every other row already shows.
  const seedKey = [...seedWorkKeys("Seed Show")][0];
  const p = pool(
    ["far-above", "tv"],
    ["above", "tv"],
    [seedKey, "tv"],
    ["below", "tv"],
    ["far-below", "tv"],
  );
  const picked = pickRelated(p, "Seed Show", "tv", 4).map((r) => r.workKey);
  assert.deepEqual(picked, ["above", "below", "far-above", "far-below"]);
}

{
  // …and when the seed is *not* in the pool — the usual case, since a personal
  // library rarely intersects a top-100 — the pool's own order stands. No
  // relationship is implied beyond "popular, and the same kind of thing".
  const p = pool(["one", "tv"], ["two", "tv"], ["three", "tv"]);
  assert.deepEqual(
    pickRelated(p, "Something Nobody Uploaded", "tv", 2).map((r) => r.workKey),
    ["one", "two"],
  );
}

{
  // Media type is compared through the shared vocabulary, not with `===`
  // against a lowercase literal — a row stored as "Movie" or "series" must be
  // judged the same as "movie" or "tv".
  const p = pool(["m1", "Movie"], ["m2", "movies"], ["t1", "Series"], ["t2", "TV"]);
  assert.deepEqual(
    pickRelated(p, "Some Film", "movie", 10).map((r) => r.workKey),
    ["m1", "m2"],
  );
  assert.deepEqual(
    pickRelated(p, "Some Show", "tv", 10).map((r) => r.workKey),
    ["t1", "t2"],
  );
}

assert.deepEqual(pickRelated([], "Anything", "tv", 5), [], "an empty pool relates to nothing");
assert.deepEqual(
  pickRelated(pool(["a", "tv"]), "Anything", "tv", 0),
  [],
  "a limit of zero returns nothing rather than everything",
);

// "Because you're watching…" must not be the rail beneath it, reordered.
// This shipped once: with a 24-deep cache and a 24-wide rail, a movie seed
// that was not itself in the catalog produced a verbatim copy of "Trending
// now" directly above "Trending now".
{
  const p = pool(["a", "tv"], ["b", "tv"], ["c", "tv"], ["d", "tv"]);
  const onScreen = new Set(["a", "b"]);

  assert.deepEqual(
    pickRelated(p, "Not In The Pool", "tv", 2, onScreen).map((r) => r.workKey),
    ["c", "d"],
    "titles already on another rail must not be repeated while unseen ones exist",
  );

  assert.deepEqual(
    pickRelated(p, "Not In The Pool", "tv", 4, onScreen).map((r) => r.workKey),
    ["c", "d", "a", "b"],
    "once unseen candidates run out the row tops up rather than rendering short",
  );

  // The anchored case had the same defect: adjacency alone picks the seed's
  // neighbours, which are exactly what the popular rail already shows.
  const anchored = pickRelated(p, "B", "tv", 2, onScreen).map((r) => r.workKey);
  assert.deepEqual(
    anchored,
    ["c", "d"],
    "an anchored seed also prefers titles the page is not already showing",
  );
}

// The catalog must be kept deeper than a rail renders, or the row above can
// only ever be the row below.
assert.ok(
  WORKS_PER_SOURCE > RAIL_HEAD,
  `the cache must be deeper than a rail (${WORKS_PER_SOURCE} vs ${RAIL_HEAD}) or "Because you're watching" duplicates it`,
);
assert.equal(
  RAIL_HEAD,
  DISCOVERY_RAIL_SIZE,
  "catalog RAIL_HEAD must mirror browse DISCOVERY_RAIL_SIZE — they cannot drift",
);

// ---------------------------------------------------------------------------
// catalogEntryId — stable across refreshes, distinct across partitions
// ---------------------------------------------------------------------------
// Derived rather than random for two reasons: a refresh rewrites a whole
// source, so random ids would hand every card a new React key and remount the
// board; and SQLite treats two NULLs as distinct, so the schema's
// `@@unique([workKey, source, seedTitle])` cannot be upserted against for rows
// whose seedTitle is null — they would duplicate on every single refresh.
{
  const key = "tv:house-of-the-dragon";

  assert.equal(
    catalogEntryId("trending", null, key),
    catalogEntryId("trending", null, key),
    "the same row must keep its id across refreshes",
  );

  const distinct = new Set([
    catalogEntryId("trending", null, key),
    catalogEntryId("popular", null, key),
    catalogEntryId("related", "Silo", key),
    catalogEntryId("related", "The Bear", key),
    catalogEntryId("related", null, key),
    catalogEntryId("trending", null, "movie:dune:2021"),
  ]);
  assert.equal(distinct.size, 6, "every partition of a work must get its own row id");

  // The separator must not be forgeable out of the parts themselves, or two
  // different triples would collide into one row and a card would vanish.
  assert.notEqual(
    catalogEntryId("related", "a", "b"),
    catalogEntryId("related", "a\u0000b", ""),
  );
}

// ---------------------------------------------------------------------------
// isStale — and why a missing timestamp is stale, not fresh
// ---------------------------------------------------------------------------
{
  const now = Date.now();
  assert.equal(isStale(null, now), true, "never refreshed is stale, not fresh");
  assert.equal(isStale(new Date(now), now), false);
  assert.equal(isStale(new Date(now - CATALOG_TTL_MS + 1000), now), false);
  assert.equal(isStale(new Date(now - CATALOG_TTL_MS - 1000), now), true);
  // A clock that jumped backwards must not make a row eternally fresh in a way
  // that hides an outage; it is simply not yet stale, which self-corrects.
  assert.equal(isStale(new Date(now + 60_000), now), false);
}

// ---------------------------------------------------------------------------
// toRailItem — invariant 1, the one an independent review caught five times
// ---------------------------------------------------------------------------
// A trending title is not on disk and no indexer has been searched for it, so
// its availability is genuinely *not determined*. `null` is the honest answer,
// and the card layer renders it as a neutral, clickable "Check". Writing
// "unavailable" here would tell the user that this week's most downloaded film
// cannot be had — a claim nobody made and nobody checked.

function row(over: Partial<CatalogRow> = {}): CatalogRow {
  return {
    id: "abc123",
    workKey: "movie:obsession:2026",
    title: "Obsession",
    year: 2026,
    mediaType: "movie",
    releaseDate: null,
    posterUrl: null,
    backdropUrl: null,
    overview: null,
    rating: null,
    source: "trending",
    rank: 0,
    seedTitle: null,
    seeders: 9594,
    bestRelease: "Obsession.2026.1080p.AMZN.WEB-DL.DDP5.1.H264.MP4-BTM",
    refreshedAt: new Date(),
    ...over,
  };
}

{
  const item = toRailItem(row());

  assert.equal(item.availability, null, "availability must be null — nobody checked");

  // Not a claim either: an info hash is an assertion that a specific torrent
  // is the one behind this card, and a file path is an assertion that it is on
  // this disk. Neither has been established.
  assert.equal(item.infoHash, null);
  assert.equal(item.filePath, null);
  assert.equal(item.watchListItemId, null);

  // Nothing has been watched, so there is no progress and nothing to resume.
  assert.equal(item.progressFraction, null);
  assert.equal(item.resumePositionSec, null);
  assert.equal(item.season, null);
  assert.equal(item.episode, null);

  assert.equal(item.title, "Obsession");
  assert.equal(item.subtitle, "2026", "a film's year is worth a line");
  assert.equal(item.mediaType, "movie");
  assert.ok(item.id.length > 0);
}

{
  // A series carries no year, so it gets no subtitle rather than "null".
  const item = toRailItem(row({ title: "Silo", year: null, mediaType: "tv" }));
  assert.equal(item.subtitle, null);
  assert.equal(item.mediaType, "tv");
}

{
  // Media type goes through the shared normaliser, so a row stored with the
  // catalog's plural slug still links to a category that can contain it.
  assert.equal(toRailItem(row({ mediaType: "Movie" })).mediaType, "movie");
  assert.equal(toRailItem(row({ mediaType: "series" })).mediaType, "tv");
  assert.equal(toRailItem(row({ mediaType: "nonsense" })).mediaType, null);
}

{
  // Ids are stable and per-row, so a refresh that returns the same works does
  // not remount every card.
  assert.equal(toRailItem(row({ id: "x" })).id, toRailItem(row({ id: "x" })).id);
  assert.notEqual(toRailItem(row({ id: "x" })).id, toRailItem(row({ id: "y" })).id);
}

// A rail shows what a refresh stores; if these ever disagree, a rail is either
// permanently short or silently truncated.
assert.equal(DISCOVERY_RAIL_SIZE, 24);

// ---------------------------------------------------------------------------
// parseTmdbList — the shape TMDB actually returns
// ---------------------------------------------------------------------------
// Captured from `/3/trending/{movie,tv}/week` against the real key. Asserted
// offline because the chart changes hourly and a live assertion could only
// ever be vague — but the *parsing* is where a silent regression would hide,
// and a poster path that stopped becoming a URL would empty the home page
// without failing anything.

{
  const movies = parseTmdbList(
    {
      results: [
        {
          id: 1195506,
          title: "Disclosure Day",
          overview: "A conspiracy theorist discovers the truth.",
          release_date: "2026-01-14",
          poster_path: "/aBcDeF.jpg",
          backdrop_path: "/gHiJkL.jpg",
          vote_average: 7.283,
        },
      ],
    },
    "movie",
  );

  assert.equal(movies.length, 1);
  assert.equal(movies[0].title, "Disclosure Day");
  assert.equal(movies[0].year, 2026);
  assert.equal(movies[0].mediaType, "movie");
  assert.equal(movies[0].tmdbId, 1195506);
  assert.equal(
    movies[0].posterUrl,
    "https://image.tmdb.org/t/p/w500/aBcDeF.jpg",
    "a poster path must become a full URL, or the page renders empty frames",
  );
  assert.equal(
    movies[0].backdropUrl,
    "https://image.tmdb.org/t/p/w1280/gHiJkL.jpg",
  );
  assert.equal(movies[0].rating, 7.3, "a rating is rounded, never re-scaled");
  assert.equal(movies[0].overview, "A conspiracy theorist discovers the truth.");
}

{
  // TV rows name the same fields differently. Reading `title` only would drop
  // every series in the chart and leave "Popular series" empty.
  const shows = parseTmdbList(
    {
      results: [
        {
          id: 94997,
          name: "House of the Dragon",
          first_air_date: "2022-08-21",
          poster_path: "/z1.jpg",
          backdrop_path: null,
          vote_average: 8.4,
          overview: "",
        },
      ],
    },
    "tv",
  );

  assert.equal(shows[0].title, "House of the Dragon");
  assert.equal(shows[0].year, 2022);
  assert.equal(shows[0].mediaType, "tv");
  assert.equal(shows[0].backdropUrl, null, "no backdrop is null, not a broken URL");
  assert.equal(shows[0].overview, null, "an empty synopsis is absent, not blank");
}

{
  // TMDB returns 0 for *unrated*. Printing "0.0" under a poster would be
  // inventing a verdict nobody gave — the same class of claim as an
  // availability nobody checked.
  const unrated = parseTmdbList(
    { results: [{ id: 5, title: "Brand New Film", vote_average: 0 }] },
    "movie",
  );
  assert.equal(unrated[0].rating, null, "unrated is null, never a rating of zero");
  assert.equal(unrated[0].year, null, "no release date is no year, not 1970");
}

{
  const junk = parseTmdbList(
    {
      results: [
        { title: "No id at all" },
        { id: 7 },
        { id: 8, title: "   " },
        { id: 9, name: "Some Actor", media_type: "person", profile_path: "/p.jpg" },
        { id: 10, title: "Real Film", release_date: "2025-06-01" },
        { id: 10, title: "Real Film (duplicate page)" },
      ],
    },
    "movie",
  );

  assert.deepEqual(
    junk.map((t) => t.title),
    ["Real Film"],
    "rows without an id or a title are dropped, people are not titles, and a title repeated across pages is stored once",
  );
}

{
  // Not a list, not an object, nothing at all: none of these may throw. A body
  // that changed shape must cost the page its discovery rows and nothing else.
  assert.deepEqual(parseTmdbList(null, "movie"), []);
  assert.deepEqual(parseTmdbList({}, "movie"), []);
  assert.deepEqual(parseTmdbList({ results: "nope" }, "movie"), []);
  assert.deepEqual(parseTmdbList({ results: [null, 3, "x"] }, "movie"), []);
}

{
  assert.equal(tmdbImageUrl(null, "w500"), null);
  assert.equal(tmdbImageUrl("", "w500"), null);
  // TMDB paths are absolute. Anything else is not a path this can build on.
  assert.equal(tmdbImageUrl("relative.jpg", "w500"), null);
  assert.equal(tmdbImageUrl("/a.jpg", "w500"), "https://image.tmdb.org/t/p/w500/a.jpg");
}

// ---------------------------------------------------------------------------
// catalogWorkKey — one vocabulary across a catalog with two sources
// ---------------------------------------------------------------------------
// A TMDB title and an apibay release name have to agree on what counts as the
// same work, or the seeder cross-reference matches nothing. Both sides go
// through `workIdentity`; this asserts the catalog side is handed the shape
// that function expects to read.

{
  assert.equal(
    catalogWorkKey("The Odyssey", 2026, "movie"),
    workIdentity("The.Odyssey.2026.1080p.TELESYNC.HEVC.AAC2.0-SPLiCE").key,
    "a film's catalog key must equal the key its own releases produce",
  );

  assert.equal(
    catalogWorkKey("House of the Dragon", 2022, "tv"),
    workIdentity("House of the Dragon S03E05 480p x264-mSD").key,
    "a series' catalog key must equal the key its own episodes produce",
  );

  // A series' identity must not carry a year: its releases span years, and a
  // year would split one show into a card per season.
  assert.ok(
    !catalogWorkKey("House of the Dragon", 2022, "tv").includes("2022"),
    "a series key must not carry a year",
  );

  // Two films with the same name and different years are two films. This is
  // the Dune defect the work-identity rules exist for, seen from the catalog
  // side rather than the release side.
  assert.notEqual(
    catalogWorkKey("Dune", 1984, "movie"),
    catalogWorkKey("Dune", 2021, "movie"),
  );

  assert.equal(catalogWorkKey("", null, "movie"), "", "an empty title has no key");
}

// ---------------------------------------------------------------------------
// The availability overlay — a health hint, and never more than that
// ---------------------------------------------------------------------------

{
  const charts = collapseToWorks([
    ...typed("movie", release("The.Odyssey.2026.1080p.WEB-DL-SPLiCE", 6162)),
    ...typed("movie", release("The.Odyssey.2026.2160p.WEB-DL-FLUX", 900)),
    ...typed("movie", release("Some.Festival.Film.2025.1080p.WEB-DL", 300)),
    ...typed("tv", release("House of the Dragon S03E05 480p x264-mSD", 4100)),
  ]);
  const index = buildAvailabilityIndex(charts);

  const odyssey = matchAvailability(
    index,
    catalogWorkKey("The Odyssey", 2026, "movie"),
    2026,
  );
  assert.ok(odyssey, "a chart release of a trending film must be found");
  assert.equal(
    odyssey.peakSeeders,
    6162,
    "the stored count is the best single release, never the sum of them",
  );
  assert.equal(odyssey.bestRelease, "The.Odyssey.2026.1080p.WEB-DL-SPLiCE");

  const dragon = matchAvailability(
    index,
    catalogWorkKey("House of the Dragon", 2022, "tv"),
    2022,
  );
  assert.ok(dragon, "a series must match on its year-free key");
  assert.equal(dragon.peakSeeders, 4100);

  // TMDB dates and release-name years disagree at the turn of a year and
  // across festival/wide-release splits, so one year of slack is allowed.
  assert.ok(
    matchAvailability(index, catalogWorkKey("Some Festival Film", 2026, "movie"), 2026),
    "one year of slack must still match the same film",
  );

  // And no more than one. A remake is not its original, and a seeder count
  // borrowed across a decade would describe something else entirely.
  assert.equal(
    matchAvailability(index, catalogWorkKey("Some Festival Film", 2015, "movie"), 2015),
    null,
    "a film ten years apart is a different film",
  );

  // The common case: TMDB's chart and a torrent chart overlap, they are not
  // the same list. A miss must be null, not a plausible-looking number.
  assert.equal(
    matchAvailability(index, catalogWorkKey("Nothing Like This Exists", 2026, "movie"), 2026),
    null,
  );

  assert.equal(
    matchAvailability(emptyAvailabilityIndex(), catalogWorkKey("The Odyssey", 2026, "movie"), 2026),
    null,
    "an unreachable chart matches nothing rather than guessing",
  );
}

// ---------------------------------------------------------------------------
// draftFromTmdb — the regression that made TMDB the catalog in the first place
// ---------------------------------------------------------------------------

{
  const title: TmdbTitle = {
    tmdbId: 218230,
    kind: "tv",
    title: "A Shop for Killers",
    year: 2024,
    mediaType: "tv",
    posterUrl: "https://image.tmdb.org/t/p/w500/shop.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w1280/shop-wide.jpg",
    overview: "A woman inherits her uncle's shop.",
    rating: 7.9,
    releaseDate: "2024-01-17",
  };

  const key = catalogWorkKey(title.title, title.year, title.mediaType);
  const draft = draftFromTmdb(title, key, null);

  // THE assertion. `workIdentity` reads "Killers" as a scene group and returns
  // the work name "A Shop for" — correct for a release name, catastrophic for
  // a canonical title. A catalog title is TMDB's, verbatim, always.
  assert.equal(
    draft.title,
    "A Shop for Killers",
    "a canonical title must never be round-tripped through release-name cleaning",
  );
  assert.notEqual(draft.title, "A Shop for");

  assert.equal(draft.posterUrl, title.posterUrl);
  assert.equal(draft.overview, title.overview);
  assert.equal(draft.rating, 7.9);

  // Invariant 2, on the numbers rather than on availability: no chart release
  // was matched, so there is nothing to say about a swarm.
  assert.equal(draft.seeders, 0, "an unmatched title claims no seeders");
  assert.equal(draft.bestRelease, null, "an unmatched title names no release");

  const matched = draftFromTmdb(title, key, {
    peakSeeders: 4100,
    bestRelease: "A.Shop.for.Killers.S01E01.1080p.WEB-DL",
  });
  assert.equal(matched.seeders, 4100);
  assert.equal(matched.bestRelease, "A.Shop.for.Killers.S01E01.1080p.WEB-DL");
  assert.equal(
    matched.title,
    "A Shop for Killers",
    "matching a release must not let the release name leak into the title",
  );
}

// ---------------------------------------------------------------------------
// dedupeByWorkKey — a rail that is shorter than it looks
// ---------------------------------------------------------------------------
// A partition's primary key is derived from its work key, so two drafts that
// key the same upsert the same row: the second takes the first's rank and
// leaves a gap. TMDB paging genuinely returns a repeat when a chart reorders
// mid-request, so this is a real case rather than a defensive one.

{
  const draft = (workKey: string, title: string): CatalogRowDraft => ({
    workKey,
    title,
    year: null,
    mediaType: "movie",
    releaseDate: null,
    posterUrl: null,
    backdropUrl: null,
    overview: null,
    rating: null,
    seeders: 0,
    bestRelease: null,
  });

  const deduped = dedupeByWorkKey([
    draft("film:a:", "A"),
    draft("film:b:", "B"),
    draft("film:a:", "A again, from page two"),
    draft("", "no key at all"),
  ]);

  assert.deepEqual(
    deduped.map((d) => d.title),
    ["A", "B"],
    "the higher-ranked draft wins and a keyless draft is dropped",
  );
}

console.log("catalog: ok");
