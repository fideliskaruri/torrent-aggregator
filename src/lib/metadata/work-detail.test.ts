/**
 * Work detail: the IMDb-grade fields behind a title page.
 *
 * Two failure modes drive these tests.
 *
 * The first is *dishonesty*. A detail page is mostly text, and text invents
 * itself easily: a missing runtime becomes "0 min", an unaired season becomes
 * an empty episode list, a certification from the wrong country becomes an
 * age rating the user does not recognise. Both traps below were found in real
 * TMDB responses — *Severance* genuinely returns `episode_run_time: []` and
 * genuinely lists a Season 3 with `episode_count: 0`.
 *
 * The second is *cost*. This runs behind a page, so a lookup that repeats a
 * request, ignores its cache, or waits on a hung provider is a defect even
 * when the fields it returns are perfect.
 *
 * Nothing here touches the network; `globalThis.fetch` is stubbed throughout.
 */
import assert from "node:assert/strict";

import { resetArtworkCache } from "./artwork";
import {
  detailForRef,
  resetWorkDetailCache,
  resolveSeasonEpisodes,
  resolveWorkDetail,
  resolveWorkDetailBatch,
  seasonForRef,
} from "./work-detail";

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

// --- fetch stubbing -------------------------------------------------------

type Handler = (url: string) => unknown | Promise<unknown>;

let calls: string[] = [];
let originalFetch: typeof globalThis.fetch;

function installFetch(handler: Handler) {
  calls = [];
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input instanceof URL ? input.toString() : input);
    calls.push(url);
    const out = await handler(url);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function urlsMatching(fragment: string): string[] {
  return calls.filter((c) => c.includes(fragment));
}

function scenario(key: string | null) {
  resetArtworkCache();
  resetWorkDetailCache();
  if (key === null) delete process.env.TMDB_API_KEY;
  else process.env.TMDB_API_KEY = key;
}

// --- fixtures (shapes copied verbatim from live responses) ----------------

/** `/search/movie?query=dune+part+two&year=2024`, real ordering. */
const SEARCH_DUNE = {
  results: [
    {
      id: 693134,
      media_type: "movie",
      title: "Dune: Part Two",
      release_date: "2024-02-27",
      poster_path: "/dunept2.jpg",
      backdrop_path: "/dunept2-bd.jpg",
      popularity: 28.85,
    },
  ],
};

/** `/movie/693134?append_to_response=credits,release_dates`, trimmed. */
const DETAIL_DUNE = {
  id: 693134,
  title: "Dune: Part Two",
  overview: "Paul Atreides unites with Chani and the Fremen.",
  tagline: "Long live the fighters.",
  runtime: 167,
  release_date: "2024-02-27",
  vote_average: 8.1,
  vote_count: 8233,
  status: "Released",
  poster_path: "/dunept2.jpg",
  backdrop_path: "/dunept2-bd.jpg",
  genres: [
    { id: 878, name: "Science Fiction" },
    { id: 12, name: "Adventure" },
  ],
  credits: {
    cast: [
      {
        name: "Timothée Chalamet",
        character: "Paul Atreides",
        profile_path: "/tc.jpg",
        order: 0,
      },
      { name: "Zendaya", character: "Chani", profile_path: "/z.jpg", order: 1 },
    ],
    crew: [
      { name: "Denis Villeneuve", job: "Director" },
      { name: "Greig Fraser", job: "Director of Photography" },
    ],
  },
  release_dates: {
    results: [
      // Brazil first, and US carries an empty certification before a real one:
      // both are real shapes, and both break a naive "first entry" reader.
      { iso_3166_1: "BR", release_dates: [{ certification: "14", type: 3 }] },
      {
        iso_3166_1: "US",
        release_dates: [
          { certification: "", type: 1 },
          { certification: "PG-13", type: 3 },
        ],
      },
    ],
  },
};

const SEARCH_SEVERANCE = {
  results: [
    {
      id: 95396,
      media_type: "tv",
      name: "Severance",
      first_air_date: "2022-02-17",
      poster_path: "/sev.jpg",
      backdrop_path: "/sev-bd.jpg",
      popularity: 40,
    },
  ],
};

/** `/tv/95396?append_to_response=credits,content_ratings`, trimmed. */
const DETAIL_SEVERANCE = {
  id: 95396,
  name: "Severance",
  overview: "Mark leads a team whose memories have been surgically divided.",
  tagline: "There's more to work than life.",
  first_air_date: "2022-02-17",
  // Verified live: this really is empty for Severance.
  episode_run_time: [],
  number_of_episodes: 19,
  vote_average: 8.389,
  vote_count: 2788,
  status: "Returning Series",
  poster_path: "/sev.jpg",
  backdrop_path: "/sev-bd.jpg",
  genres: [{ id: 18, name: "Drama" }],
  created_by: [{ name: "Dan Erickson" }],
  seasons: [
    { season_number: 1, name: "Season 1", episode_count: 9, air_date: "2022-02-17", poster_path: "/s1.jpg" },
    { season_number: 2, name: "Season 2", episode_count: 10, air_date: "2025-01-16", poster_path: "/s2.jpg" },
    // Announced, unaired, zero episodes. Verified live.
    { season_number: 3, name: "Season 3", episode_count: 0, air_date: null, poster_path: null },
  ],
  credits: {
    cast: [
      { name: "Adam Scott", character: "Mark Scout", profile_path: "/as.jpg" },
      { name: "Britt Lower", character: "Helly Riggs", profile_path: "/bl.jpg" },
    ],
    crew: [{ name: "Ben Stiller", job: "Director" }],
  },
  content_ratings: {
    results: [
      { iso_3166_1: "BR", rating: "16" },
      { iso_3166_1: "US", rating: "TV-MA" },
    ],
  },
};

const SEASON_ONE = {
  season_number: 1,
  episodes: [
    {
      episode_number: 2,
      season_number: 1,
      name: "Half Loop",
      overview: "The team train new hire Helly.",
      still_path: "/e2.jpg",
      runtime: 53,
      air_date: "2022-02-17",
      vote_average: 8.261,
    },
    {
      episode_number: 1,
      season_number: 1,
      name: "Good News About Hell",
      overview: "Mark is promoted to lead a team.",
      still_path: "/e1.jpg",
      runtime: 57,
      air_date: "2022-02-17",
      vote_average: 8.171,
    },
  ],
};

/** A real shape that is easy to get wrong: present-but-blank text fields. */
const DETAIL_BLANK_TEXT = {
  id: 111,
  title: "Quiet Release",
  overview: "   ",
  tagline: "",
  release_date: "2019-05-01",
  runtime: 0,
  vote_average: 0,
  vote_count: 0,
  poster_path: null,
  backdrop_path: null,
  genres: [],
  credits: { cast: [], crew: [] },
  release_dates: { results: [] },
};

/** Route a stubbed URL to the right fixture. */
function tmdbRouter(url: string): unknown {
  if (url.includes("/search/movie")) return SEARCH_DUNE;
  if (url.includes("/search/tv")) return SEARCH_SEVERANCE;
  if (url.includes("/search/multi")) return { results: [] };
  if (url.includes("/tv/95396/season/1")) return SEASON_ONE;
  if (url.includes("/movie/693134")) return DETAIL_DUNE;
  if (url.includes("/movie/111")) return DETAIL_BLANK_TEXT;
  if (url.includes("/tv/95396")) return DETAIL_SEVERANCE;
  return {};
}

const DUNE_Q = { title: "Dune Part Two", year: 2024, mediaType: "movie" as const };
const SEV_Q = { title: "Severance", year: 2022, mediaType: "tv" as const };

async function main() {
  originalFetch = globalThis.fetch;

  // -- film ---------------------------------------------------------------

  scenario(REAL_SHAPED_KEY);
  installFetch(tmdbRouter);
  const film = await resolveWorkDetail(DUNE_Q);

  check("a film comes back with the fields a title page renders", () => {
    assert.ok(film, "expected detail for Dune: Part Two");
    assert.equal(film.tmdbId, 693134);
    assert.equal(film.mediaType, "movie");
    assert.equal(film.title, "Dune: Part Two");
    assert.equal(film.year, 2024);
    assert.equal(film.tagline, "Long live the fighters.");
    assert.equal(film.runtimeMinutes, 167);
    assert.equal(film.rating, 8.1);
    assert.equal(film.voteCount, 8233);
    assert.equal(film.status, "Released");
    assert.deepEqual(film.genres, ["Science Fiction", "Adventure"]);
    assert.ok(film.overview && film.overview.length > 20, "overview must be present");
  });

  check("a film's director is credited, and only the director", () => {
    assert.deepEqual(film?.directors, ["Denis Villeneuve"]);
    assert.deepEqual(film?.creators, []);
  });

  check("cast carries character names and headshot URLs", () => {
    assert.equal(film?.cast.length, 2);
    assert.equal(film?.cast[0].name, "Timothée Chalamet");
    assert.equal(film?.cast[0].character, "Paul Atreides");
    assert.equal(
      film?.cast[0].profileUrl,
      "https://image.tmdb.org/t/p/w185/tc.jpg",
    );
  });

  check("headshots come from the already-allowlisted TMDB image host", () => {
    for (const member of film?.cast ?? []) {
      assert.ok(
        member.profileUrl?.startsWith("https://image.tmdb.org/t/p/"),
        `unexpected image host: ${member.profileUrl}`,
      );
    }
  });

  check(
    "certification is region-resolved, not the first entry and not the empty one",
    () => {
      // BR ("14") sorts first in the payload and US's first entry is "".
      assert.equal(film?.certification, "PG-13");
    },
  );

  check("a film exposes no seasons", () => {
    assert.deepEqual(film?.seasons, []);
  });

  check("detail is one request on top of the search, not a waterfall", () => {
    assert.equal(
      urlsMatching("/movie/693134").length,
      1,
      `expected exactly one detail request, got ${urlsMatching("/movie/693134").length}`,
    );
    assert.ok(
      urlsMatching("append_to_response=credits").length >= 1,
      "credits must be folded into the detail request",
    );
  });

  // -- series -------------------------------------------------------------

  scenario(REAL_SHAPED_KEY);
  installFetch(tmdbRouter);
  const series = await resolveWorkDetail(SEV_Q);

  check("a series comes back with its own shape", () => {
    assert.ok(series, "expected detail for Severance");
    assert.equal(series.mediaType, "tv");
    assert.equal(series.title, "Severance");
    assert.equal(series.certification, "TV-MA");
    assert.equal(series.episodeCount, 19);
    assert.deepEqual(series.creators, ["Dan Erickson"]);
    assert.deepEqual(series.directors, []);
  });

  check("a missing episode runtime stays null and never becomes 0", () => {
    // Severance really does return `episode_run_time: []`. Rendering 0 here
    // would print "0 min" under the title.
    assert.equal(
      series?.runtimeMinutes,
      null,
      `expected null runtime, got ${String(series?.runtimeMinutes)}`,
    );
  });

  check("an announced season with no episodes is not offered", () => {
    const numbers = series?.seasons.map((s) => s.seasonNumber);
    assert.deepEqual(numbers, [1, 2], "Season 3 has 0 episodes and must be omitted");
  });

  check("seasons carry the counts and dates a selector needs", () => {
    assert.equal(series?.seasons[0].name, "Season 1");
    assert.equal(series?.seasons[0].episodeCount, 9);
    assert.equal(series?.seasons[0].airDate, "2022-02-17");
    assert.equal(
      series?.seasons[0].posterUrl,
      "https://image.tmdb.org/t/p/w500/s1.jpg",
    );
  });

  // -- episodes -----------------------------------------------------------

  const episodes = await resolveSeasonEpisodes(SEV_Q, 1);

  check("episodes come back in episode order, not payload order", () => {
    assert.deepEqual(
      episodes.map((e) => e.episodeNumber),
      [1, 2],
      "the fixture lists episode 2 first on purpose",
    );
  });

  check("an episode carries title, synopsis, still, runtime and air date", () => {
    const first = episodes[0];
    assert.equal(first.title, "Good News About Hell");
    assert.equal(first.overview, "Mark is promoted to lead a team.");
    assert.equal(first.stillUrl, "https://image.tmdb.org/t/p/w300/e1.jpg");
    assert.equal(first.runtimeMinutes, 57);
    assert.equal(first.airDate, "2022-02-17");
    assert.equal(first.rating, 8.171);
  });

  // -- cost ---------------------------------------------------------------

  scenario(REAL_SHAPED_KEY);
  installFetch(tmdbRouter);
  await resolveWorkDetail(DUNE_Q);
  const afterFirst = calls.length;
  await resolveWorkDetail(DUNE_Q);
  const afterSecond = calls.length;

  check("a second lookup of the same work costs no requests at all", () => {
    assert.ok(afterFirst > 0, "the first lookup must actually call TMDB");
    assert.equal(
      afterSecond,
      afterFirst,
      `second lookup fired ${afterSecond - afterFirst} extra request(s)`,
    );
  });

  scenario(REAL_SHAPED_KEY);
  installFetch(tmdbRouter);
  const concurrent = await Promise.all([
    resolveWorkDetail(DUNE_Q),
    resolveWorkDetail(DUNE_Q),
    resolveWorkDetail(DUNE_Q),
  ]);

  check("three simultaneous asks for one work share one detail request", () => {
    assert.equal(
      urlsMatching("/movie/693134").length,
      1,
      `expected 1 detail request, got ${urlsMatching("/movie/693134").length}`,
    );
    assert.equal(concurrent[0]?.tmdbId, 693134);
    assert.equal(concurrent[2]?.tmdbId, 693134);
  });

  scenario(REAL_SHAPED_KEY);
  installFetch(tmdbRouter);
  await seasonForRef(95396, 1);
  const seasonCalls = urlsMatching("/season/1").length;
  await seasonForRef(95396, 1);

  check("a season is fetched once and then remembered", () => {
    assert.equal(seasonCalls, 1);
    assert.equal(
      urlsMatching("/season/1").length,
      1,
      "the second season read must not hit the network",
    );
  });

  // -- refusals and failure ------------------------------------------------

  scenario(null);
  installFetch(tmdbRouter);
  const keyless = await resolveWorkDetail(DUNE_Q);

  check("with no key, detail is null and TMDB is never called", () => {
    assert.equal(keyless, null);
    assert.equal(
      calls.length,
      0,
      `expected no requests without a key, got ${calls.length}`,
    );
  });

  scenario("xx");
  installFetch(tmdbRouter);
  const placeholder = await resolveWorkDetail(DUNE_Q);

  check("a placeholder key is still treated as absent", () => {
    assert.equal(placeholder, null);
    assert.equal(calls.length, 0, "a 2-character key must not reach TMDB");
  });

  scenario(REAL_SHAPED_KEY);
  installFetch(() => new Response("nope", { status: 500 }));
  const failed = await resolveWorkDetail(DUNE_Q);

  check("a provider outage is null, never a throw", () => {
    assert.equal(failed, null);
  });

  scenario(REAL_SHAPED_KEY);
  installFetch(() => {
    throw new Error("socket hang up");
  });
  const dead = await resolveWorkDetail(SEV_Q);
  const deadEpisodes = await resolveSeasonEpisodes(SEV_Q, 1);

  check("a dead network degrades to null and an empty episode list", () => {
    assert.equal(dead, null);
    assert.deepEqual(deadEpisodes, []);
  });

  scenario(REAL_SHAPED_KEY);
  installFetch((url) =>
    url.includes("/search/") ? { results: [] } : tmdbRouter(url),
  );
  const unmatched = await resolveWorkDetail({
    title: "A Film That Does Not Exist",
    year: 2019,
    mediaType: "movie",
  });

  check("a title TMDB cannot match returns null, not somebody else's film", () => {
    assert.equal(unmatched, null);
  });

  scenario(REAL_SHAPED_KEY);
  installFetch(tmdbRouter);
  const wrongYear = await resolveWorkDetail({
    title: "Dune Part Two",
    year: 1998,
    mediaType: "movie",
  });

  check("the year guard applies to detail exactly as it does to artwork", () => {
    assert.equal(
      wrongYear,
      null,
      "a 2024 film must not answer a 1998 query just because the title matches",
    );
  });

  // -- batch ---------------------------------------------------------------

  scenario(REAL_SHAPED_KEY);
  installFetch(tmdbRouter);
  const batch = await resolveWorkDetailBatch([
    DUNE_Q,
    { title: "A Film That Does Not Exist", year: 2019, mediaType: "movie" },
    SEV_Q,
  ]);

  check("a batch is order-preserving, with null in the gaps", () => {
    assert.equal(batch.length, 3);
    assert.equal(batch[0]?.tmdbId, 693134);
    assert.equal(batch[1], null, "the unmatched title must occupy slot 1");
    assert.equal(batch[2]?.tmdbId, 95396);
  });

  const emptyBatch = await resolveWorkDetailBatch([]);

  check("an empty batch is an empty array, not a crash", () => {
    assert.deepEqual(emptyBatch, []);
    assert.equal(calls.length > 0, true, "the earlier batch should have called out");
  });

  scenario(REAL_SHAPED_KEY);
  installFetch(tmdbRouter);
  const malformed = await resolveWorkDetailBatch(
    null as unknown as { title: string; mediaType: null }[],
  );

  check("a malformed batch argument is an empty array", () => {
    assert.deepEqual(malformed, []);
  });

  // -- ref reuse -----------------------------------------------------------

  scenario(REAL_SHAPED_KEY);
  installFetch(tmdbRouter);
  const byRef = await detailForRef({ id: 693134, mediaType: "movie" });

  check("a known id skips the search entirely", () => {
    assert.equal(byRef?.tmdbId, 693134);
    assert.equal(
      urlsMatching("/search/").length,
      0,
      "detailForRef must not search",
    );
  });

  check("detailForRef asks the endpoint matching the media type", () => {
    assert.equal(
      urlsMatching("/movie/693134").length,
      1,
      "a film must be fetched from /movie, not /tv",
    );
  });

  // `resolveWorkDetail` has its own try/catch, so a throw inside `detailForRef`
  // is invisible through it. `detailForRef` is exported and callers use it
  // directly, so it has to be non-throwing on its own account.
  scenario(REAL_SHAPED_KEY);
  installFetch(() => new Response("nope", { status: 503 }));
  let refThrew = false;
  let refResult: unknown = "unset";
  try {
    refResult = await detailForRef({ id: 693134, mediaType: "movie" });
  } catch {
    refThrew = true;
  }

  check("detailForRef swallows an outage on its own, not via its caller", () => {
    assert.equal(refThrew, false, "detailForRef must not throw");
    assert.equal(refResult, null);
  });

  // -- blank-but-present fields --------------------------------------------

  scenario(REAL_SHAPED_KEY);
  installFetch(tmdbRouter);
  const blank = await detailForRef({ id: 111, mediaType: "movie" });

  check("text that is present but blank is reported as absent", () => {
    assert.ok(blank, "expected a record for the blank-text fixture");
    assert.equal(
      blank.overview,
      null,
      `a whitespace overview must be null, got ${JSON.stringify(blank.overview)}`,
    );
    assert.equal(blank.tagline, null);
  });

  check("a zero runtime and an unrated score are absent, not zero", () => {
    assert.equal(blank?.runtimeMinutes, null, "runtime 0 must not render as 0 min");
    assert.equal(blank?.rating, null, "vote_average 0 means unrated, not rated 0");
    assert.equal(blank?.voteCount, 0);
  });

  globalThis.fetch = originalFetch;

  if (failures > 0) {
    console.error(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}

void main();
