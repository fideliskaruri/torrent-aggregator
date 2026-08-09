import assert from "node:assert/strict";
import { searchAniList, searchAniListWorks } from "@/lib/metadata/anilist";
import { isSeriesMediaType } from "@/lib/metadata/media-type";
import { searchTmdb, searchTmdbByType } from "@/lib/metadata/tmdb";
import {
  searchDiscoveryVariants,
  searchTitleVariants,
} from "@/lib/search/query-variants";
import { queryRelevanceTier } from "@/components/search/group-titles";
import {
  interleaveByProviderRank,
  rankTitleHitsByRelevance,
} from "@/components/search/title-search";
import type { MediaMetadata } from "@/lib/torrents/types";
import {
  legacyEverythingRedirectUrl,
  parseWorkSearchCategory,
  workSearchHitFromMetadata,
  type WorkSearchCategory,
} from "./work-search";

function metadata(
  source: "tmdb" | "anilist",
  mediaType: "movie" | "tv" | "anime",
  title: string,
  year: number,
): MediaMetadata {
  return {
    source,
    mediaType,
    externalId: `${source}-${title}`,
    title,
    aliases:
      source === "anilist"
        ? [`${title} Romaji`, `${title} Native`]
        : undefined,
    year,
    posterUrl: `https://img.test/${encodeURIComponent(title)}.jpg`,
    synopsis: `${title} synopsis`,
    releaseDate: `${year}-01-02`,
    genres: [],
  };
}

const cases: Array<{
  category: WorkSearchCategory;
  item: MediaMetadata;
  format?: string;
  provider: "tmdb" | "anilist";
  mediaType: "movie" | "tv" | "anime";
  titleMediaType: "movie" | "tv" | "anime";
  isSeries: boolean;
  key: string;
}> = [
  {
    category: "movies",
    item: metadata("tmdb", "movie", "Dune", 2021),
    provider: "tmdb",
    mediaType: "movie",
    titleMediaType: "movie",
    isSeries: false,
    key: "dune-2021",
  },
  {
    category: "series",
    item: metadata("tmdb", "tv", "Severance", 2022),
    provider: "tmdb",
    mediaType: "tv",
    titleMediaType: "tv",
    isSeries: true,
    key: "severance",
  },
  {
    category: "anime",
    item: metadata("anilist", "anime", "Spirited Away", 2001),
    format: "MOVIE",
    provider: "anilist",
    mediaType: "anime",
    titleMediaType: "movie",
    isSeries: false,
    key: "spirited-away-2001",
  },
  ...(["TV", "ONA", "OVA"] as const).map((format) => ({
    category: "anime" as const,
    item: metadata("anilist", "anime", `Slime ${format}`, 2018),
    format,
    provider: "anilist" as const,
    mediaType: "anime" as const,
    titleMediaType: "anime" as const,
    isSeries: true,
    key: `slime-${format.toLowerCase()}`,
  })),
];

for (const row of cases) {
  const hit = workSearchHitFromMetadata(row.item, row.category, row.format);
  assert.ok(hit);
  assert.equal(hit.category, row.category);
  assert.equal(hit.provider, row.provider);
  assert.equal(hit.mediaType, row.mediaType);
  assert.equal(hit.titleMediaType, row.titleMediaType);
  assert.equal(hit.isSeries, row.isSeries);
  assert.equal(hit.format, row.format ?? null);
  assert.equal(hit.providerId, row.item.externalId);
  assert.deepEqual(hit.aliases, row.item.aliases ?? []);
  assert.equal(hit.workKey, row.key);
  const href = new URL(hit.href, "http://search.test");
  assert.equal(href.pathname, `/title/${row.key}`);
  assert.equal(href.searchParams.get("type"), row.titleMediaType);
  assert.equal(href.searchParams.get("t"), row.item.title);
  assert.equal(href.searchParams.get("provider"), row.provider);
  assert.equal(href.searchParams.get("providerId"), row.item.externalId);
  assert.equal(href.searchParams.get("sourceType"), row.mediaType);
  assert.equal(href.searchParams.get("format"), row.format ?? null);
  assert.equal(href.searchParams.get("series"), row.isSeries ? "1" : "0");
  assert.deepEqual(href.searchParams.getAll("alias"), row.item.aliases ?? []);
  assert.equal(
    isSeriesMediaType(href.searchParams.get("type")),
    row.isSeries,
    `${row.format ?? row.category} must route to the matching title UI/action shape`,
  );
}
console.log(`PASS work hit category/provider/format matrix (${cases.length} cases)`);

assert.equal(parseWorkSearchCategory(" SERIES "), "series");
assert.equal(parseWorkSearchCategory("music"), "movies");
assert.equal(parseWorkSearchCategory(null), "movies");
console.log("PASS product category parsing and invalid fallback");

assert.equal(
  legacyEverythingRedirectUrl("anime", "x"),
  "/search?category=anime&q=x",
);
assert.equal(
  legacyEverythingRedirectUrl("music", "Daft Punk"),
  "/search?q=Daft+Punk",
);
assert.equal(legacyEverythingRedirectUrl("games", ""), "/search");
console.log("PASS legacy Everything redirects preserve supported category and query");

assert.deepEqual(searchTitleVariants("moonkn"), ["moonkn"]);
assert.deepEqual(searchTitleVariants("moonknight"), ["moonknight"]);
assert.deepEqual(searchDiscoveryVariants("moonkn"), ["moonkn", "moon"]);
assert.deepEqual(searchDiscoveryVariants("moonknight"), ["moonknight", "moon"]);
assert.deepEqual(searchDiscoveryVariants("moon knight"), [
  "moon knight",
  "moonknight",
]);
console.log("PASS conservative grab variants and compact discovery variants");

assert.equal(queryRelevanceTier("moonknigt", "Moon Knight"), 5);
assert.equal(queryRelevanceTier("moonknight", "Moon Knight"), 1);
assert.equal(queryRelevanceTier("moonkn", "Moon Knight"), 1);
assert.ok(
  queryRelevanceTier("moonkn", "Moon Knight") <
    queryRelevanceTier("moonkn", "Moon"),
);
assert.equal(queryRelevanceTier("abcdx", "qwert"), 6);
assert.equal(queryRelevanceTier("abc", "abd"), 6);
assert.equal(queryRelevanceTier("Aman", "Aman"), 0);
assert.equal(queryRelevanceTier("Aman", "A Man"), 1);
assert.equal(queryRelevanceTier("Beyonce", "Beyoncé"), 0);
assert.equal(queryRelevanceTier("Cafe", "Café"), 0);
assert.equal(queryRelevanceTier("moonknigt", "Moon"), 6);
assert.equal(queryRelevanceTier("moonknigt", ""), 6);
assert.equal(queryRelevanceTier("abcdx", "abcdy"), 5);
console.log("PASS bounded fuzzy title relevance, diacritics, and no-match guards");

const providerLists = [
  [
    { title: "First Moon", category: "movies" },
    { title: "Second Moon", category: "movies" },
  ],
  [{ title: "Moon Knight", category: "series" }],
];
const merged = interleaveByProviderRank(providerLists, "moon");
assert.deepEqual(
  merged.slice(0, 2).map((hit) => hit.category).sort(),
  ["movies", "series"],
);
console.log("PASS category-fair provider-rank interleave");

const starvedMovies = Array.from({ length: 12 }, (_, index) => ({
  title: `${index === 0 ? "First" : "Another"} Moon`,
  category: "movies",
}));
const typoRanked = rankTitleHitsByRelevance(
  [...starvedMovies, { title: "Moon Knight", category: "series" }],
  "moonknigt",
);
assert.equal(
  typoRanked.slice(0, 12)[0]?.title,
  "Moon Knight",
  "fuzzy title must survive the API limit ahead of rescue noise",
);
console.log("PASS typo search avoids limit starvation by generic rescue titles");
assert.ok(
  searchDiscoveryVariants("Re:ZERO -Starting Life in Another World-").length <=
    3,
);
console.log("PASS compact-aware title relevance");

async function providerTests() {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TMDB_API_KEY;
  try {
  process.env.TMDB_API_KEY = "1234567890abcdef1234567890abcdef";
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    const query = new URL(String(input)).searchParams.get("query");
    const results = query === "moon" ? [
      {
        id: 2,
        media_type: "movie",
        title: "Moon Knight",
        release_date: "2022-01-01",
      },
    ] : [];
    return new Response(
      JSON.stringify({ results }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const multiFallback = await searchTmdb("moonkn", 5);
  assert.deepEqual(
    requested.map((url) => new URL(url).searchParams.get("query")),
    ["moonkn", "moon"],
  );
  assert.equal(multiFallback[0]?.title, "Moon Knight");

  requested.length = 0;
  const typeFallback = await searchTmdbByType("movie", "moonknight", 5);
  assert.deepEqual(
    requested.map((url) => new URL(url).searchParams.get("query")),
    ["moonknight", "moon"],
  );
  assert.equal(typeFallback[0]?.title, "Moon Knight");

  requested.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(
      JSON.stringify({
        results: [
          {
            id: 2,
            media_type: "movie",
            title: "Moon Knight",
            release_date: "2022-01-01",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const directHit = await searchTmdb("moonknight", 5);
  assert.deepEqual(
    requested.map((url) => new URL(url).searchParams.get("query")),
    ["moonknight"],
  );
  assert.equal(directHit[0]?.title, "Moon Knight");
  console.log("PASS TMDB multi/type raw-first compact fallback");

  let tmdbAttempt = 0;
  globalThis.fetch = (async () => {
    tmdbAttempt += 1;
    if (tmdbAttempt > 1) {
      throw new DOMException("deadline exhausted", "TimeoutError");
    }
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  assert.deepEqual(await searchTmdbByType("movie", "moonknight", 5), []);
  assert.equal(tmdbAttempt, 2);
  console.log("PASS TMDB rescue deadline preserves an empty result");

  requested.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(
      JSON.stringify({
        results: [
          {
            id: 2,
            media_type: "movie",
            title: "Moon Knight",
            release_date: "2022-01-01",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const movies = await searchTmdbByType("movie", "Slime", 5);
  const series = await searchTmdbByType("tv", "Slime", 5);
  assert.equal(new URL(requested[0]).pathname, "/3/search/movie");
  assert.equal(new URL(requested[1]).pathname, "/3/search/tv");
  assert.equal(movies[0]?.mediaType, "movie");
  assert.equal(series[0]?.mediaType, "tv");
  console.log("PASS TMDB Movies and Series use separate provider endpoints");

  const anilistRequested: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      variables: { search: string };
    };
    anilistRequested.push(body.variables.search);
    const media = body.variables.search === "moon"
      ? [{
          id: 1,
          title: { english: "Moon Knight" },
          seasonYear: 2022,
          format: "TV",
        }]
      : [];
    return new Response(JSON.stringify({
      data: { Page: { media } },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const animeFallback = await searchAniList("moonkn", 4);
  assert.deepEqual(anilistRequested, ["moonkn", "moon"]);
  assert.equal(animeFallback[0]?.title, "Moon Knight");

  anilistRequested.length = 0;
  const animeWorkFallback = await searchAniListWorks("moonknight", 4);
  assert.deepEqual(anilistRequested, ["moonknight", "moon"]);
  assert.equal(animeWorkFallback[0]?.metadata.title, "Moon Knight");

  let anilistAttempt = 0;
  globalThis.fetch = (async () => {
    anilistAttempt += 1;
    if (anilistAttempt > 1) {
      throw new DOMException("deadline exhausted", "AbortError");
    }
    return new Response(JSON.stringify({ data: { Page: { media: [] } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  assert.deepEqual(await searchAniListWorks("moonknight", 4), []);
  assert.equal(anilistAttempt, 2);
  console.log("PASS AniList rescue deadline preserves an empty result");

  anilistRequested.length = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      variables: { search: string };
    };
    anilistRequested.push(body.variables.search);
    return new Response(JSON.stringify({
      data: {
        Page: {
          media: ["MOVIE", "TV", "ONA", "OVA"].map((format, index) => ({
            id: index + 1,
            title: { english: `Anime ${format}` },
            seasonYear: 2020 + index,
            format,
          })),
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const anime = await searchAniListWorks("Slime", 4);
  assert.deepEqual(anilistRequested, ["slime"]);
  assert.deepEqual(
    anime.map(({ format, isSeries }) => ({ format, isSeries })),
    [
      { format: "MOVIE", isSeries: false },
      { format: "TV", isSeries: true },
      { format: "ONA", isSeries: true },
      { format: "OVA", isSeries: true },
    ],
  );
  console.log("PASS AniList preserves MOVIE/TV/ONA/OVA and isSeries");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = originalKey;
  }
}

providerTests().catch((error) => {
  console.error("FAIL work search provider tests", error);
  process.exit(1);
});
