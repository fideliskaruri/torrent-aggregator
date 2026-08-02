import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { selectSeriesCandidateWithPackPreference } from "./pack-preference";
import { episodesFromFilenames, planSeason } from "./season-plan";
import type { TorrentResult } from "./types";

function release(title: string, seeders = 20): TorrentResult {
  const infoHash = createHash("sha1").update(title).digest("hex");
  return {
    id: infoHash,
    title,
    magnet: `magnet:?xt=urn:btih:${infoHash}`,
    infoHash,
    sizeBytes: 8_000_000_000,
    seeders,
    leechers: 1,
    source: "apibay",
    sourceUrl: "https://example.test",
    tags: [],
  };
}

const wanted = Array.from({ length: 24 }, (_, index) => index + 1);
const coverageCases = [
  ["The Expanse", 0],
  ["Blue Eye Samurai", 1],
  ["Severance", 6],
  ["The Bear", 8],
  ["Frieren Beyond Journey's End", 23],
] as const;

for (const [show, count] of coverageCases) {
  const pack = release(`${show} S01 COMPLETE 1080p`);
  const plan = planSeason({
    season: 1,
    wanted,
    releases: [pack],
    verdictOf: () => "good",
    packContents: () => wanted.slice(0, count),
  });
  assert.equal(plan.pack, null, `${show}: verified ${count}/24 pack must be structurally ineligible`);
  assert.deepEqual(plan.covered, [], `${show}: rejected pack must not claim coverage`);
}

for (const count of [24, 27]) {
  const pack = release(`Arcane S01 COMPLETE manifest-${count}`);
  const plan = planSeason({
    season: 1,
    wanted,
    releases: [pack],
    verdictOf: () => "unknown",
    packContents: () => Array.from({ length: count }, (_, index) => index + 1),
  });
  assert.equal(plan.pack?.release.infoHash, pack.infoHash, `${count}/24 verified pack is eligible`);
  assert.deepEqual(plan.covered, wanted);
}

{
  // A complete-sounding name with no readable files is no longer dropped — a
  // season's packs are never live on a first grab, so dropping them left whole
  // seasons un-downloadable. It is taken, but marked inferred so its coverage
  // is reported as "should cover", never claimed as verified fact.
  const namedOnly = release("Shogun S01 COMPLETE ALL EPISODES 2160p");
  const plan = planSeason({
    season: 1,
    wanted,
    releases: [namedOnly],
    verdictOf: () => "good",
  });
  assert.equal(plan.pack?.release.infoHash, namedOnly.infoHash, "a name-only pack is takeable");
  assert.equal(plan.pack?.coverageBasis, "inferred", "its coverage is inferred, not verified");
  assert.equal(plan.coverageConfirmed, false, "and is not reported as confirmed");
  assert.deepEqual(plan.covered, wanted);
}

{
  const exact = release("The Bear S01E06 1080p WEB-DL", 10);
  const pack = release("The Bear S01 COMPLETE 2160p WEB-DL", 100);
  const selected = selectSeriesCandidateWithPackPreference(
    [pack, exact],
    { season: 1, episode: 6 },
  );
  assert.equal(
    selected?.infoHash,
    exact.infoHash,
    "an episode keep selects the exact episode and never promotes a season pack",
  );
}

for (const title of [
  "The Bear S01E01-E08 1080p WEB-DL",
  "Arcane S01E01-08 2160p Batch",
  "Severance 1x01-1x08 1080p",
  "Frieren Episodes 1-8 720p",
]) {
  const ranged = release(title);
  const selected = selectSeriesCandidateWithPackPreference(
    [ranged],
    { season: 1, episode: 1 },
  );
  assert.equal(selected, null, `${title}: a range/batch is never an exact episode`);
}

{
  const metadataBatch = {
    ...release("Blue Eye Samurai release 1"),
    episode: {
      season: 1,
      episode: 1,
      label: "S01E01",
      isBatch: true,
      isSeasonPack: false,
    },
  };
  assert.equal(
    selectSeriesCandidateWithPackPreference([metadataBatch], {
      season: 1,
      episode: 1,
    }),
    null,
    "structured batch metadata cannot enter the exact branch",
  );
}

{
  const subtitleManifest = wanted.flatMap((episode) => [
    `Show.S01E${String(episode).padStart(2, "0")}.srt`,
    `Show.S01E${String(episode).padStart(2, "0")}.ass`,
    `metadata/Show.S01E${String(episode).padStart(2, "0")}.nfo`,
  ]);
  assert.deepEqual(
    episodesFromFilenames(subtitleManifest, 1),
    [],
    "subtitle and metadata files prove no playable episode coverage",
  );

  const pack = release("Show S01 COMPLETE");
  const plan = planSeason({
    season: 1,
    wanted,
    releases: [pack],
    verdictOf: () => "good",
    packContents: () => episodesFromFilenames(subtitleManifest, 1),
  });
  assert.equal(plan.pack, null, "subtitle-only fake coverage cannot qualify a pack");
}

console.log("automatic-selection.test.ts: PASS (16 structural cases)");
