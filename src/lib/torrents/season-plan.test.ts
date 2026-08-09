import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  episodesFromFilenames,
  packEpisodeRange,
  planSeason,
} from "./season-plan";
import type { TorrentResult } from "./types";

function result(title: string, seeders = 10): TorrentResult {
  const infoHash = createHash("sha1").update(title).digest("hex");
  return {
    id: infoHash,
    title,
    magnet: `magnet:?xt=urn:btih:${infoHash}`,
    infoHash,
    seeders,
    leechers: 1,
    sizeBytes: 1_000_000,
    source: "apibay",
    sourceUrl: "https://example.invalid",
    tags: [],
  };
}

assert.deepEqual(packEpisodeRange("The Show S01E01-E08 1080p"), {
  from: 1,
  to: 8,
});
assert.equal(packEpisodeRange("The Show 2019-2021 Complete"), null);
assert.deepEqual(
  episodesFromFilenames(
    [
      "The.Show.S01E01.mkv",
      "The.Show.S01E02.mkv",
      "sample.mkv",
      "The.Show.S02E01.mkv",
    ],
    1,
  ),
  [1, 2],
);

{
  const pack = result("The Expanse S01 COMPLETE");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack],
    verdictOf: () => "good",
    packContents: () => [1, 2, 3],
  });
  assert.equal(plan.pack, null, "season acquisition never selects packs");
  assert.deepEqual(plan.covered, []);
  assert.deepEqual(plan.missing, [1, 2, 3]);
  assert.doesNotMatch(plan.reason, /pack|estimated|release name/i);
}

{
  const pack = result("The Bear S01 COMPLETE");
  const singles = [1, 2, 3].map((episode) =>
    result(`The Bear S01E${String(episode).padStart(2, "0")} 1080p`),
  );
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack, ...singles],
    verdictOf: () => "unknown",
  });
  assert.equal(plan.pack, null);
  assert.deepEqual(
    plan.singles.map((single) => single.episode),
    [1, 2, 3],
  );
  assert.deepEqual(plan.missing, []);
}

{
  const pack = result("Old Show S01 COMPLETE");
  const e1 = result("Old Show S01E01 1080p");
  const e2 = result("Old Show S01E02 1080p");
  const plan = planSeason({
    season: 1,
    wanted: [1, 2, 3],
    releases: [pack, e1, e2],
    verdictOf: () => "unknown",
    packContents: () => [1, 2, 3],
  });
  assert.equal(plan.pack, null);
  assert.deepEqual(
    plan.singles.map((single) => single.episode),
    [1, 2],
  );
  assert.deepEqual(plan.missing, [3], "a pack never fills an exact-episode gap");
}

{
  const e1_4k = result("Rick and Morty S09E01 2160p WEB");
  const e1_hd = result("Rick and Morty S09E01 1080p WEB");
  const plan = planSeason({
    season: 9,
    wanted: [1],
    releases: [e1_4k, e1_hd],
    verdictOf: () => "unknown",
    preferredResolution: 1080,
  });
  assert.equal(plan.singles[0]?.release.infoHash, e1_hd.infoHash);
}

{
  const weakOnly = result("The Show S01E01 720p", 1);
  const plan = planSeason({
    season: 1,
    wanted: [1],
    releases: [weakOnly],
    verdictOf: () => "weak",
  });
  assert.equal(
    plan.singles[0]?.release.infoHash,
    weakOnly.infoHash,
    "demote-never-filter still applies to exact episodes",
  );
}

{
  const wrongSeason = result("The Show S02E01 1080p");
  const plan = planSeason({
    season: 1,
    wanted: [1],
    releases: [wrongSeason],
    verdictOf: () => "good",
  });
  assert.deepEqual(plan.singles, []);
  assert.deepEqual(plan.missing, [1]);
}

for (const title of [
  "The Show S01E01-E08 1080p",
  "The Show S01E01~E08 1080p",
  "The Show 1x01-1x08 1080p",
  "The Show Episodes 1-8 1080p",
]) {
  const plan = planSeason({
    season: 1,
    wanted: [1],
    releases: [result(title)],
    verdictOf: () => "good",
  });
  assert.deepEqual(plan.singles, [], `${title}: range is not an exact episode`);
  assert.deepEqual(plan.missing, [1]);
}

console.log("season-plan.test.ts: PASS (exact episode selection only)");
