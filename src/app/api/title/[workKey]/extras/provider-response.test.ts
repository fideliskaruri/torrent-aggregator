import assert from "node:assert/strict";
import type { TitleExtrasPayload } from "@/components/title/types";
import type { TitleProviderIdentityResult } from "../provider-identity";
import { providerExtrasResponse } from "./provider-response";

const empty: TitleExtrasPayload = {
  workKey: "anime-tv",
  season: 1,
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
  generatedAt: "2026-08-02T00:00:00.000Z",
};

function verified(
  isSeries: boolean,
  episodeCount: number | null = null,
): TitleProviderIdentityResult {
  return {
    kind: "verified",
    identity: {
      provider: "anilist",
      externalId: "123",
      mediaType: "anime",
      format: isSeries ? "TV" : "MOVIE",
      isSeries,
      episodeCount,
      verified: true,
      metadata: {
        source: "anilist",
        externalId: "123",
        mediaType: "anime",
        title: "Anime TV",
        synopsis: "Verified synopsis",
      },
    },
  };
}

assert.equal(providerExtrasResponse({ kind: "absent" }, empty), null);
const series = providerExtrasResponse(verified(true), empty);
assert.equal(series?.overview, "Verified synopsis");
assert.equal(series?.resolved, false);
assert.deepEqual(series?.episodes, []);
assert.equal(series?.seasonCount, null);
assert.deepEqual(series?.seasons, []);
// Hero facts stay honestly empty on the verified-AniList path — no TMDB
// genres/vote count/certification/language may leak in via a title search.
assert.deepEqual(series?.genres, [], "verified AniList carries no genres");
assert.equal(series?.voteCount, null);
assert.equal(series?.certification, null);
assert.equal(series?.originalLanguage, null);
assert.equal(providerExtrasResponse(verified(false), empty)?.resolved, true);

// --- AniList 112608 "Killing Slimes": 12 episodes, one honest season -------
const slimes = providerExtrasResponse(verified(true, 12), empty);
assert.equal(slimes?.season, 1);
assert.equal(slimes?.seasonCount, 1, "one AniList media id is one season");
assert.deepEqual(slimes?.seasons, [1]);
assert.equal(slimes?.episodes.length, 12, "the full season 1 list is offered");
assert.deepEqual(
  slimes?.episodes.map((ep) => ep.episode),
  Array.from({ length: 12 }, (_, i) => i + 1),
);
assert.equal(slimes?.resolved, true, "a real episode list means resolved");
// Episode-level facts AniList does not supply are never fabricated.
assert.equal(slimes?.episodes[0].name, null);
assert.equal(slimes?.episodes[0].airDate, null);
assert.equal(slimes?.episodes[0].stillUrl, null);
// And no TMDB-shaped hero facts sneak in alongside the episodes.
assert.deepEqual(slimes?.genres, []);
assert.equal(slimes?.voteCount, null);

// --- Solo Leveling control: an ordinary 12-episode AniList series ---------
const soloLeveling = providerExtrasResponse(verified(true, 12), {
  ...empty,
  workKey: "solo-leveling",
  season: null,
});
assert.equal(soloLeveling?.season, 1, "a season-less request opens on season 1");
assert.equal(soloLeveling?.episodes.length, 12);
assert.equal(soloLeveling?.resolved, true);

// A season this AniList work does not have is answered as itself with no
// episodes — never silently re-pointed at season 1's list.
const seasonTwo = providerExtrasResponse(verified(true, 12), {
  ...empty,
  season: 2,
});
assert.equal(seasonTwo?.season, 2);
assert.deepEqual(seasonTwo?.episodes, []);
assert.equal(seasonTwo?.resolved, false);

// A film never grows an episode list.
const film = providerExtrasResponse(verified(false, 1), empty);
assert.equal(film?.season, null);
assert.deepEqual(film?.episodes, []);
assert.equal(film?.seasonCount, null);

const invalid = providerExtrasResponse(
  { kind: "invalid", reason: "identity mismatch" },
  empty,
);
assert.deepEqual(invalid, empty);

// A client-carried (unverified) identity never produces an episode list.
const carried = providerExtrasResponse(
  {
    kind: "carried",
    reason: "AniList identity lookup failed",
    identity: {
      provider: "anilist",
      externalId: "123",
      mediaType: "anime",
      format: "TV",
      isSeries: true,
      episodeCount: null,
      verified: false,
      metadata: {
        source: "anilist",
        externalId: "123",
        mediaType: "anime",
        title: "Anime TV",
      },
    },
  },
  empty,
);
assert.deepEqual(carried, empty);

console.log("PASS AniList extras stays honest and identity-safe");
