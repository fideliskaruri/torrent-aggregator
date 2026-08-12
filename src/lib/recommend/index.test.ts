import assert from "node:assert/strict";
import test from "node:test";

import {
  libraryKey,
  recommendationsForProvider,
  resetRecommendationCache,
} from "./index";

const TMDB_KEY = "1234567890abcdef1234567890abcdef";

test("library keys normalize stored media aliases", () => {
  assert.equal(
    libraryKey({ mediaType: "series", externalId: "1396" }),
    "tv:1396",
  );
  assert.equal(
    libraryKey({ mediaType: "Movie", externalId: "438631" }),
    "movie:438631",
  );
});

test("AniList recommendations preserve provider identity and route shape", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        data: {
          Media: {
            recommendations: {
              nodes: [
                {
                  mediaRecommendation: {
                    id: 139498,
                    title: {
                      romaji: "Tensei Shitara Slime Datta Ken Movie",
                      english:
                        "That Time I Got Reincarnated as a Slime the Movie: Scarlet Bond",
                    },
                    coverImage: { large: "https://img.test/slime-movie.jpg" },
                    startDate: { year: 2022 },
                    averageScore: 75,
                    format: "MOVIE",
                  },
                },
                {
                  mediaRecommendation: {
                    id: 999,
                    title: { romaji: "Unknown Shape", english: null },
                    coverImage: { large: "https://img.test/unknown.jpg" },
                    startDate: { year: 2022 },
                    averageScore: 80,
                    format: null,
                  },
                },
                {
                  mediaRecommendation: {
                    id: 1000,
                    title: { romaji: "A Manga", english: null },
                    coverImage: { large: "https://img.test/manga.jpg" },
                    startDate: { year: 2022 },
                    averageScore: 80,
                    format: "MANGA",
                  },
                },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const rail = await recommendationsForProvider(
      {
        provider: "anilist",
        title: "That Time I Got Reincarnated as a Slime",
        mediaType: "anime",
        externalId: "101280",
      },
      new Set(),
      12,
    );
    assert.equal(rail?.items.length, 1);
    assert.match(requestedUrl, /\?operation=recommendations$/);
    assert.deepEqual(rail?.items[0], {
      provider: "anilist",
      sourceMediaType: "anime",
      mediaType: "anime",
      titleMediaType: "movie",
      externalId: "139498",
      title:
        "That Time I Got Reincarnated as a Slime the Movie: Scarlet Bond",
      posterUrl: "https://img.test/slime-movie.jpg",
      year: 2022,
      rating: 7.5,
      format: "MOVIE",
      isSeries: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TMDB recommendations use recommendations only and preserve the result id", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = `  "${TMDB_KEY}"  `;
  resetRecommendationCache();
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        results: [
          {
            id: 82684,
            name: "That Time I Got Reincarnated as a Slime",
            poster_path: "/slime.jpg",
            first_air_date: "2018-10-02",
            vote_average: 8.5,
            vote_count: 800,
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const rail = await recommendationsForProvider(
      {
        provider: "tmdb",
        title: "Seed",
        mediaType: "series",
        externalId: "123",
      },
      new Set(),
      12,
    );
    assert.match(requestedUrl, /\/tv\/123\/recommendations/);
    assert.doesNotMatch(requestedUrl, /\/similar/);
    assert.equal(new URL(requestedUrl).searchParams.get("api_key"), TMDB_KEY);
    assert.equal(rail?.items[0]?.externalId, "82684");
    assert.equal(rail?.items[0]?.provider, "tmdb");
    assert.equal(rail?.items[0]?.titleMediaType, "tv");
    assert.equal(rail?.items[0]?.rating, 8.5);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey == null) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = originalKey;
    resetRecommendationCache();
  }
});

test("TMDB HTTP failures are not cached", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TMDB_API_KEY;
  const originalError = console.error;
  process.env.TMDB_API_KEY = TMDB_KEY;
  resetRecommendationCache();
  let requests = 0;
  console.error = () => undefined;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) return new Response("unauthorized", { status: 401 });
    return new Response(
      JSON.stringify({
        results: [
          {
            id: 1396,
            name: "Breaking Bad",
            poster_path: "/breaking-bad.jpg",
            first_air_date: "2008-01-20",
            vote_average: 8.9,
            vote_count: 12000,
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const seed = {
      provider: "tmdb" as const,
      title: "Seed",
      mediaType: "tv",
      externalId: "456",
    };
    assert.equal(await recommendationsForProvider(seed, new Set(), 12), null);
    const recovered = await recommendationsForProvider(seed, new Set(), 12);
    assert.equal(requests, 2);
    assert.equal(recovered?.items[0]?.title, "Breaking Bad");

    await recommendationsForProvider(seed, new Set(), 12);
    assert.equal(requests, 2, "a successful response is cached");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    if (originalKey == null) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = originalKey;
    resetRecommendationCache();
  }
});
