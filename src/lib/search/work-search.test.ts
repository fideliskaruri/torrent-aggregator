import assert from "node:assert/strict";
import { searchAniListWorks } from "@/lib/metadata/anilist";
import { isSeriesMediaType } from "@/lib/metadata/media-type";
import { searchTmdbByType } from "@/lib/metadata/tmdb";
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

async function providerTests() {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TMDB_API_KEY;
  try {
  process.env.TMDB_API_KEY = "1234567890abcdef1234567890abcdef";
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(
      JSON.stringify({
        results: [
          {
            id: 1,
            title: "Movie result",
            name: "Series result",
            release_date: "2024-01-01",
            first_air_date: "2023-01-01",
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

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
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
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const anime = await searchAniListWorks("Slime", 4);
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
