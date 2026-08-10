import assert from "node:assert/strict";

import {
  manualSwitchTo,
  resetSwarmWatch,
  stopSwarmWatch,
  swarmDeliveryTick,
  type SwarmWatchDeps,
} from "./swarm-delivery-watchdog";
import { preRankKey } from "@/lib/prewarm/prerank";
import type { AutomaticFailureCause } from "./narration";
import type { TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";

const TARGET: PreRankTarget = {
  title: "Only Murders in the Building",
  mediaType: "tv",
  season: 2,
  episode: 7,
};

function hash(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function pool(size: number): TorrentResult[] {
  return Array.from({ length: size }, (_, index) => ({
    id: `r${index}`,
    title: `Only Murders in the Building S02E07 release ${index + 1}`,
    magnet: `magnet:?xt=urn:btih:${hash(index + 1)}`,
    infoHash: hash(index + 1),
    sizeBytes: 900_000_000,
    seeders: Math.max(1, size - index),
    leechers: 0,
    source: "apibay",
    sourceUrl: "https://example.test",
    tags: [],
  }));
}

function sample(progressing: boolean) {
  let tick = 0;
  return async () => {
    tick += 1;
    return {
      atMs: tick * 31_000,
      downloadedBytes: progressing ? tick * 1_000_000 : 0,
      progress: progressing ? tick / 100 : 0,
      state: "downloading",
    };
  };
}

async function candidateMatrix(): Promise<void> {
  for (let size = 0; size <= 12; size += 1) {
    if (size === 0) {
      resetSwarmWatch();
      const attempted: string[] = [];
      const deps: SwarmWatchDeps = {
        sample: sample(false),
        rankedResults: async () => [],
        startRelease: async (candidate) => {
          attempted.push(candidate.infoHash);
          return false;
        },
        abandon: async () => undefined,
      };
      const result = await swarmDeliveryTick(`empty-${size}`, hash(99), TARGET, deps, {
        force: true,
        failure: "stall",
      });
      assert.equal(result.exhausted, true);
      assert.deepEqual(attempted, []);
      continue;
    }

    for (let successIndex = 0; successIndex < size; successIndex += 1) {
      resetSwarmWatch();
      const candidates = pool(size);
      const attempted: string[] = [];
      const deps: SwarmWatchDeps = {
        sample: sample(successIndex === 0),
        rankedResults: async () => candidates,
        startRelease: async (candidate) => {
          attempted.push(candidate.infoHash);
          return candidate.infoHash === hash(successIndex + 1);
        },
        abandon: async () => undefined,
      };
      const result = await swarmDeliveryTick(
        `matrix-${size}-${successIndex}`,
        hash(1),
        TARGET,
        deps,
        successIndex === 0 ? {} : { force: true, failure: "stall" },
      );
      assert.equal(result.exhausted, false, `N=${size}, success=${successIndex}`);
      assert.equal(result.currentHash, hash(successIndex + 1), `N=${size}, success=${successIndex}`);
      assert.deepEqual(
        attempted,
        Array.from({ length: successIndex }, (_, index) => hash(index + 2)),
        `N=${size}: every unique candidate through success ${successIndex} attempted once`,
      );
    }
  }
}

async function everyFailureAdvances(): Promise<void> {
  const failures: AutomaticFailureCause[] = [
    "metadata-timeout",
    "no-peers",
    "stall",
    "start",
    "decode",
    "unsupported",
  ];
  for (const failure of failures) {
    resetSwarmWatch();
    const started: string[] = [];
    const deps: SwarmWatchDeps = {
      sample: sample(false),
      rankedResults: async () => pool(2),
      startRelease: async (candidate) => {
        started.push(candidate.infoHash);
        return true;
      },
      abandon: async () => undefined,
    };
    const result = await swarmDeliveryTick(`cause-${failure}`, hash(1), TARGET, deps, {
      failure,
    });
    assert.equal(result.currentHash, hash(2), `${failure} advances automatically`);
    assert.deepEqual(started, [hash(2)]);
  }
}

async function lateDiscoveryAndManualChoice(): Promise<void> {
  resetSwarmWatch();
  const late = pool(6)[5];
  const started: string[] = [];
  let discoveries = 0;
  const deps: SwarmWatchDeps = {
    sample: sample(false),
    rankedResults: async () => pool(5),
    discoverResults: async () => {
      discoveries += 1;
      return { results: [late], exhausted: true };
    },
    startRelease: async (candidate) => {
      started.push(candidate.infoHash);
      return candidate.infoHash === late.infoHash;
    },
    abandon: async () => undefined,
  };
  const result = await swarmDeliveryTick("late-six", hash(1), TARGET, deps, {
    force: true,
    failure: "start",
  });
  assert.equal(result.currentHash, hash(6), "candidate position 6 succeeds after cache exhaustion");
  assert.equal(discoveries, 1, "one bounded discovery runs after the initial pool is exhausted");
  assert.deepEqual(started, [hash(2), hash(3), hash(4), hash(5), hash(6)]);

  resetSwarmWatch();
  const manualStarted: string[] = [];
  const candidates = pool(3);
  const manualDeps = {
    rankedResults: async () => candidates,
    startRelease: async (candidate: { infoHash: string }) => {
      manualStarted.push(candidate.infoHash);
      return true;
    },
    abandon: async () => undefined,
    carryPosition: async () => 321,
  };
  await manualSwitchTo("manual-auto", hash(1), hash(2), TARGET, manualDeps);
  manualStarted.length = 0;
  const auto = await swarmDeliveryTick("manual-auto", hash(2), TARGET, {
    ...manualDeps,
    sample: sample(false),
  }, {
    force: true,
    failure: "decode",
  });
  assert.equal(auto.currentHash, hash(3), "a manual choice never blocks automatic recovery");
  assert.deepEqual(manualStarted, [hash(3)]);
}

async function resolutionAffinityAndFallback(): Promise<void> {
  const qualityPool = (resolutions: readonly number[]): TorrentResult[] =>
    resolutions.map((resolution, index) => ({
      ...pool(resolutions.length)[index],
      title: `Only Murders in the Building S02E07 ${resolution}p WEB-DL`,
      seeders: 20,
    }));

  resetSwarmWatch();
  const preferred = await swarmDeliveryTick(
    "resolution-exact",
    hash(99),
    { ...TARGET, preferredResolution: 720 },
    {
      sample: sample(false),
      rankedResults: async () => qualityPool([2160, 1080, 720]),
      startRelease: async () => true,
      abandon: async () => undefined,
    },
    { failure: "start" },
  );
  assert.equal(preferred.currentHash, hash(3), "the exact preferred resolution wins");

  resetSwarmWatch();
  const fallback = await swarmDeliveryTick(
    "resolution-fallback",
    hash(99),
    { ...TARGET, preferredResolution: 1080 },
    {
      sample: sample(false),
      rankedResults: async () => qualityPool([2160, 720]),
      startRelease: async () => true,
      abandon: async () => undefined,
    },
    { failure: "start" },
  );
  assert.equal(
    fallback.currentHash,
    hash(1),
    "when the preferred resolution is absent, higher eligible fallback wins and lower resolutions stay ineligible",
  );
}

async function generationAndCancellationSafety(): Promise<void> {
  resetSwarmWatch();
  const candidates = pool(3);
  let releaseStart!: (value: boolean) => void;
  const startGate = new Promise<boolean>((resolve) => {
    releaseStart = resolve;
  });
  const abandoned: string[] = [];
  const deps: SwarmWatchDeps = {
    sample: sample(false),
    rankedResults: async () => candidates,
    startRelease: async () => startGate,
    abandon: async (infoHash) => {
      abandoned.push(infoHash);
    },
  };
  const staleTick = swarmDeliveryTick("generation", hash(1), TARGET, deps, {
    force: true,
    failure: "stall",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const manual = await manualSwitchTo(
    "generation",
    hash(1),
    hash(3),
    TARGET,
    {
      rankedResults: async () => candidates,
      startRelease: async () => true,
      abandon: deps.abandon,
      carryPosition: async () => 456,
    },
  );
  assert.equal(manual.ok, true);
  releaseStart(true);
  const stale = await staleTick;
  assert.equal(stale.currentHash, hash(3), "an older generation cannot replace a newer switch");
  assert.ok(
    abandoned.includes(hash(2)),
    "a source started by a cancelled generation is paused",
  );

  resetSwarmWatch();
  let resolveDiscoverySignal!: (signal: AbortSignal) => void;
  const discoverySignalSeen = new Promise<AbortSignal>((resolve) => {
    resolveDiscoverySignal = resolve;
  });
  let resolveDiscovery!: (
    value: { results: readonly TorrentResult[]; exhausted: boolean },
  ) => void;
  const discoveryGate = new Promise<{
    results: readonly TorrentResult[];
    exhausted: boolean;
  }>((resolve) => {
    resolveDiscovery = resolve;
  });
  const cancelled = swarmDeliveryTick(
    "cancelled-discovery",
    hash(99),
    TARGET,
    {
      sample: sample(false),
      rankedResults: async () => [],
      discoverResults: async (_target, options) => {
        resolveDiscoverySignal(options.signal);
        return discoveryGate;
      },
      startRelease: async () => true,
      abandon: async () => undefined,
    },
    { force: true, failure: "metadata-timeout" },
  );
  const discoverySignal = await discoverySignalSeen;
  stopSwarmWatch("cancelled-discovery");
  assert.equal(discoverySignal.aborted, true, "stopping playback aborts discovery");
  resolveDiscovery({ results: [candidates[1]], exhausted: true });
  const cancelledResult = await cancelled;
  assert.equal(cancelledResult.switched, false);

  resetSwarmWatch();
  let activeDiscoveries = 0;
  let maxActiveDiscoveries = 0;
  const boundedDeps: SwarmWatchDeps = {
    sample: sample(false),
    rankedResults: async () => [],
    discoverResults: async () => {
      activeDiscoveries += 1;
      maxActiveDiscoveries = Math.max(
        maxActiveDiscoveries,
        activeDiscoveries,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDiscoveries -= 1;
      return { results: [], exhausted: true };
    },
    startRelease: async () => false,
    abandon: async () => undefined,
  };
  await Promise.all([
    swarmDeliveryTick("bounded", hash(99), TARGET, boundedDeps, {
      force: true,
      failure: "no-peers",
    }),
    swarmDeliveryTick("bounded", hash(99), TARGET, boundedDeps, {
      force: true,
      failure: "no-peers",
    }),
  ]);
  assert.equal(
    maxActiveDiscoveries,
    1,
    "discovery/probe work is serialized per playback generation",
  );
}

async function stableIdentityAndSwitchRaces(): Promise<void> {
  const target720 = { ...TARGET, preferredResolution: 720 };
  const target480 = { ...TARGET, preferredResolution: 480 };
  assert.equal(
    preRankKey(target720),
    preRankKey(target480),
    "watchdog identity is work/season/episode, never preferred resolution",
  );

  resetSwarmWatch();
  let releaseSlow!: (value: boolean) => void;
  let slowStarted!: () => void;
  const slowStartedSeen = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  const slowGate = new Promise<boolean>((resolve) => {
    releaseSlow = resolve;
  });
  const abandoned: string[] = [];
  const raceDeps = {
    rankedResults: async () => pool(3),
    startRelease: async (candidate: { infoHash: string }) => {
      if (candidate.infoHash === hash(2)) {
        slowStarted();
        return slowGate;
      }
      return true;
    },
    abandon: async (infoHash: string) => {
      abandoned.push(infoHash);
    },
    carryPosition: async () => 123,
  };
  const slow = manualSwitchTo(
    preRankKey(target720),
    hash(1),
    hash(2),
    target720,
    raceDeps,
  );
  await slowStartedSeen;
  const fast = manualSwitchTo(
    preRankKey(target480),
    hash(1),
    hash(3),
    target480,
    raceDeps,
  );
  releaseSlow(true);
  const [slowResult, fastResult] = await Promise.all([slow, fast]);
  assert.equal(slowResult.ok, false, "the superseded slow switch does not commit");
  assert.equal(fastResult.ok, true, "the latest switch commits");
  assert.ok(abandoned.includes(hash(2)), "a superseded source that started is paused");
  assert.ok(!abandoned.includes(hash(3)), "the winning source remains running");

  const current = await swarmDeliveryTick(
    preRankKey(target480),
    hash(3),
    target480,
    {
      sample: sample(true),
      rankedResults: async () => pool(3),
      startRelease: async () => true,
      abandon: async () => undefined,
    },
  );
  assert.equal(current.currentHash, hash(3), "the shared session ends on the latest source");
}

async function automaticResolutionUpdateCancelsOlderTick(): Promise<void> {
  resetSwarmWatch();
  const qualityPool = [1080, 720, 480].map((resolution, index) => ({
    ...pool(3)[index],
    title: `Only Murders in the Building S02E07 ${resolution}p WEB-DL`,
    seeders: 20,
  }));
  const target720 = { ...TARGET, preferredResolution: 720 };
  const target480 = { ...TARGET, preferredResolution: 480 };
  const key = preRankKey(target720);
  let releaseSlow!: (value: boolean) => void;
  let slowStarted!: () => void;
  const slowStartedSeen = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  const slowGate = new Promise<boolean>((resolve) => {
    releaseSlow = resolve;
  });
  const abandoned: string[] = [];
  const deps: SwarmWatchDeps = {
    sample: sample(false),
    rankedResults: async () => qualityPool,
    startRelease: async (candidate) => {
      if (candidate.infoHash === hash(2)) {
        slowStarted();
        return slowGate;
      }
      return true;
    },
    abandon: async (infoHash) => {
      abandoned.push(infoHash);
    },
  };
  const earlier = swarmDeliveryTick(key, hash(1), target720, deps, {
    failure: "start",
  });
  await slowStartedSeen;
  const later = swarmDeliveryTick(key, hash(1), target480, deps, {
    failure: "start",
  });
  releaseSlow(true);
  const [earlierResult, laterResult] = await Promise.all([earlier, later]);
  assert.equal(earlierResult.switched, false, "an obsolete automatic plan cannot commit");
  assert.equal(laterResult.currentHash, hash(3), "the latest preference atomically wins");
  assert.ok(abandoned.includes(hash(2)), "the obsolete automatic source is paused");
}

async function preservesPositionAndSwapOrder(): Promise<void> {
  resetSwarmWatch();
  const events: string[] = [];
  const result = await swarmDeliveryTick(
    "position-order",
    hash(1),
    TARGET,
    {
      sample: sample(false),
      rankedResults: async () => pool(2),
      startRelease: async () => {
        events.push("start-new");
        return true;
      },
      carryPosition: async () => {
        events.push("carry-position");
        return 777;
      },
      abandon: async () => {
        events.push("pause-old");
      },
    },
    { force: true, failure: "stall" },
  );
  assert.equal(result.currentHash, hash(2));
  assert.deepEqual(events, [
    "start-new",
    "carry-position",
    "pause-old",
  ]);
}

async function main(): Promise<void> {
  await candidateMatrix();
  await everyFailureAdvances();
  await lateDiscoveryAndManualChoice();
  await resolutionAffinityAndFallback();
  await generationAndCancellationSafety();
  await stableIdentityAndSwitchRaces();
  await automaticResolutionUpdateCancelsOlderTick();
  await preservesPositionAndSwapOrder();
  console.log("automatic-failover.test.ts: PASS (N=0..12, all success positions)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
