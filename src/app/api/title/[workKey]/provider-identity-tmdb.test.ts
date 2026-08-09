import assert from "node:assert/strict";
import type { MediaMetadata } from "@/lib/torrents/types";
import { resolveTitleProviderIdentity } from "./provider-identity";

const noAniList = async () => null;

function tmdbMeta(
  mediaType: "movie" | "tv",
  id: string,
  title: string,
  year: number | null,
  aliases: string[] = [],
): MediaMetadata {
  return { source: "tmdb", mediaType, externalId: id, title, year, aliases };
}

async function run() {
  // A TMDB movie link (the Moon Knight class of BUG-008: provider=tmdb) verifies.
  const movieParams = new URLSearchParams({
    t: "Dune",
    y: "2021",
    type: "movie",
    provider: "tmdb",
    providerId: "438631",
    sourceType: "movie",
    series: "0",
  });
  const movie = await resolveTitleProviderIdentity(
    movieParams,
    "dune-2021",
    noAniList,
    async (mediaType, id) => {
      assert.equal(mediaType, "movie");
      assert.equal(id, "438631");
      return tmdbMeta("movie", "438631", "Dune", 2021, ["Dune: Part One"]);
    },
  );
  assert.equal(movie.kind, "verified");
  if (movie.kind === "verified") {
    assert.equal(movie.identity.provider, "tmdb");
    assert.equal(movie.identity.mediaType, "movie");
    assert.equal(movie.identity.isSeries, false);
    assert.equal(movie.identity.externalId, "438631");
    assert.equal(movie.identity.format, null);
  }

  // A TMDB series link (provider=tmdb, sourceType=tv) verifies — no year in key.
  const tvParams = new URLSearchParams({
    t: "Moon Knight",
    y: "2022",
    type: "tv",
    provider: "tmdb",
    providerId: "92749",
    sourceType: "tv",
    series: "1",
  });
  const tv = await resolveTitleProviderIdentity(
    tvParams,
    "moon-knight",
    noAniList,
    async () => tmdbMeta("tv", "92749", "Moon Knight", 2022),
  );
  assert.equal(tv.kind, "verified");
  if (tv.kind === "verified") {
    assert.equal(tv.identity.isSeries, true);
    assert.equal(tv.identity.mediaType, "tv");
  }

  // A client cannot repoint a work key at an unrelated title via ?providerId=.
  const forged = await resolveTitleProviderIdentity(
    new URLSearchParams({
      t: "Moon Knight",
      y: "2022",
      type: "tv",
      provider: "tmdb",
      providerId: "999",
      sourceType: "tv",
      series: "1",
    }),
    "moon-knight",
    noAniList,
    async () => tmdbMeta("tv", "999", "Some Other Show", 2019),
  );
  assert.equal(forged.kind, "invalid");

  // TMDB outage degrades to a validated carried identity rather than a 400.
  for (const lookup of [
    async () => {
      throw new Error("tmdb timeout");
    },
    async () => null,
  ]) {
    const degraded = await resolveTitleProviderIdentity(
      movieParams,
      "dune-2021",
      noAniList,
      lookup as (m: "movie" | "tv", id: string) => Promise<MediaMetadata | null>,
    );
    assert.equal(degraded.kind, "carried");
    if (degraded.kind === "carried") {
      assert.equal(degraded.identity.provider, "tmdb");
      assert.equal(degraded.identity.verified, false);
      assert.equal(degraded.identity.externalId, "438631");
    }
  }

  // A genuinely unknown provider is still rejected.
  const unknown = await resolveTitleProviderIdentity(
    new URLSearchParams({ provider: "imdb", providerId: "tt1", sourceType: "movie" }),
    "x",
    noAniList,
  );
  assert.equal(unknown.kind, "invalid");
  if (unknown.kind === "invalid") {
    assert.equal(unknown.reason, "Unsupported title provider");
  }

  console.log("PASS TMDB provider identity verifies, forges rejected, outage degrades");
}

run().catch((error) => {
  console.error("FAIL tmdb provider identity", error);
  process.exit(1);
});
