import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { planSeason } from "../../src/lib/torrents/season-plan";
import {
  resetSwarmWatch,
  swarmDeliveryTick,
  type SwarmWatchDeps,
} from "../../src/lib/playback/swarm-delivery-watchdog";
import { chooseNextRelease } from "../../src/lib/playback/failover";
import type { TorrentResult } from "../../src/lib/torrents/types";
import type { PreRankTarget } from "../../src/lib/prewarm/types";

function hash(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function release(index: number): TorrentResult {
  return {
    id: `release-${index}`,
    title: `Dark Winds S03E04 release ${index}`,
    magnet: `magnet:?xt=urn:btih:${hash(index)}`,
    infoHash: hash(index),
    sizeBytes: 800_000_000,
    seeders: 20 - index,
    leechers: 0,
    source: "apibay",
    sourceUrl: "https://example.test",
    tags: [],
  };
}

const wanted = Array.from({ length: 24 }, (_, index) => index + 1);
const packTitle = "Dark Winds S03 COMPLETE";
const packHash = createHash("sha1").update(packTitle).digest("hex");
const pack: TorrentResult = {
  ...release(99),
  id: packHash,
  title: packTitle,
  infoHash: packHash,
  magnet: `magnet:?xt=urn:btih:${packHash}`,
};
const plan = planSeason({
  season: 3,
  wanted,
  releases: [pack],
  verdictOf: () => "good",
  packContents: () => wanted.slice(0, 23),
});
assert.equal(plan.pack, null);

resetSwarmWatch();
const attempted: string[] = [];
const pool = Array.from({ length: 6 }, (_, index) => release(index + 1));
const target: PreRankTarget = {
  title: "Dark Winds",
  mediaType: "tv",
  season: 3,
  episode: 4,
};
const deps: SwarmWatchDeps = {
  sample: async () => ({
    atMs: 31_000,
    downloadedBytes: 0,
    progress: 0,
    state: "downloading",
  }),
  rankedResults: async () => pool,
  startRelease: async (candidate) => {
    attempted.push(candidate.infoHash);
    return candidate.infoHash === hash(6);
  },
  abandon: async () => undefined,
};
const failover = await swarmDeliveryTick(
  "dark-winds|S3E4",
  hash(1),
  target,
  deps,
  { force: true, failure: "stall" },
);
assert.equal(failover.currentHash, hash(6));
assert.deepEqual(attempted, [hash(2), hash(3), hash(4), hash(5), hash(6)]);

const atResolution = (index: number, resolution: number): TorrentResult => ({
  ...release(index),
  title: `Dark Winds S03E04 ${resolution}p WEB-DL`,
});
const exactResolution = chooseNextRelease(
  [atResolution(7, 2160), atResolution(8, 1080), atResolution(9, 720)],
  { ...target, preferredResolution: 720 },
  [],
);
assert.match(exactResolution?.release.title ?? "", /720p/);
const fallbackResolution = chooseNextRelease(
  [atResolution(10, 2160), atResolution(11, 720)],
  { ...target, preferredResolution: 1080 },
  [],
);
assert.match(fallbackResolution?.release.title ?? "", /720p/);

console.log(
  JSON.stringify({
    incompletePack: {
      verified: 23,
      expected: 24,
      eligible: plan.pack !== null,
    },
    failover: {
      candidateCount: 6,
      attemptedPositions: [2, 3, 4, 5, 6],
      selectedPosition: 6,
    },
    resolutionAffinity: {
      preferred720: exactResolution?.release.title,
      fallbackFrom1080: fallbackResolution?.release.title,
    },
  }),
);
