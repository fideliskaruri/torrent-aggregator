/**
 * Keyless textual detail.
 *
 * The bug these guard: with no `TMDB_API_KEY` — a fresh clone, a revoked key,
 * a rate limit — every title page rendered a letter tile, a title and nothing
 * else. Overview coverage was 0% across all 120 catalog rows while AniList,
 * TVmaze and iTunes were sitting there needing no key at all.
 *
 * The bug they must not *introduce* is worse: prose reads as authoritative, so
 * a synopsis from the wrong work is a lie the user has no way to spot. Hence
 * the wrong-title cases below, and the AniList alias case that was found live —
 * matching only AniList's collapsed English title made the query "Tensei
 * Shitara Slime Datta Ken" score 0 against the series it names and 100 against
 * a YouTube-shorts spin-off, which is exactly what the page then showed.
 *
 * Nothing here touches the network; `globalThis.fetch` is stubbed throughout.
 */
import assert from "node:assert/strict";

import { anilistScoreTo10 } from "./anilist";
import { resetArtworkCache } from "./artwork";
import {
  resolveKeylessDetail,
  stripHtmlToText,
} from "./keyless-detail";
import { resetWorkDetailCache, resolveWorkDetail } from "./work-detail";

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

// --- fixtures -------------------------------------------------------------

/** The real work, as AniList returns it: English display title, romaji alias. */
const SLIME = {
  id: 101280,
  title: {
    romaji: "Tensei Shitara Slime Datta Ken",
    english: "That Time I Got Reincarnated as a Slime",
    native: "\u8ee2\u751f\u3057\u305f\u3089\u30b9\u30e9\u30a4\u30e0\u3060\u3063\u305f\u4ef6",
  },
  coverImage: { large: "https://img.anili.st/cover.jpg", extraLarge: null },
  bannerImage: "https://img.anili.st/banner.jpg",
  description:
    "Lonely thirty-seven-year-old <i>Satoru Mikami</i> is stuck in a dead-end job.<br>He awakens as a slime &amp; starts again.",
  averageScore: 78,
  seasonYear: 2018,
  startDate: { year: 2018, month: 10, day: 2 },
  genres: ["Action", "Adventure", "Comedy", "Fantasy"],
  format: "TV",
  episodes: 24,
};

/** The spin-off that won before aliases were matched. Same romaji name. */
const SLIME_SHORTS = {
  id: 139274,
  title: {
    romaji: "Tensei Shitara Slime Datta Ken: Kanwa",
    english: null,
    native: null,
  },
  coverImage: { large: "https://img.anili.st/short.jpg", extraLarge: null },
  bannerImage: null,
  description:
    "Shorts animations released for a limited time on a YouTube channel.",
  averageScore: 69,
  seasonYear: 2022,
  startDate: { year: 2022, month: 3, day: 19 },
  genres: ["Comedy", "Fantasy"],
  format: "ONA",
  episodes: 5,
};

const SEVERANCE_TVMAZE = [
  {
    score: 0.9,
    show: {
      id: 53647,
      name: "Severance",
      premiered: "2022-02-18",
      image: { medium: null, original: "https://static.tvmaze.com/sev.jpg" },
      summary:
        "<p><b>Severance</b> follows Mark Scout, who leads a team at Lumon Industries.</p>",
      genres: ["Drama", "Thriller"],
      rating: { average: 8.4 },
      runtime: 55,
    },
  },
];

/** iTunes only knows the sequel. A synopsis for it on a "Dune" page is a lie. */
const DUNE_PART_TWO_ITUNES = {
  resultCount: 1,
  results: [
    {
      trackId: 1,
      trackName: "Dune: Part Two",
      kind: "feature-movie",
      releaseDate: "2024-02-27T08:00:00Z",
      longDescription: "Paul Atreides unites with the Fremen.",
      primaryGenreName: "Sci-Fi & Fantasy",
      trackTimeMillis: 9960000,
      artworkUrl100: "https://is1-ssl.mzstatic.com/a/100x100bb.jpg",
    },
  ],
};

// --- fetch stubbing -------------------------------------------------------

const originalFetch = globalThis.fetch;
let calls: string[] = [];

interface Routes {
  anilist?: unknown[];
  tvmaze?: unknown;
  itunes?: unknown;
}

function installFetch(routes: Routes) {
  calls = [];
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input instanceof URL ? input.toString() : input);
    calls.push(url);
    const body = url.includes("anilist.co")
      ? { data: { Page: { media: routes.anilist ?? [] } } }
      : url.includes("tvmaze.com")
        ? (routes.tvmaze ?? [])
        : (routes.itunes ?? { resultCount: 0, results: [] });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function reset(routes: Routes) {
  resetArtworkCache();
  resetWorkDetailCache();
  installFetch(routes);
}

async function main() {
  const originalKey = process.env.TMDB_API_KEY;
  // The install this was written for: no key at all, everywhere below.
  delete process.env.TMDB_API_KEY;

  try {
    console.log("html -> text");
    check("tags are removed and <br> becomes a line break", () => {
      const text = stripHtmlToText(
        "<p>First <i>line</i>.<br>Second line.</p>",
      );
      assert.equal(text, "First line.\nSecond line.");
    });

    check("entities are decoded, not printed", () => {
      assert.equal(
        stripHtmlToText("Tom &amp; Jerry &#8212; &quot;quoted&quot;"),
        'Tom & Jerry \u2014 "quoted"',
      );
    });

    check("an encoded tag stays text and is never re-parsed as markup", () => {
      assert.equal(stripHtmlToText("&lt;p&gt;hi&lt;/p&gt;"), "<p>hi</p>");
    });

    check("markup with no words is absent, not an empty paragraph", () => {
      assert.equal(stripHtmlToText("<p> </p>"), null);
      assert.equal(stripHtmlToText(null), null);
      assert.equal(stripHtmlToText(undefined), null);
    });

    console.log("anilist score, 0-100 -> 0-10");
    check("78 becomes 7.8, not 7.800000000000001", () => {
      assert.equal(anilistScoreTo10(78), 7.8);
      assert.equal(anilistScoreTo10(100), 10);
      assert.equal(anilistScoreTo10(5), 0.5);
    });

    check("no score stays no score, and 0 is unrated rather than rated 0", () => {
      assert.equal(anilistScoreTo10(null), null);
      assert.equal(anilistScoreTo10(undefined), null);
      assert.equal(anilistScoreTo10(0), null);
    });

    check("a value outside AniList's own scale is refused", () => {
      assert.equal(anilistScoreTo10(120), null);
      assert.equal(anilistScoreTo10(Number.NaN), null);
    });

    console.log("matching: the wrong work is worse than no work");
    reset({ itunes: DUNE_PART_TWO_ITUNES });
    const wrongFilm = await resolveKeylessDetail({
      title: "Dune",
      year: null,
      mediaType: "movie",
    });
    check('"Dune" never takes the "Dune: Part Two" synopsis', () => {
      assert.equal(
        wrongFilm,
        null,
        `expected no detail, got ${JSON.stringify(wrongFilm?.title)}`,
      );
    });

    reset({ anilist: [SLIME_SHORTS] });
    const wrongAnime = await resolveKeylessDetail({
      title: "Frieren",
      year: null,
      mediaType: "anime",
    });
    check("an unrelated anime result is refused outright", () => {
      assert.equal(wrongAnime, null);
    });

    console.log("anilist aliases");
    // The romaji query names the series; the shorts entry is offered first to
    // prove the alias match wins on merit, not on ordering luck.
    reset({ anilist: [SLIME, SLIME_SHORTS] });
    const slime = await resolveKeylessDetail({
      title: "Tensei Shitara Slime Datta Ken",
      year: null,
      mediaType: "anime",
    });
    check("a romaji query matches the work whose English title differs", () => {
      assert.ok(slime, "expected AniList detail for the romaji title");
      assert.equal(slime?.source, "anilist");
      assert.equal(slime?.title, "That Time I Got Reincarnated as a Slime");
    });

    check("the shorts spin-off's blurb never reaches the page", () => {
      assert.ok(
        !(slime?.overview ?? "").includes("Shorts animations"),
        `got the spin-off synopsis: ${slime?.overview}`,
      );
    });

    check("AniList HTML is delivered as text and its score as 0-10", () => {
      assert.ok(!(slime?.overview ?? "").includes("<i>"));
      assert.ok((slime?.overview ?? "").includes("slime & starts again"));
      assert.equal(slime?.rating, 7.8);
    });

    check("genres, date and episode count come through unfabricated", () => {
      assert.deepEqual(slime?.genres, [
        "Action",
        "Adventure",
        "Comedy",
        "Fantasy",
      ]);
      assert.equal(slime?.releaseDate, "2018-10-02");
      assert.equal(slime?.episodeCount, 24);
      assert.equal(slime?.runtimeMinutes, null, "AniList states no runtime");
    });

    console.log("tvmaze");
    reset({ tvmaze: SEVERANCE_TVMAZE });
    const series = await resolveKeylessDetail({
      title: "Severance",
      year: null,
      mediaType: "tv",
    });
    check("a TVmaze summary is stripped of its markup", () => {
      assert.ok(series, "expected TVmaze detail");
      assert.equal(
        series?.overview,
        "Severance follows Mark Scout, who leads a team at Lumon Industries.",
      );
    });

    check("TVmaze's rating is already 0-10 and is not rescaled", () => {
      assert.equal(series?.rating, 8.4);
      assert.equal(series?.runtimeMinutes, 55);
      assert.deepEqual(series?.genres, ["Drama", "Thriller"]);
      assert.equal(series?.releaseDate, "2022-02-18");
    });

    console.log("no key: fallback data rather than nothing");
    reset({ anilist: [SLIME] });
    const keyless = await resolveWorkDetail({
      title: "Tensei Shitara Slime Datta Ken",
      year: null,
      mediaType: "anime",
    });
    check("resolveWorkDetail answers with no TMDB_API_KEY set", () => {
      assert.ok(
        keyless,
        "a keyless install must get detail, not null (the whole bug)",
      );
      assert.equal(keyless?.source, "anilist");
      assert.equal(keyless?.tmdbId, null);
      assert.ok(keyless?.overview, "overview is the field the page shows");
      assert.equal(keyless?.rating, 7.8);
      assert.equal(keyless?.mediaType, "tv");
    });

    check("no TMDB request is attempted without a usable key", () => {
      assert.ok(
        !calls.some((url) => url.includes("api.themoviedb.org")),
        `unexpected TMDB call: ${calls.join(", ")}`,
      );
    });

    const repeat = await resolveWorkDetail({
      title: "Tensei Shitara Slime Datta Ken",
      year: null,
      mediaType: "anime",
    });
    const afterFirst = calls.length;
    check("a second lookup is served from memory", () => {
      assert.equal(repeat?.overview, keyless?.overview);
      assert.equal(
        calls.length,
        afterFirst,
        "a cached keyless answer must not re-query the provider",
      );
    });

    console.log("degradation");
    reset({});
    const nothing = await resolveWorkDetail({
      title: "A Title No Provider Knows",
      year: null,
      mediaType: null,
    });
    check("an unknown work resolves to null, never to invented prose", () => {
      assert.equal(nothing, null);
    });

    resetArtworkCache();
    resetWorkDetailCache();
    (globalThis as { fetch: unknown }).fetch = async () => {
      throw new Error("network down");
    };
    const dead = await resolveWorkDetail({
      title: "Severance",
      year: null,
      mediaType: "tv",
    });
    check("a dead network degrades to null instead of throwing", () => {
      assert.equal(dead, null);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = originalKey;
  }

  if (failures > 0) {
    console.error(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}

main().then(
  () => undefined,
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
