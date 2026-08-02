import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  episodesFromFilenames,
  packEpisodeRange,
  planSeason,
} from "./season-plan";
import type { SwarmVerdict } from "./swarm-probe";
import type { TorrentResult } from "./types";

function result(title: string, seeders = 30): TorrentResult {
  const infoHash = createHash("sha1").update(title).digest("hex");
  return {
    id: infoHash,
    title,
    magnet: `magnet:?xt=urn:btih:${infoHash}`,
    infoHash,
    sizeBytes: 1_400_000_000,
    seeders,
    leechers: 3,
    source: "apibay",
    sourceUrl: "https://example.invalid",
    tags: [],
  };
}

function verdicts(table: Record<string, SwarmVerdict>) {
  return (release: TorrentResult): SwarmVerdict =>
    table[release.title] ?? "unknown";
}

assert.deepEqual(packEpisodeRange("The Show S01E01-E08 1080p"), {
  from: 1,
  to: 8,
});
assert.equal(packEpisodeRange("The Show 2019-2021 Complete"), null);

{
  // A season search returns only packs, and none are live on a first grab, so
  // their file lists cannot be read. The pack is taken on its name, marked
  // unconfirmed — dropping it here is what left whole seasons un-downloadable.
  const pack = result("The Expanse S01 COMPLETE");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack],
    verdictOf: () => "good",
  });
  assert.equal(plan.pack?.release.infoHash, pack.infoHash, "name-only pack is takeable");
  assert.equal(plan.pack?.coverageBasis, "inferred", "its coverage is inferred, not fact");
  assert.equal(plan.coverageConfirmed, false, "an inferred pack is not reported as confirmed");
  assert.deepEqual(plan.covered, [1, 2, 3], "it is credited the whole season it names");
  assert.deepEqual(plan.missing, []);
  assert.match(plan.reason, /should cover/, "the reason states the inference, not a fact");
}

for (const count of [0, 1, 6, 8, 23]) {
  const pack = result(`Blue Eye Samurai S01 COMPLETE ${count}`);
  const wanted = Array.from({ length: 24 }, (_, index) => index + 1);
  const plan = planSeason({
    season: 1,
    wanted,
    releases: [pack],
    verdictOf: () => "good",
    packContents: () => wanted.slice(0, count),
  });
  assert.equal(plan.pack, null, `${count}/24 manifest is rejected`);
  assert.deepEqual(plan.covered, []);
}

for (const count of [24, 26]) {
  const pack = result(`Arcane S01 COMPLETE ${count}`);
  const wanted = Array.from({ length: 24 }, (_, index) => index + 1);
  const plan = planSeason({
    season: 1,
    wanted,
    releases: [pack],
    verdictOf: () => "unknown",
    packContents: () =>
      Array.from({ length: count }, (_, index) => index + 1),
  });
  assert.equal(plan.pack?.release.infoHash, pack.infoHash);
  assert.equal(plan.pack?.coverageBasis, "confirmed");
  assert.deepEqual(plan.covered, wanted);
}

{
  const dead = result("Severance S01 COMPLETE dead", 50);
  const good = result("Severance S01 COMPLETE good", 10);
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [dead, good],
    verdictOf: verdicts({
      [dead.title]: "dead",
      [good.title]: "good",
    }),
    packContents: () => [1, 2, 3],
  });
  assert.equal(plan.pack?.release.infoHash, good.infoHash);
}

{
  const pack = result("The Bear S01 COMPLETE");
  const e1 = result("The Bear S01E01 1080p");
  const e2 = result("The Bear S01E02 1080p");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2],
    releases: [pack, e1, e2],
    verdictOf: verdicts({
      [pack.title]: "dead",
      [e1.title]: "good",
      [e2.title]: "good",
    }),
    packContents: () => [1, 2],
  });
  assert.equal(plan.pack, null, "good exact episodes beat a dead pack");
  assert.deepEqual(
    plan.singles.map((single) => single.episode),
    [1, 2],
  );
}

{
  const pack = result("Frieren S01E01-E08 COMPLETE");
  const e9 = result("Frieren S01E09 1080p");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    releases: [pack, e9],
    verdictOf: () => "good",
    packContents: () => [1, 2, 3, 4, 5, 6, 7, 8],
  });
  assert.equal(plan.pack, null, "verified partial packs are not eligible");
  assert.deepEqual(plan.covered, [9]);
  assert.deepEqual(plan.missing, [1, 2, 3, 4, 5, 6, 7, 8]);
}

{
  const wrong = result("Shogun S02 COMPLETE");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2],
    releases: [wrong],
    verdictOf: () => "good",
    packContents: () => [1, 2],
  });
  assert.equal(plan.pack, null);
}

assert.deepEqual(
  episodesFromFilenames(
    [
      "Severance/Severance.S01E01.1080p.mkv",
      "Severance/Severance.S01E02.1080p.mkv",
      "Severance/E03.mkv",
      "Severance/sample.mkv",
      "Severance/Severance.S02E05.mkv",
    ],
    1,
  ),
  [1, 2, 3],
);

console.log("season-plan.test.ts: PASS (manifest-first selection)");
