import assert from "node:assert/strict";
import type { TitleExtrasPayload } from "@/components/title/types";
import type { TvmazeCandidate, TvmazeEpisode } from "@/lib/metadata/tvmaze";
import type { TitleProviderIdentityResult } from "../provider-identity";
import { tvmazeExtrasResponse } from "./tvmaze-response";

const empty: TitleExtrasPayload = {
  workKey: "rick-and-morty",
  season: 2,
  seasonCount: null,
  seasons: [],
  episodes: [],
  moreLikeThis: [],
  overview: null,
  rating: null,
  releaseDate: null,
  inTheatricalWindow: false,
  nextHomeReleaseAt: null,
  genres: [],
  voteCount: null,
  certification: null,
  originalLanguage: null,
  resolved: false,
  generatedAt: "2026-08-07T00:00:00.000Z",
};

function carried(
  title: string,
  year: number | null,
  aliases: string[] = [],
): TitleProviderIdentityResult {
  return {
    kind: "carried",
    reason: "TMDB identity lookup failed",
    identity: {
      provider: "tmdb",
      externalId: "60625",
      mediaType: "tv",
      format: null,
      isSeries: true,
      episodeCount: null,
      verified: false,
      metadata: {
        source: "tmdb",
        externalId: "60625",
        mediaType: "tv",
        title,
        year,
        aliases,
      },
    },
  };
}

function show(
  id: number,
  title: string,
  year: number | null,
  score = 1,
  posterUrl: string | null = null,
): TvmazeCandidate {
  return {
    id,
    title,
    year,
    posterUrl,
    backdropUrl: null,
    score,
    summary: null,
    genres: [],
    rating: null,
    premiered: null,
    runtimeMin: null,
  };
}

const rickEpisodes: TvmazeEpisode[] = [
  {
    season: 1,
    episode: 1,
    name: "Pilot",
    airDate: "2013-12-02",
    runtimeMin: 30,
    stillUrl: null,
  },
  {
    season: 2,
    episode: 1,
    name: "A Rickle in Time",
    airDate: "2015-07-26",
    runtimeMin: 30,
    stillUrl: "https://static.tvmaze.com/rickle.jpg",
  },
  {
    season: 2,
    episode: 2,
    name: "Mortynight Run",
    airDate: "2015-08-02",
    runtimeMin: 30,
    stillUrl: null,
  },
];

async function main() {
  const rick = await tvmazeExtrasResponse(
    carried("Rick and Morty", 2013),
    empty,
    {
      workKey: "rick-and-morty",
      title: "Rick and Morty",
      year: 2013,
      isSeries: true,
    },
    {
      search: async () => [
        show(216, "Rick and Morty", 2013, 0.99),
        show(76825, "Rick and Morty: The Anime", 2024, 0.8),
      ],
      episodes: async () => rickEpisodes,
    },
  );
  assert.ok(rick);
  assert.equal(rick.resolved, true);
  assert.deepEqual(rick.seasons, [1, 2]);
  assert.equal(rick.seasonCount, 2);
  assert.deepEqual(
    rick.episodes.map((episode) => [episode.episode, episode.name]),
    [[1, "A Rickle in Time"], [2, "Mortynight Run"]],
  );

  const slime = await tvmazeExtrasResponse(
    carried(
      "Tensei shitara Slime Datta Ken",
      2018,
      ["That Time I Got Reincarnated as a Slime"],
    ),
    { ...empty, workKey: "that-time-i-got-reincarnated-as-a-slime", season: 1 },
    {
      workKey: "that-time-i-got-reincarnated-as-a-slime",
      title: "That Time I Got Reincarnated as a Slime",
      year: 2018,
      isSeries: true,
    },
    {
      search: async () => [
        show(38390, "That Time I Got Reincarnated as a Slime", 2018),
        show(47367, "The Slime Diaries", 2021, 0.7),
      ],
      episodes: async () => [{
        season: 1,
        episode: 1,
        name: "The Storm Dragon, Veldora",
        airDate: "2018-10-01",
        runtimeMin: 30,
        stillUrl: null,
      }],
    },
  );
  assert.equal(slime?.episodes[0]?.name, "The Storm Dragon, Veldora");

  let episodeCalls = 0;
  const request = {
    workKey: "rick-and-morty",
    title: "Rick and Morty",
    year: 2013,
    isSeries: true,
  };
  const wrongYear = await tvmazeExtrasResponse(
    carried("Rick and Morty", 2014),
    empty,
    request,
    {
      search: async () => [show(216, "Rick and Morty", 2013)],
      episodes: async () => {
        episodeCalls += 1;
        return rickEpisodes;
      },
    },
  );
  assert.equal(wrongYear, null);
  assert.equal(episodeCalls, 0);

  const siblingOnly = await tvmazeExtrasResponse(
    carried("Rick and Morty", 2013),
    empty,
    request,
    {
      search: async () => [show(76825, "Rick and Morty: The Anime", 2024)],
      episodes: async () => rickEpisodes,
    },
  );
  assert.equal(siblingOnly, null);

  const ambiguous = await tvmazeExtrasResponse(
    carried("The Office", null),
    empty,
    {
      workKey: "the-office",
      title: "The Office",
      year: null,
      isSeries: true,
    },
    {
      search: async () => [
        show(526, "The Office", 2005),
        show(299, "The Office", 2001),
      ],
      episodes: async () => rickEpisodes,
    },
  );
  assert.equal(ambiguous, null);

  const sexAndTheCityPoster =
    "https://static.tvmaze.com/uploads/images/original_untouched/594/1486658.jpg";
  const sexAndTheCity = await tvmazeExtrasResponse(
    { kind: "absent" },
    { ...empty, workKey: "sex-and-the-city", season: 1 },
    {
      workKey: "sex-and-the-city",
      title: "Sex and the City",
      year: null,
      posterUrl: sexAndTheCityPoster,
      isSeries: true,
    },
    {
      search: async () => [
        show(676, "Sex and the City", 1998, 1, sexAndTheCityPoster),
        show(
          20329,
          "Sex and the City",
          2012,
          0.8,
          "https://static.tvmaze.com/other.jpg",
        ),
      ],
      episodes: async (id) =>
        id === 676
          ? [{
              season: 1,
              episode: 1,
              name: "Sex and the City",
              airDate: "1998-06-06",
              runtimeMin: 30,
              stillUrl: null,
            }]
          : [],
    },
  );
  assert.equal(sexAndTheCity?.resolved, true);
  assert.equal(sexAndTheCity?.episodes[0]?.name, "Sex and the City");

  const ambiguousPoster = await tvmazeExtrasResponse(
    { kind: "absent" },
    empty,
    {
      workKey: "the-office",
      title: "The Office",
      year: null,
      posterUrl: "https://static.tvmaze.com/not-a-match.jpg",
      isSeries: true,
    },
    {
      search: async () => [
        show(526, "The Office", 2005, 1, "https://static.tvmaze.com/us.jpg"),
        show(299, "The Office", 2001, 0.9, "https://static.tvmaze.com/uk.jpg"),
      ],
      episodes: async () => rickEpisodes,
    },
  );
  assert.equal(ambiguousPoster, null);

  const sameYearPoster = await tvmazeExtrasResponse(
    { kind: "absent" },
    empty,
    {
      workKey: "shared-title",
      title: "Shared Title",
      year: 2020,
      posterUrl: "https://static.tvmaze.com/right.jpg",
      isSeries: true,
    },
    {
      search: async () => [
        show(100, "Shared Title", 2020, 1, "https://static.tvmaze.com/wrong.jpg"),
        show(101, "Shared Title", 2020, 0.9, "https://static.tvmaze.com/right.jpg"),
      ],
      episodes: async (id) => id === 101 ? rickEpisodes : [],
    },
  );
  assert.equal(sameYearPoster?.resolved, true);

  const outage = await tvmazeExtrasResponse(
    carried("Rick and Morty", 2013),
    empty,
    request,
    {
      search: async () => [show(216, "Rick and Morty", 2013)],
      episodes: async () => [],
    },
  );
  assert.equal(outage, null);

  const house = await tvmazeExtrasResponse(
    { kind: "absent" },
    { ...empty, workKey: "house-of-the-dragon", season: 1 },
    {
      workKey: "house-of-the-dragon",
      title: "House of the Dragon",
      year: null,
      isSeries: true,
    },
    {
      search: async () => [
        show(44778, "House of the Dragon", 2022, 1.6),
        show(
          63965,
          "House of the Dragon: The House That Dragons Built",
          2022,
          1.1,
        ),
      ],
      episodes: async () => [{
        season: 1,
        episode: 1,
        name: "The Heirs of the Dragon",
        airDate: "2022-08-21",
        runtimeMin: 66,
        stillUrl: null,
      }],
    },
  );
  assert.equal(house?.episodes[0]?.name, "The Heirs of the Dragon");

  const mismatchedWorkKey = await tvmazeExtrasResponse(
    { kind: "absent" },
    empty,
    {
      workKey: "house-of-the-dragon-the-house-that-dragons-built",
      title: "House of the Dragon",
      year: null,
      isSeries: true,
    },
    {
      search: async () => [show(44778, "House of the Dragon", 2022)],
      episodes: async () => rickEpisodes,
    },
  );
  assert.equal(mismatchedWorkKey, null);

  console.log("tvmaze extras response: all passed");
}

main().then(
  () => undefined,
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
