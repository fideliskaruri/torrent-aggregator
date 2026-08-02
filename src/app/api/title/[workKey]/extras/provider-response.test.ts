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
  resolved: false,
  generatedAt: "2026-08-02T00:00:00.000Z",
};

function verified(isSeries: boolean): TitleProviderIdentityResult {
  return {
    kind: "verified",
    identity: {
      provider: "anilist",
      externalId: "123",
      mediaType: "anime",
      format: isSeries ? "TV" : "MOVIE",
      isSeries,
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
assert.equal(providerExtrasResponse(verified(false), empty)?.resolved, true);

const invalid = providerExtrasResponse(
  { kind: "invalid", reason: "identity mismatch" },
  empty,
);
assert.deepEqual(invalid, empty);

console.log("PASS AniList extras stays honest and identity-safe");
