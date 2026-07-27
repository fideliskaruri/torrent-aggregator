/**
 * Artwork resolution.
 *
 * The bug this module exists for: every movie and TV card rendered as a grey
 * tile with one letter, because TMDB was gated on a truthy `TMDB_API_KEY` and
 * `.env` held the placeholder `xx`. The provider looked configured, every
 * request 401'd, and nothing said so.
 *
 * The bug it must not cause: a card wearing a *different* work's poster. That
 * has shipped here before. So the tests below spend most of their weight on
 * refusals — the wrong year, the wrong instalment, the wrong show — because
 * returning a URL is easy and returning the *right* URL is the whole job.
 *
 * Nothing here touches the network; `globalThis.fetch` is stubbed throughout.
 */
import assert from "node:assert/strict";

import {
  chooseBest,
  cleanQueryTitle,
  matchTier,
  resetArtworkCache,
  resolveArtwork,
  resolveArtworkBatch,
} from "./artwork";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

const REAL_SHAPED_KEY = "6f1a2b3c4d5e6f708192a3b4c5d6e7f8";
const IMG = "https://image.tmdb.org/t/p";

// --- fetch stubbing -------------------------------------------------------

interface Call {
  url: string;
}

type Handler = (url: string) => unknown | Promise<unknown>;

let calls: Call[] = [];
let originalFetch: typeof globalThis.fetch;

/**
 * Install a stub that answers with `handler(url)`.
 *
 * Returning `undefined` from the handler means "this provider has nothing";
 * returning a `Response` means "answer exactly this"; anything else is sent
 * back as JSON.
 */
function installFetch(handler: Handler) {
  calls = [];
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input instanceof URL ? input.toString() : input);
    calls.push({ url });
    const out = await handler(url);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function urlsMatching(fragment: string): string[] {
  return calls.filter((c) => c.url.includes(fragment)).map((c) => c.url);
}

/** Fresh cache + fresh key state before every scenario. */
function scenario(key: string | null) {
  resetArtworkCache();
  if (key === null) delete process.env.TMDB_API_KEY;
  else process.env.TMDB_API_KEY = key;
}

// --- fixtures (shapes copied from real responses) -------------------------

const tmdbMovie = (
  title: string,
  release: string,
  poster: string,
  backdrop: string | null,
  popularity = 1,
) => ({
  id: Math.floor(Math.random() * 1e6),
  media_type: "movie",
  title,
  release_date: release,
  poster_path: poster,
  backdrop_path: backdrop,
  popularity,
});

const tmdbTv = (
  name: string,
  firstAir: string,
  poster: string,
  backdrop: string | null,
  popularity = 1,
) => ({
  id: Math.floor(Math.random() * 1e6),
  media_type: "tv",
  name,
  first_air_date: firstAir,
  poster_path: poster,
  backdrop_path: backdrop,
  popularity,
});

/** The real /search/movie?query=dune&year=2024 ordering, verified live. */
const TMDB_DUNE = {
  results: [
    tmdbMovie("Dune", "2021-09-15", "/dune2021.jpg", "/dune2021-bd.jpg", 34.12),
    tmdbMovie(
      "Dune: Part Two",
      "2024-02-27",
      "/dunept2.jpg",
      "/dunept2-bd.jpg",
      28.85,
    ),
    tmdbMovie(
      "Anatomy of a Fall",
      "2023-08-23",
      "/anatomy.jpg",
      "/anatomy-bd.jpg",
      14.27,
    ),
    tmdbMovie("The Dune", "2025-03-23", "/thedune.jpg", null, 0.16),
    tmdbMovie("Dune", "1984-12-14", "/dune1984.jpg", "/dune1984-bd.jpg", 12.5),
  ],
};

const ITUNES_DUNE = {
  resultCount: 5,
  results: [
    {
      trackName: "Dune",
      kind: "feature-movie",
      releaseDate: "2021-09-15T07:00:00Z",
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/a/b/100x100bb.jpg",
    },
    {
      trackName: "Dune: Part Two",
      kind: "feature-movie",
      releaseDate: "2024-03-01T08:00:00Z",
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/c/d/100x100bb.jpg",
    },
    {
      trackName: "Dune",
      kind: "feature-movie",
      releaseDate: "1985-01-01T08:00:00Z",
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/e/f/100x100bb.jpg",
    },
    {
      trackName: "Season 11, Episode 2: Frank Falls Out the Window",
      kind: "tv-episode",
      releaseDate: "2016-01-13T08:00:00Z",
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/g/h/100x100bb.png",
    },
    {
      // Audiobooks come back with no kind and no trackName at all.
      releaseDate: "2007-05-29T07:00:00Z",
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/i/j/100x100bb.jpg",
    },
  ],
};

const TVMAZE_SEVERANCE = [
  {
    score: 0.903,
    show: {
      id: 41425,
      name: "Severance",
      premiered: "2022-02-18",
      image: {
        medium: "https://static.tvmaze.com/uploads/images/medium/548/1371406.jpg",
        original:
          "https://static.tvmaze.com/uploads/images/original_untouched/548/1371406.jpg",
      },
    },
  },
  {
    score: 0.209,
    show: {
      id: 99999,
      name: "Aligned Reverence",
      premiered: "2025-12-05",
      image: {
        original:
          "https://static.tvmaze.com/uploads/images/original_untouched/603/1509559.jpg",
      },
    },
  },
];

const anilist = (media: unknown[]) => ({ data: { Page: { media } } });

const ANILIST_FRIEREN = anilist([
  {
    id: 154587,
    title: {
      romaji: "Sousou no Frieren",
      english: "Frieren: Beyond Journey's End",
    },
    coverImage: { extraLarge: "https://anilist.example/frieren-xl.jpg" },
    bannerImage: null,
    averageScore: 90,
    seasonYear: 2023,
    genres: ["Adventure"],
  },
]);

// =========================================================================

async function main() {
  originalFetch = globalThis.fetch;
  const originalKey = process.env.TMDB_API_KEY;
  const originalTimeout = process.env.ARTWORK_TIMEOUT_MS;

  try {
    await matchingRules();
    await tmdbPath();
    await refusals();
    await keylessFallbacks();
    await animePath();
    await cachingBehaviour();
    await batchBehaviour();
    await resilience();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = originalKey;
    if (originalTimeout === undefined) delete process.env.ARTWORK_TIMEOUT_MS;
    else process.env.ARTWORK_TIMEOUT_MS = originalTimeout;
  }

  if (failures > 0) {
    console.error(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("  all passed");
}

/**
 * The rule class, not the reported example: *extra words that name an
 * instalment mean a different work; extra words that describe mean the same
 * work.* Table-driven over many franchises, because "Dune" was only the title
 * that happened to be on screen when the bug was noticed.
 */
async function matchingRules() {
  console.log("metadata/artwork title matching");

  const ACCEPT: [string, string][] = [
    ["Dune", "Dune"],
    ["dune", "DUNE"],
    ["Dune Part Two", "Dune: Part Two"],
    ["The Odyssey", "Odyssey"],
    ["Odyssey", "The Odyssey"],
    ["Frieren", "Frieren: Beyond Journey's End"],
    ["Frieren Beyond Journeys End", "Frieren"],
    ["Attack on Titan Final Season", "Attack on Titan: The Final Season"],
    ["House of the Dragon", "House of the Dragon"],
    ["Breaking Bad", "Breaking Bad"],
    ["Pokemon", "Pokémon"],
    ["Fast and Furious", "Fast & Furious"],
    ["Bofuri", "Bofuri: I Don't Want to Get Hurt, so I'll Max Out My Defense"],
  ];

  const REJECT: [string, string][] = [
    ["Dune", "Dune: Part Two"],
    ["Dune", "Children of Dune"],
    ["Dune Part Two", "Dune"],
    ["Kill Bill", "Kill Bill: Vol. 2"],
    ["Up", "Up in the Air"],
    ["It", "It Chapter Two"],
    ["Severance", "Severance Package"],
    ["Alien", "Aliens"],
    ["Rocky", "Rocky IV"],
    ["Spider-Man", "Spider-Man 2"],
    ["The Bear", "The Bear Season 3"],
    ["Frieren", "Attack on Titan"],
    ["Breaking Bad", "Better Call Saul"],
    // Companion releases. Found live: with no key, "The Odyssey" (2026) had
    // been taking iTunes' documentary poster, because an exact title from the
    // wrong year scores below a subtitle from the right year.
    ["The Odyssey", "The Odyssey: The Real Story"],
    ["The Odyssey", "The Odyssey: The Making of an Epic"],
    ["Dune", "Dune: Behind the Scenes"],
    ["Severance", "Severance: The Untold Story"],
  ];

  for (const [q, c] of ACCEPT) {
    check(`match: "${q}" ~ "${c}"`, () => {
      assert.ok(
        matchTier(q, c) >= 60,
        `expected >= 60, got ${matchTier(q, c).toFixed(1)}`,
      );
    });
  }

  for (const [q, c] of REJECT) {
    check(`no match: "${q}" !~ "${c}"`, () => {
      assert.ok(
        matchTier(q, c) < 60,
        `expected < 60, got ${matchTier(q, c).toFixed(1)}`,
      );
    });
  }

  // A bare trailing year is a year — unless it is part of the title. This is
  // the `Blade Runner 2049` regression `enrich` already documents.
  check("a trailing year is lifted out of the title", () => {
    assert.deepEqual(cleanQueryTitle("Dune 2021"), { title: "Dune", year: 2021 });
    assert.deepEqual(cleanQueryTitle("Severance (2022)"), {
      title: "Severance",
      year: 2022,
    });
  });
  check("a title's own digits survive", () => {
    assert.deepEqual(cleanQueryTitle("Blade Runner 2049"), {
      title: "Blade Runner 2049",
      year: null,
    });
    assert.deepEqual(cleanQueryTitle("1917"), { title: "1917", year: null });
  });
  check("episode noise collapses to the show, so a rail asks once", () => {
    assert.equal(cleanQueryTitle("Severance S02E05 1080p WEB-DL").title, "Severance");
    assert.equal(cleanQueryTitle("Severance S02E06 2160p HEVC").title, "Severance");
  });

  // Nothing above the bar means no artwork, not "the closest thing".
  check("chooseBest returns null when nothing is plausible", () => {
    const best = chooseBest({ title: "Dune", year: 2021, mediaType: "movie" }, [
      {
        title: "Dune: Part Two",
        year: 2024,
        posterUrl: "p",
        backdropUrl: null,
        kind: "movie",
        popularity: 99,
        provider: "tmdb",
      },
    ]);
    assert.equal(best, null);
  });

  // Two titles that differ only by an article are usually one work in two
  // catalogs ("The Odyssey"/"Odyssey") but sometimes two works ("Dune"/"The
  // Dune", 2025). It has to rank below a real exact match so the real one wins
  // whenever it exists, and stay inside reach of the year penalty when it does
  // not.
  check("an article-only match ranks below a true exact match", () => {
    assert.ok(matchTier("Dune", "The Dune") >= 60);
    assert.ok(matchTier("Dune", "The Dune") < matchTier("Dune", "Dune"));
  });
  check("an article-only match loses to the wrong year", () => {
    const best = chooseBest({ title: "Dune", year: 2021, mediaType: "movie" }, [
      {
        title: "The Dune",
        year: 2025,
        posterUrl: "wrong",
        backdropUrl: null,
        kind: "movie",
        popularity: 99,
        provider: "tmdb",
      },
    ]);
    assert.equal(best, null);
  });
  // A subtitle match is real ("Frieren" -> "Frieren: Beyond Journey's End") but
  // must never outrank the work that carries the title exactly.
  check("an exact match outranks a subtitle match", () => {
    assert.ok(
      matchTier("Dune", "Dune") > matchTier("Dune", "Dune: Prophecy"),
      "an exact title must win over a same-prefixed spin-off",
    );
  });
}

async function tmdbPath() {
  console.log("metadata/artwork TMDB");

  scenario(REAL_SHAPED_KEY);
  installFetch((url) => (url.includes("themoviedb.org") ? TMDB_DUNE : undefined));

  const partTwo = await resolveArtwork({
    title: "Dune Part Two",
    year: 2024,
    mediaType: "movie",
  });
  check("an exact film title with its year takes that film", () => {
    assert.equal(partTwo.posterUrl, `${IMG}/w500/dunept2.jpg`);
  });
  check("the backdrop comes back too — the detail hero needs it", () => {
    assert.equal(partTwo.backdropUrl, `${IMG}/w1280/dunept2-bd.jpg`);
  });
  check("a movie query goes to /search/movie with the year", () => {
    const hit = urlsMatching("/search/movie")[0];
    assert.ok(hit, "expected a /search/movie call");
    assert.ok(hit.includes("year=2024"), hit);
  });

  // TMDB answered this exact query with *Dune* (2021) in first place and
  // *Dune: Part Two* (2024) second — verified live. Ranking must come from the
  // year asked for, not from the provider's order.
  scenario(REAL_SHAPED_KEY);
  installFetch((url) => (url.includes("themoviedb.org") ? TMDB_DUNE : undefined));
  const dune2021 = await resolveArtwork({
    title: "Dune",
    year: 2021,
    mediaType: "movie",
  });
  check("the year decides between two films of the same name", () => {
    assert.equal(dune2021.posterUrl, `${IMG}/w500/dune2021.jpg`);
  });

  scenario(REAL_SHAPED_KEY);
  installFetch((url) => (url.includes("themoviedb.org") ? TMDB_DUNE : undefined));
  const duneAny = await resolveArtwork({
    title: "Dune",
    year: null,
    mediaType: "movie",
  });
  check("with no year, popularity breaks the tie between 1984 and 2021", () => {
    assert.equal(duneAny.posterUrl, `${IMG}/w500/dune2021.jpg`);
  });

  scenario(REAL_SHAPED_KEY);
  installFetch((url) =>
    url.includes("themoviedb.org")
      ? {
          results: [
            tmdbTv("Severance", "2022-02-17", "/sev.jpg", "/sev-bd.jpg", 46.4),
          ],
        }
      : undefined,
  );
  const sev = await resolveArtwork({
    title: "Severance",
    year: 2022,
    mediaType: "tv",
  });
  check("a tv query goes to /search/tv with first_air_date_year", () => {
    const hit = urlsMatching("/search/tv")[0];
    assert.ok(hit, "expected a /search/tv call");
    assert.ok(hit.includes("first_air_date_year=2022"), hit);
    assert.equal(sev.posterUrl, `${IMG}/w500/sev.jpg`);
  });

  // A series' premiere year is not the year of the season someone is looking
  // at, so a 2024 query must still find a show that started in 2022.
  scenario(REAL_SHAPED_KEY);
  installFetch((url) =>
    url.includes("themoviedb.org")
      ? {
          results: [
            tmdbTv("House of the Dragon", "2022-08-21", "/hotd.jpg", "/hotd-bd.jpg", 90),
          ],
        }
      : undefined,
  );
  const hotd = await resolveArtwork({
    title: "House of the Dragon",
    year: 2024,
    mediaType: "tv",
  });
  check("a later season's year still matches the series", () => {
    assert.equal(hotd.posterUrl, `${IMG}/w500/hotd.jpg`);
  });
}

/** The refusals. Each of these used to be, or would be, a wrong poster. */
async function refusals() {
  console.log("metadata/artwork refusals");

  scenario(REAL_SHAPED_KEY);
  installFetch((url) => {
    if (url.includes("themoviedb.org")) {
      return {
        results: [
          tmdbMovie("Dune: Part Two", "2024-02-27", "/dunept2.jpg", null, 28),
          tmdbMovie("The Dune", "2025-03-23", "/thedune.jpg", null, 0.1),
        ],
      };
    }
    if (url.includes("itunes.apple.com")) {
      return {
        results: [
          {
            trackName: "Dune: Part Two",
            kind: "feature-movie",
            releaseDate: "2024-03-01T08:00:00Z",
            artworkUrl100:
              "https://is1-ssl.mzstatic.com/image/thumb/c/d/100x100bb.jpg",
          },
        ],
      };
    }
    return undefined;
  });
  const missing = await resolveArtwork({
    title: "Dune",
    year: 2021,
    mediaType: "movie",
  });
  check("no plausible match anywhere yields nulls, not the first result", () => {
    assert.deepEqual(missing, { posterUrl: null, backdropUrl: null });
  });
  check("both providers were asked before giving up", () => {
    assert.equal(urlsMatching("themoviedb.org").length > 0, true);
    assert.equal(urlsMatching("itunes.apple.com").length > 0, true);
  });

  // The 2021 film against a catalog holding only the 1984 one.
  scenario(REAL_SHAPED_KEY);
  installFetch((url) =>
    url.includes("themoviedb.org")
      ? { results: [tmdbMovie("Dune", "1984-12-14", "/dune1984.jpg", null, 12)] }
      : undefined,
  );
  const wrongYear = await resolveArtwork({
    title: "Dune",
    year: 2021,
    mediaType: "movie",
  });
  check("an exact title with the wrong film's year is refused", () => {
    assert.equal(wrongYear.posterUrl, null);
  });

  // A series cannot have episodes before it premiered.
  scenario(REAL_SHAPED_KEY);
  installFetch((url) =>
    url.includes("themoviedb.org")
      ? { results: [tmdbTv("Severance", "2025-01-01", "/nope.jpg", null, 5)] }
      : undefined,
  );
  const future = await resolveArtwork({
    title: "Severance",
    year: 2022,
    mediaType: "tv",
  });
  check("a show that premiered years later is refused", () => {
    assert.equal(future.posterUrl, null);
  });

  // The class of bug that put one film's poster on another's card.
  scenario(REAL_SHAPED_KEY);
  installFetch((url) =>
    url.includes("themoviedb.org")
      ? { results: [tmdbTv("Attack on Titan", "2013-04-07", "/aot.jpg", null, 80)] }
      : undefined,
  );
  const unrelated = await resolveArtwork({
    title: "Frieren",
    year: null,
    mediaType: "tv",
  });
  check("an unrelated show never lends its poster", () => {
    assert.equal(unrelated.posterUrl, null);
  });
}

/**
 * The product has to look finished with no keys at all: TMDB rate-limits under
 * a browse-heavy UI, keys get revoked, and a fresh clone has none.
 */
async function keylessFallbacks() {
  console.log("metadata/artwork keyless fallbacks");

  // 1. No key configured — and `xx` counts as no key.
  for (const key of [null, "xx"]) {
    scenario(key);
    installFetch((url) => (url.includes("itunes.apple.com") ? ITUNES_DUNE : undefined));
    const art = await resolveArtwork({
      title: "Dune",
      year: 2021,
      mediaType: "movie",
    });
    const label = key === null ? "no key" : "a placeholder key";
    check(`${label}: TMDB is not even called`, () => {
      assert.equal(urlsMatching("themoviedb.org").length, 0);
    });
    check(`${label}: iTunes answers instead`, () => {
      assert.equal(
        art.posterUrl,
        "https://is1-ssl.mzstatic.com/image/thumb/a/b/600x900bb.jpg",
      );
    });
    check(`${label}: the square 100x100 crop is never used`, () => {
      assert.ok(!art.posterUrl?.includes("100x100"), String(art.posterUrl));
    });
  }

  // The proxy on this machine returns resultCount: 0 for `media=movie` and
  // `entity=movie`, so the query must go out bare and filter client-side.
  check("the iTunes query carries no media/entity filter", () => {
    const hit = urlsMatching("itunes.apple.com")[0];
    assert.ok(hit, "expected an iTunes call");
    assert.ok(!/[?&](media|entity)=/.test(hit), hit);
  });

  // 2. Key present but TMDB is down. The chain must continue, not stop.
  scenario(REAL_SHAPED_KEY);
  installFetch((url) => {
    if (url.includes("themoviedb.org")) {
      return new Response("rate limited", { status: 429 });
    }
    if (url.includes("api.tvmaze.com")) return TVMAZE_SEVERANCE;
    return undefined;
  });
  const sev = await resolveArtwork({
    title: "Severance",
    year: 2022,
    mediaType: "tv",
  });
  check("a rate-limited TMDB falls through to TVmaze", () => {
    assert.equal(
      sev.posterUrl,
      "https://static.tvmaze.com/uploads/images/original_untouched/548/1371406.jpg",
    );
  });
  check("TVmaze's own fuzzy runner-up is not accepted", () => {
    assert.ok(!sev.posterUrl?.includes("1509559"), String(sev.posterUrl));
  });

  // 3. A thrown fetch is the same as a failed one.
  scenario(REAL_SHAPED_KEY);
  installFetch((url) => {
    if (url.includes("themoviedb.org")) throw new Error("ENOTFOUND");
    if (url.includes("api.tvmaze.com")) return TVMAZE_SEVERANCE;
    return undefined;
  });
  const thrown = await resolveArtwork({
    title: "Severance",
    year: 2022,
    mediaType: "tv",
  });
  check("a network error in TMDB falls through instead of propagating", () => {
    assert.ok(thrown.posterUrl?.includes("1371406"), String(thrown.posterUrl));
  });
}

async function animePath() {
  console.log("metadata/artwork anime");

  scenario(REAL_SHAPED_KEY);
  installFetch((url) => {
    if (url.includes("anilist.co")) return ANILIST_FRIEREN;
    if (url.includes("themoviedb.org")) {
      return {
        results: [
          tmdbTv(
            "Frieren: Beyond Journey's End",
            "2023-09-29",
            "/frieren-tmdb.jpg",
            "/frieren-bd.jpg",
            50,
          ),
        ],
      };
    }
    return undefined;
  });
  const frieren = await resolveArtwork({
    title: "Frieren",
    year: null,
    mediaType: "anime",
  });
  check("anime asks AniList first and keeps its cover", () => {
    assert.equal(calls[0]?.url.includes("anilist.co"), true, calls[0]?.url);
    assert.equal(frieren.posterUrl, "https://anilist.example/frieren-xl.jpg");
  });
  check("a missing AniList banner is topped up from TMDB", () => {
    assert.equal(frieren.backdropUrl, `${IMG}/w1280/frieren-bd.jpg`);
  });

  // When AniList has a banner there is nothing to top up, so TMDB must not be
  // called at all — the top-up is a repair, not a second lookup on every card.
  scenario(REAL_SHAPED_KEY);
  installFetch((url) =>
    url.includes("anilist.co")
      ? anilist([
          {
            id: 1,
            title: { english: "Cowboy Bebop", romaji: "Cowboy Bebop" },
            coverImage: { extraLarge: "https://anilist.example/bebop.jpg" },
            bannerImage: "https://anilist.example/bebop-banner.jpg",
            seasonYear: 1998,
          },
        ])
      : undefined,
  );
  const bebop = await resolveArtwork({
    title: "Cowboy Bebop",
    year: 1998,
    mediaType: "anime",
  });
  check("a complete AniList answer costs exactly one request", () => {
    assert.equal(bebop.posterUrl, "https://anilist.example/bebop.jpg");
    assert.equal(bebop.backdropUrl, "https://anilist.example/bebop-banner.jpg");
    assert.equal(urlsMatching("themoviedb.org").length, 0);
    assert.equal(calls.length, 1);
  });
}

async function cachingBehaviour() {
  console.log("metadata/artwork caching");

  scenario(REAL_SHAPED_KEY);
  installFetch((url) => (url.includes("themoviedb.org") ? TMDB_DUNE : undefined));

  const q = { title: "Dune", year: 2021, mediaType: "movie" as const };
  const first = await resolveArtwork(q);
  const afterFirst = calls.length;
  const second = await resolveArtwork(q);
  check("a repeated lookup costs no requests", () => {
    assert.ok(afterFirst > 0, "expected the first lookup to hit the network");
    assert.equal(calls.length, afterFirst);
    assert.deepEqual(second, first);
  });

  // Different spellings of the same request share a cache entry, which is what
  // stops a rail of episodes firing one lookup per card.
  const beforeEpisodes = calls.length;
  await resolveArtwork({ title: "Dune 2021", year: null, mediaType: "movie" });
  await resolveArtwork({ title: "Dune (2021)", year: null, mediaType: "movie" });
  check("noisy variants of one title reuse the cached answer", () => {
    assert.equal(calls.length, beforeEpisodes);
  });

  // A title with no art must not be re-queried on every render.
  scenario(REAL_SHAPED_KEY);
  installFetch((url) => (url.includes("themoviedb.org") ? { results: [] } : undefined));
  const missQuery = {
    title: "Nonexistent Work Nobody Has",
    year: 2001,
    mediaType: "tv" as const,
  };
  await resolveArtwork(missQuery);
  const afterMiss = calls.length;
  await resolveArtwork(missQuery);
  check("a miss is remembered, not retried", () => {
    assert.ok(afterMiss > 0);
    assert.equal(calls.length, afterMiss);
  });

  // Three episode cards render at once; one lookup must serve all three.
  scenario(REAL_SHAPED_KEY);
  let inFlightPeak = 0;
  let active = 0;
  installFetch(async (url) => {
    active += 1;
    inFlightPeak = Math.max(inFlightPeak, active);
    await new Promise((r) => setTimeout(r, 25));
    active -= 1;
    return url.includes("themoviedb.org")
      ? { results: [tmdbTv("Severance", "2022-02-17", "/sev.jpg", "/bd.jpg", 40)] }
      : undefined;
  });
  const together = await Promise.all([
    resolveArtwork({ title: "Severance S02E01", year: null, mediaType: "tv" }),
    resolveArtwork({ title: "Severance S02E02", year: null, mediaType: "tv" }),
    resolveArtwork({ title: "Severance S02E03", year: null, mediaType: "tv" }),
  ]);
  check("concurrent lookups of one show share a single request", () => {
    assert.equal(calls.length, 1, `${calls.length} requests for one show`);
    assert.equal(inFlightPeak, 1);
    for (const art of together) {
      assert.equal(art.posterUrl, `${IMG}/w500/sev.jpg`);
    }
  });
}

async function batchBehaviour() {
  console.log("metadata/artwork batch");

  scenario(REAL_SHAPED_KEY);
  let active = 0;
  let peak = 0;
  installFetch(async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    const term = new URL(url).searchParams.get("query") ?? "";
    return { results: [tmdbTv(term, "2001-01-01", `/${term}.jpg`, null, 1)] };
  });

  const titles = Array.from({ length: 20 }, (_, i) => `Show Number ${i}`);
  const batch = await resolveArtworkBatch(
    titles.map((title) => ({ title, year: null, mediaType: "tv" as const })),
  );

  check("results line up with their queries, index for index", () => {
    assert.equal(batch.length, titles.length);
    batch.forEach((art, i) => {
      assert.equal(art.posterUrl, `${IMG}/w500/${titles[i]}.jpg`);
    });
  });
  check("concurrency is bounded at 6", () => {
    assert.ok(peak <= 6, `peak concurrency was ${peak}`);
    assert.ok(peak > 1, `expected real parallelism, peak was ${peak}`);
  });

  scenario(REAL_SHAPED_KEY);
  installFetch(() => {
    throw new Error("network is gone");
  });
  const dead = await resolveArtworkBatch([
    { title: "Dune", year: 2021, mediaType: "movie" },
    { title: "", year: null, mediaType: null },
    { title: "Severance", year: 2022, mediaType: "tv" },
  ]);
  check("a dead network degrades to nulls, in order, without throwing", () => {
    assert.deepEqual(dead, [
      { posterUrl: null, backdropUrl: null },
      { posterUrl: null, backdropUrl: null },
      { posterUrl: null, backdropUrl: null },
    ]);
  });

  const empty = await resolveArtworkBatch([]);
  check("an empty batch is an empty array", () => {
    assert.deepEqual(empty, []);
  });
}

async function resilience() {
  console.log("metadata/artwork resilience");

  scenario(REAL_SHAPED_KEY);
  process.env.ARTWORK_TIMEOUT_MS = "120";
  installFetch(() => new Promise<never>(() => {}));

  const started = Date.now();
  const hung = await resolveArtwork({
    title: "Dune",
    year: 2021,
    mediaType: "movie",
  });
  const took = Date.now() - started;
  check("a provider that never answers cannot hang a page", () => {
    assert.deepEqual(hung, { posterUrl: null, backdropUrl: null });
    assert.ok(took < 2000, `took ${took}ms`);
  });
  delete process.env.ARTWORK_TIMEOUT_MS;

  scenario(REAL_SHAPED_KEY);
  installFetch(() => new Response("<html>nope</html>", { status: 200 }));
  const garbage = await resolveArtwork({
    title: "Dune",
    year: 2021,
    mediaType: "movie",
  });
  check("a non-JSON body is not an exception", () => {
    assert.deepEqual(garbage, { posterUrl: null, backdropUrl: null });
  });

  scenario(REAL_SHAPED_KEY);
  installFetch(() => ({ results: [{ id: 1, media_type: "movie" }] }));
  const shapeless = await resolveArtwork({
    title: "Dune",
    year: 2021,
    mediaType: "movie",
  });
  check("a result with no title and no art is skipped", () => {
    assert.deepEqual(shapeless, { posterUrl: null, backdropUrl: null });
  });
}

main().then(
  () => undefined,
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
