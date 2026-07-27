/**
 * WIRING test — proves the swarm-delivery watchdog is actually reachable in
 * production, not merely correct in isolation.
 *
 * The failure this guards against is the one the reviewer caught: a fully-tested
 * subsystem that nothing ever calls. So this test deliberately does NOT call
 * `swarmDeliveryTick`. It drives the exact seam the engine's throttle loop
 * drives — `markForegroundActive(hash)` then `pollForegroundSwarmWatch()` — and
 * asserts a stalled foreground stream fails over to another release. If failover
 * happens here, it happens in production, because this is the same entry point.
 *
 * The engine I/O (live sample, ranked pool, start, abandon) and the DB/config
 * lookups are injected through the same `buildDeps`/`db`/`getConfig` seams the
 * production path resolves by default — a live WebTorrent swarm is impossible in
 * a unit test, but the wiring from foreground-registration to failover is real.
 */
import assert from "node:assert/strict";

import {
  currentForegroundState,
  pollForegroundSwarmWatch,
  resetSwarmWatch,
  type SwarmWatchDeps,
} from "./swarm-delivery-watchdog";
import { markForegroundActive, resetForegroundState } from "@/lib/prewarm/foreground";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import type { TorrentResult } from "@/lib/torrents/types";

const MB = 1024 * 1024;

function hash(n: number): string {
  return String(n).padStart(40, "0");
}
function release(n: number, seeders: number): TorrentResult {
  return {
    id: `r${n}`,
    // Real cached results are all releases of the *same episode* — the pool the
    // search wrote. `selectBestRelease` requires the title to parse to the
    // asked-for episode, so the fixture must too.
    title: `The Bear S01E01 release ${n} 1080p WEB-DL`,
    magnet: `magnet:?xt=urn:btih:${hash(n)}`,
    infoHash: hash(n),
    sizeBytes: 1000 * MB,
    seeders,
    leechers: 0,
    source: "apibay",
    sourceUrl: "https://example.test",
    tags: [],
  };
}
// The observed pool: 28/3/4/1 seeders. #1 is what the player opened on.
const POOL = [release(1, 28), release(2, 3), release(3, 4), release(4, 1)];
const PLAYING = hash(1);

/** A fake engine whose foreground source is frozen — peers but zero delivery. */
function fakeDeps() {
  let now = 1_000_000;
  const started: string[] = [];
  const abandoned: string[] = [];
  const carried: Array<[string, string]> = [];
  const order: string[] = []; // effect ordering, to prove carry happens before abandon
  const deps: SwarmWatchDeps = {
    async sample() {
      now += 10_000; // 10s per poll, so 30s window is crossed after a few polls
      // Downloading, some bytes fetched once, then frozen forever: the exact
      // shape of the real failure (progress stuck at 0.77%).
      return { atMs: now, downloadedBytes: 900_000, progress: 0.0009, state: "downloading" };
    },
    async rankedResults() {
      return POOL;
    },
    async startRelease(c) {
      order.push("start");
      started.push(c.infoHash);
      return true;
    },
    async abandon(h) {
      order.push("abandon");
      abandoned.push(h);
    },
    async carryPosition(from, to) {
      order.push("carry");
      carried.push([from, to]);
      return 2400; // 40 minutes in
    },
  };
  return { deps, started, abandoned, carried, order };
}

/** A DB stub that resolves the foreground hash to an EngineTorrent row. */
function fakeDb() {
  return {
    engineTorrent: {
      async findFirst() {
        return { userId: "u1", name: "The Bear S01E01 1080p WEB-DL" };
      },
    },
  } as unknown as typeof import("@/lib/prisma").default;
}

const CONFIG = { clientType: "builtin" } as unknown as ClientConnectionConfig;

async function run() {
  // ── Foreground stall fails over through the real seam ──────────────────
  {
    resetForegroundState();
    resetSwarmWatch();
    const { deps, started, abandoned } = fakeDeps();

    // The ONLY trigger. This is the beacon the byte-serving path fires and the
    // engine's throttle loop reads; nothing here reaches into the watchdog.
    markForegroundActive(PLAYING);

    let watchedAtLeastOnce = false;
    for (let i = 0; i < 30 && started.length === 0; i++) {
      const r = await pollForegroundSwarmWatch({
        db: fakeDb(),
        getConfig: async () => CONFIG,
        buildDeps: () => deps,
      });
      if (r.active && r.watched) watchedAtLeastOnce = true;
    }

    assert.ok(watchedAtLeastOnce, "the foreground stream was watched via the real poll seam");
    assert.ok(started.length >= 1, "a stalled foreground stream failed over to another release");
    assert.equal(started[0], hash(2), "failed over to the next-ranked untried source");
    assert.deepEqual(abandoned, [PLAYING], "the stalled source was abandoned (paused, not deleted)");
  }

  // ── Recovery reaches the player: carry position, expose the new source ──
  {
    resetForegroundState();
    resetSwarmWatch();
    const { deps, carried, order } = fakeDeps();

    markForegroundActive(PLAYING);
    for (let i = 0; i < 30; i++) {
      const r = await pollForegroundSwarmWatch({
        db: fakeDb(),
        getConfig: async () => CONFIG,
        buildDeps: () => deps,
      });
      if (r.active && r.watched && r.result.switched) break;
    }

    // Detection alone is not recovery — the switch has to carry through to what
    // the player will read. The position is carried to the new source BEFORE the
    // old one is paused, so an automatic recovery resumes mid-file, not at zero.
    assert.deepEqual(carried, [[PLAYING, hash(2)]], "position was carried to the new source");
    assert.ok(
      order.indexOf("carry") < order.indexOf("abandon"),
      "position is carried before the stalled source is abandoned",
    );

    // The status read the client polls now points at the healthy source with an
    // honest, structured "switching" state — never a bare spinner on a dead hash.
    const state = currentForegroundState();
    assert.ok(state, "the foreground state is readable after a recovery");
    assert.equal(state!.currentHash, hash(2), "the status read points the player at the new source");
    assert.equal(state!.narration.phase, "switching", "the state is a structured switch, not a spinner");
    if (state!.narration.phase === "switching") {
      assert.equal(state!.narration.cause, "delivery", "an automatic recovery is a delivery failure");
    }
    assert.equal(state!.exhausted, false, "a successful recovery is not a terminal dead-end");
  }

  // ── Idle foreground cleans up and does nothing ─────────────────────────
  {
    resetForegroundState();
    resetSwarmWatch();
    const { deps, started } = fakeDeps();

    // No markForegroundActive → foreground is idle → the watchdog must not run.
    const r = await pollForegroundSwarmWatch({
      db: fakeDb(),
      getConfig: async () => CONFIG,
      buildDeps: () => deps,
    });

    assert.equal(r.active, false, "no foreground stream means the watchdog stands down");
    assert.equal(started.length, 0, "nothing is started when no one is watching");
  }

  console.log("swarm-delivery-wiring.test.ts: PASS");
}

run().catch((err) => {
  console.error("swarm-delivery-wiring.test.ts: FAIL");
  console.error(err);
  process.exit(1);
});
