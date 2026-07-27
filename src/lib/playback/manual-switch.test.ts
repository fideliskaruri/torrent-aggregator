/**
 * Manual-switch tests: a viewer picking a release from the quality selector.
 *
 * Four guarantees the human-driven path must keep, all through the same engine
 * swap seam the automatic failover uses:
 *   - the chosen source is started and the old one paused (never deleted);
 *   - playback position is carried across, before the old source is touched;
 *   - a deliberate pick is PINNED: a later stall narrates but never auto-swaps
 *     it away — the most important assertion, because arguing with a choice the
 *     user just made is the worst thing this feature could do;
 *   - a pick that is not a real candidate, or that fails to start, is rejected
 *     honestly rather than fabricated.
 */
import assert from "node:assert/strict";

import {
  manualSwitchTo,
  swarmDeliveryTick,
  resetSwarmWatch,
  type ManualSwitchDeps,
  type SwarmWatchDeps,
} from "./swarm-delivery-watchdog";
import type { TransferSample } from "./stall";
import type { TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";

const MB = 1024 * 1024;
const KEY = "the-bear::s1e1";
const TARGET: PreRankTarget = { title: "The Bear", mediaType: "tv", season: 1, episode: 1 };

function hash(n: number): string {
  return String(n).padStart(40, "0");
}
function rel(n: number, title: string, seeders: number): TorrentResult {
  return {
    id: `r${n}`,
    title,
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

const POOL: TorrentResult[] = [
  rel(1, "The Bear S01E01 1080p WEB-DL", 28),
  rel(2, "The Bear S01E01 720p WEB-DL", 4),
];

/** Records the order of side effects so we can assert carry-before-abandon. */
interface Recorder {
  calls: string[];
  started: string[];
  abandoned: string[];
}

function manualDeps(
  rec: Recorder,
  opts: { startOk?: boolean; positionSec?: number | null } = {},
): ManualSwitchDeps {
  return {
    async rankedResults() {
      return POOL;
    },
    async startRelease(candidate) {
      rec.calls.push("start");
      rec.started.push(candidate.infoHash);
      return opts.startOk ?? true;
    },
    async abandon(infoHash) {
      rec.calls.push("abandon");
      rec.abandoned.push(infoHash);
    },
    async carryPosition() {
      rec.calls.push("carry");
      return opts.positionSec ?? null;
    },
  };
}

async function run() {
  // ── A manual pick starts the chosen source, pauses the old, carries position ─
  {
    resetSwarmWatch();
    const rec: Recorder = { calls: [], started: [], abandoned: [] };
    const deps = manualDeps(rec, { positionSec: 2400 });

    const out = await manualSwitchTo(KEY, hash(1), hash(2), TARGET, deps);

    assert.equal(out.ok, true, "a real candidate pick succeeds");
    if (!out.ok) throw new Error("unreachable");
    assert.equal(out.infoHash, hash(2), "the player is pointed at the chosen source");
    assert.equal(out.positionSec, 2400, "position is carried, so 40 min in resumes at 40 min");
    assert.deepEqual(rec.started, [hash(2)], "the chosen release was started");
    assert.deepEqual(rec.abandoned, [hash(1)], "the old source was paused (abandoned), not the new one");
    // Ordering: start the new source first (never strand with nothing running),
    // then carry the position, then pause the old — the read cannot race the pause.
    assert.deepEqual(
      rec.calls,
      ["start", "carry", "abandon"],
      "position is carried BEFORE the old source is abandoned",
    );
  }

  // ── A pinned pick is NOT auto-swapped when it later stalls (the key rule) ──
  {
    resetSwarmWatch();
    const rec: Recorder = { calls: [], started: [], abandoned: [] };
    await manualSwitchTo(KEY, hash(1), hash(2), TARGET, manualDeps(rec, { positionSec: 100 }));

    // hash(2) is now the pinned, playing source. Feed it a stalled series: two
    // samples 31s apart, both actively downloading, delivering nothing.
    const swarmRec: Recorder = { calls: [], started: [], abandoned: [] };
    const queue: TransferSample[] = [
      { atMs: 0, downloadedBytes: 11_000_000, progress: 0.0077, state: "downloading" },
      { atMs: 31_000, downloadedBytes: 11_000_000, progress: 0.0077, state: "downloading" },
    ];
    let i = 0;
    const swarmDeps: SwarmWatchDeps = {
      async sample() {
        return queue[Math.min(i++, queue.length - 1)];
      },
      async rankedResults() {
        return POOL;
      },
      async startRelease(candidate) {
        swarmRec.started.push(candidate.infoHash);
        return true;
      },
      async abandon(infoHash) {
        swarmRec.abandoned.push(infoHash);
      },
    };

    await swarmDeliveryTick(KEY, hash(2), TARGET, swarmDeps); // seeds first sample
    const tick = await swarmDeliveryTick(KEY, hash(2), TARGET, swarmDeps); // now stalled

    assert.equal(tick.verdict.stalled, true, "the pinned source is genuinely detected as stalled");
    assert.equal(
      tick.narration.phase,
      "stalled-held",
      "a pinned stall is narrated as held, so the UI can offer another quality",
    );
    assert.equal(tick.switched, false, "the watchdog did NOT swap the pinned source away");
    assert.deepEqual(swarmRec.started, [], "no new release was started behind the user's back");
    assert.deepEqual(swarmRec.abandoned, [], "the pinned source was not abandoned");
  }

  // ── A pick that is not a real candidate is rejected, not fabricated ────────
  {
    resetSwarmWatch();
    const rec: Recorder = { calls: [], started: [], abandoned: [] };
    const out = await manualSwitchTo(KEY, hash(1), hash(999), TARGET, manualDeps(rec));
    assert.equal(out.ok, false, "an unknown infoHash cannot be switched to");
    if (out.ok) throw new Error("unreachable");
    assert.equal(out.reason, "not-a-candidate");
    assert.deepEqual(rec.calls, [], "nothing is started or abandoned for a bogus pick");
  }

  // ── A chosen release that fails to start is reported, old source untouched ─
  {
    resetSwarmWatch();
    const rec: Recorder = { calls: [], started: [], abandoned: [] };
    const out = await manualSwitchTo(KEY, hash(1), hash(2), TARGET, manualDeps(rec, { startOk: false }));
    assert.equal(out.ok, false, "a release that will not start is a rejection");
    if (out.ok) throw new Error("unreachable");
    assert.equal(out.reason, "start-failed");
    assert.deepEqual(rec.abandoned, [], "the old source is kept when the new one will not start");
  }

  // ── Re-picking the source already playing re-pins without a restart ────────
  {
    resetSwarmWatch();
    const rec: Recorder = { calls: [], started: [], abandoned: [] };
    const out = await manualSwitchTo(KEY, hash(1), hash(1), TARGET, manualDeps(rec, { positionSec: 500 }));
    assert.equal(out.ok, true, "re-pinning the current source is a valid no-op switch");
    if (!out.ok) throw new Error("unreachable");
    assert.equal(out.infoHash, hash(1));
    assert.equal(out.positionSec, null, "no carry needed — the source did not change");
    assert.deepEqual(rec.calls, [], "nothing is started or abandoned when the source is unchanged");
  }

  console.log("manual-switch.test.ts: PASS");
}

run().catch((err) => {
  console.error("manual-switch.test.ts: FAIL");
  console.error(err);
  process.exit(1);
});
