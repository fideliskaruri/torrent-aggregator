import assert from "node:assert/strict";

import { resetWatchdog, watchdogTick, type WatchdogDeps } from "./watchdog";
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
  deps: WatchdogDeps;
  started: string[];
  abandoned: string[];
  events: string[];
}

/** Fake engine. `mode: "frozen"` never delivers; `mode: "progress"` always does. */
function harness(mode: "frozen" | "progress"): Harness {
  let now = 1_000_000;
  let progressed = 0;
  const started: string[] = [];
  const abandoned: string[] = [];
  const events: string[] = [];
  const deps: WatchdogDeps = {
    async sample() {
      now += 10_000; // 10s per poll
      if (mode === "progress") {
        progressed += 1_200_000; // ~120 KB/s — slow but real
        return { atMs: now, downloadedBytes: progressed, progress: progressed / (1000 * MB), state: "downloading" };
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
    resetWatchdog();
    const h = harness("frozen");
    let current = hash(1);
    let exhausted = false;
    let switches = 0;
    for (let i = 0; i < 60 && !exhausted; i++) {
      const r = await watchdogTick(KEY, current, TARGET, h.deps);
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

  // ── A slow-but-progressing swarm is never abandoned ───────────────────
  {
    resetWatchdog();
    const h = harness("progress");
    let current = hash(1);
    let sawPlaying = false;
    for (let i = 0; i < 20; i++) {
      const r = await watchdogTick("slow|S1E1", current, TARGET, h.deps);
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
    resetWatchdog();
    const big = Array.from({ length: 12 }, (_, i) => release(i + 1, 20 - i));
    const h = harness("frozen");
    // Point rankedResults at the big pool.
    h.deps.rankedResults = async () => big;

    let current = hash(1);
    let exhausted = false;
    for (let i = 0; i < 80 && !exhausted; i++) {
      const r = await watchdogTick("cap|S1E1", current, TARGET, h.deps);
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

  console.log("watchdog.test.ts: PASS");
}

run().catch((err) => {
  console.error("watchdog.test.ts: FAIL");
  console.error(err);
  process.exit(1);
});
