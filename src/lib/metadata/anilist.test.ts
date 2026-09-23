/**
 * AniList work-level facts the title page depends on.
 *
 * The regression this guards: an AniList series reached through search showed
 * an empty episode list, because nothing read the episode count AniList had
 * been returning all along. AniList 112608 ("I've Been Killing Slimes for 300
 * Years...") is the exact shape that failed — a finished 12-episode TV work
 * with an English, Romaji and native title.
 */
import assert from "node:assert/strict";

import {
  anilistEpisodeCount,
  fetchAniListRecommendationsForPoster,
  getAniListWorkById,
  searchAniListWorks,
} from "./anilist";

const KILLING_SLIMES = {
  id: 112608,
  title: {
    romaji:
      "Slime Taoshite 300-nen, Shiranai Uchi ni Level Max ni Nattemashita",
    english:
      "I've Been Killing Slimes for 300 Years and Maxed Out My Level",
    native: "スライム倒して300年、知らないうちにレベルMAXになってました",
  },
  coverImage: { large: "https://img.test/large.jpg", extraLarge: null },
  bannerImage: null,
  description: "A witch levels up by killing slimes.",
  averageScore: 71,
  seasonYear: 2021,
  startDate: { year: 2021, month: 4, day: 10 },
  genres: ["Comedy", "Fantasy"],
  format: "TV" as const,
  episodes: 12,
  nextAiringEpisode: null,
};

const originalFetch = globalThis.fetch;

function stubFetch(payload: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

async function main() {
  // --- the failing shape, end to end -------------------------------------
  stubFetch({ data: { Media: KILLING_SLIMES } });
  const work = await getAniListWorkById("112608");
  assert.ok(work, "AniList 112608 resolves");
  assert.equal(work.metadata.externalId, "112608");
  assert.equal(work.metadata.source, "anilist");
  assert.equal(work.metadata.mediaType, "anime");
  assert.equal(work.isSeries, true);
  assert.equal(work.format, "TV");
  assert.equal(
    work.episodeCount,
    12,
    "the honest 12-episode count reaches the title page",
  );
  assert.deepEqual(
    work.metadata.aliases,
    [
      KILLING_SLIMES.title.english,
      KILLING_SLIMES.title.romaji,
      KILLING_SLIMES.title.native,
    ],
    "English, Romaji and native names all survive as aliases",
  );
  assert.equal(work.metadata.year, 2021);

  // Search discovery reports the same count, so a work entered through search
  // is not a second-class citizen with a blank episode list.
  stubFetch({ data: { Page: { media: [KILLING_SLIMES] } } });
  const found = await searchAniListWorks("killing slimes", 5);
  assert.equal(found.length, 1);
  assert.equal(found[0].episodeCount, 12);
  assert.equal(found[0].metadata.externalId, "112608");

  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts < 2) {
      return new Response("temporarily unavailable", { status: 503 });
    }
    return new Response(
      JSON.stringify({ data: { Page: { media: [KILLING_SLIMES] } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  const recovered = await searchAniListWorks("killing slimes", 5);
  assert.equal(recovered[0]?.metadata.externalId, "112608");
  assert.equal(attempts, 2, "transient 5xx responses are retried once");

  // --- nothing is ever invented ------------------------------------------
  assert.equal(
    anilistEpisodeCount({ episodes: null, nextAiringEpisode: null }),
    null,
    "no count from AniList means no count here",
  );
  assert.equal(
    anilistEpisodeCount({ episodes: null, nextAiringEpisode: { episode: 8 } }),
    7,
    "an airing show reports only what has already aired",
  );
  assert.equal(
    anilistEpisodeCount({ episodes: null, nextAiringEpisode: { episode: 1 } }),
    null,
    "a show whose first episode has not aired has no episodes",
  );
  assert.equal(anilistEpisodeCount({ episodes: 0 }), null);
  assert.equal(anilistEpisodeCount({ episodes: -3 }), null);
  assert.equal(anilistEpisodeCount({ episodes: 1.5 }), null);
  assert.equal(
    anilistEpisodeCount({ episodes: 999_999 }),
    null,
    "an implausible count is treated as no answer",
  );

  // A film carries a count too, but its shape stays MOVIE — the title page
  // decides what to do with that, not this module.
  stubFetch({
    data: {
      Media: { ...KILLING_SLIMES, id: 999, format: "MOVIE", episodes: 1 },
    },
  });
  const film = await getAniListWorkById("999");
  assert.equal(film?.isSeries, false);
  assert.equal(film?.episodeCount, 1);

  const recommendation = {
    ...KILLING_SLIMES,
    id: 101280,
    title: {
      english: "That Time I Got Reincarnated as a Slime",
      romaji: "Tensei Shitara Slime Datta Ken",
      native: "転生したらスライムだった件",
    },
    coverImage: {
      large: "https://img.test/recommendation.jpg",
      extraLarge: null,
    },
  };
  stubFetch({
    data: {
      Page: {
        media: [{
          id: KILLING_SLIMES.id,
          coverImage: KILLING_SLIMES.coverImage,
          recommendations: {
            nodes: [
              { mediaRecommendation: recommendation },
              { mediaRecommendation: recommendation },
              { mediaRecommendation: null },
            ],
          },
        }],
      },
    },
  });
  const recommendations = await fetchAniListRecommendationsForPoster(
    KILLING_SLIMES.title.english,
    KILLING_SLIMES.coverImage.large,
  );
  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0].metadata.externalId, "101280");
  assert.equal(
    recommendations[0].metadata.title,
    "That Time I Got Reincarnated as a Slime",
  );

  stubFetch({
    data: {
      Page: {
        media: [{
          id: KILLING_SLIMES.id,
          coverImage: KILLING_SLIMES.coverImage,
          recommendations: { nodes: [] },
        }],
      },
    },
  });
  assert.deepEqual(
    await fetchAniListRecommendationsForPoster(
      KILLING_SLIMES.title.english,
      "https://img.test/not-the-same-work.jpg",
    ),
    [],
    "recommendations require exact poster identity evidence",
  );
}

main()
  .then(() => console.log("PASS metadata/anilist episode facts"))
  .catch((error) => {
    console.error(error);
    console.log("FAIL metadata/anilist episode facts");
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
