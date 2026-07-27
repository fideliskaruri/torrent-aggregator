import assert from "node:assert/strict";

import { resetSwarmWatch, swarmDeliveryTick, type SwarmWatchDeps } from "./swarm-delivery-watchdog";
import { MAX_FAILOVER_ATTEMPTS } from "./failover";
import type { TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";

const MB = 1024 * 1024;
const TARGET: PreRankTarget = { title: "The Bear", mediaType: "tv" };
const KEY = "the-bear|S1E1";

function hash(n: number): string {
  return String(n).padStart(40, "0");
}
function release(n: number, seeders: number): TorrentResult {
  return {
    id: `r${n}`,
    title: `The Bear release ${n}`,
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
const POOL = [release(1, 28), release(2, 3), release(3, 4), release(4, 1)];

interface Harness {
  deps: SwarmWatchDeps;
  started: string[];
  abandoned: string[];
  events: string[];
}

/** Fake engine. `mode: "frozen"` never delivers; `mode: "progress"` always does. */
function harness(mode: "frozen" | "progress" | "cold-start"): Harness {
  let now = 1_000_000;
  let progressed = 0;
  const started: string[] = [];
  const abandoned: string[] = [];
  const events: string[] = [];
  const deps: SwarmWatchDeps = {
    async sample() {
      now += 10_000; // 10s per poll
      if (mode === "progress") {
        progressed += 1_200_000; // ~120 KB/s — slow but real
        return { atMs: now, downloadedBytes: progressed, progress: progressed / (1000 * MB), state: "downloading" };
      }
      if (mode === "cold-start") {
        return {
          atMs: now,
          downloadedBytes: 0,
          progress: 0,
          state: "downloading",
          peerCount: 12,
          activeRequestCount: 8,
        };
      }
      return { atMs: now, downloadedBytes: 900_000, progress: 0.0009, state: "downloading" };
    },
    async rankedResults() {
      return POOL;
    },
    async startRelease(c) {
      started.push(c.infoHash);
      events.push(`start:${c.infoHash}`);
      return true;
    },
    async abandon(h) {
      abandoned.push(h);
      events.push(`abandon:${h}`);
    },
  };
  return { deps, started, abandoned, events };
}

async function run() {
  // ── A frozen swarm fails over down the pool, then reports exhausted ────
  {
    resetSwarmWatch();
    const h = harness("frozen");
    let current = hash(1);
    let exhausted = false;
    let switches = 0;
    for (let i = 0; i < 60 && !exhausted; i++) {
      const r = await swarmDeliveryTick(KEY, current, TARGET, h.deps);
      current = r.currentHash;
      if (r.switched) switches += 1;
      exhausted = r.exhausted;
    }

    assert.ok(exhausted, "a fully-dead pool reaches the terminal exhausted state");
    assert.deepEqual(
      h.started,
      [hash(2), hash(3), hash(4)],
      "failed over to each remaining source in rank order",
    );
    assert.equal(new Set(h.started).size, h.started.length, "no source started twice");
    assert.equal(switches, 3, "one switch per remaining source");

    // DATA ON ABANDON: dead sources are abandoned (paused), never deleted —
    // there is no delete dependency at all, by design.
    assert.deepEqual(h.abandoned, [hash(1), hash(2), hash(3)], "each dead source abandoned once");
    assert.ok(
      !("delete" in h.deps) && !("remove" in h.deps),
      "the watchdog has no delete capability — partial bytes are kept",
    );

    // Every switch starts the new source BEFORE abandoning the old one, so a
    // failed start can never strand us with nothing running.
    const firstStart = h.events.indexOf(`start:${hash(2)}`);
    const firstAbandon = h.events.indexOf(`abandon:${hash(1)}`);
    assert.ok(firstStart >= 0 && firstStart < firstAbandon, "start precedes abandon");
  }

  // ── A legitimate cold start is not a stall merely because bytes are still zero ─
  {
    resetSwarmWatch();
    const h = harness("cold-start");
    let current = hash(1);
    let sawColdStarting = false;
    for (let i = 0; i < 22; i++) {
      const r = await swarmDeliveryTick("cold-season-pack|S1E1", current, TARGET, h.deps);
      current = r.currentHash;
      assert.equal(r.switched, false, `tick ${i}: active peer requests mean cold-start, not failover`);
      assert.equal(r.exhausted, false, `tick ${i}: active peer requests must not exhaust the pool`);
      if (r.verdict.reason === "cold-starting") {
        sawColdStarting = true;
        assert.equal(r.narration.phase, "starting", "cold start remains a starting state");
        if (r.narration.phase === "starting") {
          assert.equal(r.narration.outcome.kind, "wait", "cold start tells the UI to keep waiting");
          assert.equal(r.narration.outcome.reason, "cold-starting", "the actionable wait reason is specific");
          assert.equal(r.narration.outcome.peerCount, 12, "peer count is carried for UI copy");
          assert.equal(r.narration.outcome.activeRequestCount, 8, "request activity is carried for diagnostics");
        }
      }
    }
    assert.equal(h.started.length, 0, "never started an alternate during an active cold start");
    assert.equal(h.abandoned.length, 0, "never abandoned the source during an active cold start");
    assert.ok(sawColdStarting, "the stall verdict exposes cold-starting as the consulted decision state");
    assert.equal(current, hash(1), "stays on the original source while cold-starting");
  }

  // ── A slow-but-progressing swarm is never abandoned ───────────────────
  {
    resetSwarmWatch();
    const h = harness("progress");
    let current = hash(1);
    let sawPlaying = false;
    for (let i = 0; i < 20; i++) {
      const r = await swarmDeliveryTick("slow|S1E1", current, TARGET, h.deps);
      current = r.currentHash;
      assert.equal(r.switched, false, `tick ${i}: must not switch a working download`);
      assert.equal(r.exhausted, false, `tick ${i}: must not give up on a working download`);
      if (r.narration.phase === "playing") sawPlaying = true;
    }
    assert.equal(h.started.length, 0, "never started an alternate for a working download");
    assert.equal(h.abandoned.length, 0, "never abandoned a working download");
    assert.ok(sawPlaying, "a progressing download narrates as playing");
    assert.equal(current, hash(1), "stays on the original source");
  }

  // ── Attempt cap is honored even if the pool were bottomless ────────────
  {
    resetSwarmWatch();
    const big = Array.from({ length: 12 }, (_, i) => release(i + 1, 20 - i));
    const h = harness("frozen");
    // Point rankedResults at the big pool.
    h.deps.rankedResults = async () => big;

    let current = hash(1);
    let exhausted = false;
    for (let i = 0; i < 80 && !exhausted; i++) {
      const r = await swarmDeliveryTick("cap|S1E1", current, TARGET, h.deps);
      current = r.currentHash;
      exhausted = r.exhausted;
    }
    assert.ok(exhausted, "reaches terminal state despite a bottomless pool");
    // Opened on #1, then at most (cap - 1) switches before the cap stops us.
    assert.ok(
      h.started.length <= MAX_FAILOVER_ATTEMPTS - 1,
      `bounded by the attempt cap (${h.started.length} switches)`,
    );
  }

  // ── A playability failure moves off a HEALTHY swarm (forced switch) ────
  {
    resetSwarmWatch();
    const h = harness("progress"); // bytes flow fine — the swarm is not the problem
    // The byte rule would say "progressing" and never switch. But the browser
    // cannot decode this release, so the caller forces a playability failover.
    const r = await swarmDeliveryTick("play|S1E1", hash(1), TARGET, h.deps, {
      force: true,
      cause: "playability",
    });
    assert.equal(r.switched, true, "a forced playability failure switches despite healthy delivery");
    assert.equal(r.currentHash, hash(2), "moved to the next release, not the undecodable one");
    assert.equal(r.narration.phase, "switching");
    if (r.narration.phase === "switching") {
      assert.equal(r.narration.cause, "playability", "the switch reports a playability cause, not delivery");
    }
    assert.deepEqual(h.started, [hash(2)], "started the alternate release");
    assert.deepEqual(h.abandoned, [hash(1)], "abandoned (paused) the undecodable one, kept its bytes");
  }

  console.log("swarm-delivery-watchdog.test.ts: PASS");
}

run().catch((err) => {
  console.error("swarm-delivery-watchdog.test.ts: FAIL");
  console.error(err);
  process.exit(1);
});
