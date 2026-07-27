/**
 * Swarm-probe tests.
 *
 * WHAT THESE ARE GUARDING
 * -----------------------
 * 1. **The verdict rule is the whole point, so it is table-driven.** The
 *    boundary that matters most is *exactly* 1.5x headroom: that is `good`, not
 *    `weak`, because the bitrate harness draws the line there for the same
 *    reason (a stream at 1.0x never recovers from a hiccup). One row in the
 *    table pins that boundary.
 *
 * 2. **`unknown` never collapses into `dead`.** A probe that reached no peer
 *    knows nothing; calling that `dead` would hide a release the user could
 *    have watched. Several rows assert absence-of-evidence stays `unknown`.
 *
 * 3. **An expired row reads `unknown`, not its last verdict.** Swarms revive;
 *    a stale `dead` must not become a permanent blacklist.
 *
 * 4. **A live download is never probed or destroyed.** Getting this wrong would
 *    delete a user's torrent. The probe must read the live figures and touch
 *    nothing — asserted with spies on `add` and `destroy`.
 *
 * 5. **Selection demotes, never filters.** A measured `good` beats an advertised
 *    claim; a measured `dead` is pushed to the back but is still reachable when
 *    it is the only release — the same invariant `quality.ts` holds.
 *
 * Run: node node_modules/tsx/dist/cli.mjs src/lib/torrents/swarm-probe.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import type { TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { orderByVerdict, selectBestRelease } from "@/lib/prewarm/prerank";
import {
  classifySwarm,
  DEFAULT_REQUIRED_MBPS,
  getSwarmMeasurement,
  MIN_HEADROOM,
  probeSwarm,
  recordSwarmMeasurement,
  requiredBitrateBps,
  type ProbeClient,
  type ProbeTorrentHandle,
  type SwarmVerdict,
} from "./swarm-probe";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

function sha1(): string {
  return createHash("sha1").update(randomUUID()).digest("hex");
}

// ---------------------------------------------------------------------------
// A fake WebTorrent handle whose events the test drives, and which records
// every teardown call so the leak discipline can be asserted.
// ---------------------------------------------------------------------------
interface FakeTorrent extends ProbeTorrentHandle {
  emit(ev: string, ...args: unknown[]): void;
  destroyCalls: number;
  lastDestroyStore: boolean | undefined;
  removedListeners: string[];
}

function fakeTorrent(over: Partial<ProbeTorrentHandle> = {}): FakeTorrent {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  const t: FakeTorrent = {
    infoHash: over.infoHash,
    length: over.length,
    numPeers: over.numPeers,
    downloadSpeed: over.downloadSpeed,
    downloaded: over.downloaded,
    received: over.received,
    wires: over.wires,
    destroyCalls: 0,
    lastDestroyStore: undefined,
    removedListeners: [],
    on(ev, fn) {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
    },
    removeListener(ev) {
      t.removedListeners.push(ev);
    },
    destroy(opts) {
      t.destroyCalls += 1;
      t.lastDestroyStore = opts?.destroyStore;
    },
    emit(ev, ...args) {
      for (const fn of handlers.get(ev) ?? []) fn(...args);
    },
  };
  return t;
}

function fakeWire(): { downloaded: number; emit(ev: string): void; on(ev: string, fn: () => void): void } {
  const handlers = new Map<string, Array<() => void>>();
  return {
    downloaded: 0,
    on(ev, fn) {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
    },
    emit(ev) {
      for (const fn of handlers.get(ev) ?? []) fn();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function result(over: Partial<TorrentResult> & { title: string }): TorrentResult {
  const hash = over.infoHash ?? sha1();
  return {
    id: randomUUID(),
    magnet: `magnet:?xt=urn:btih:${hash}`,
    infoHash: hash,
    sizeBytes: 1_400_000_000,
    seeders: 40,
    leechers: 3,
    source: "apibay",
    sourceUrl: "https://example.invalid",
    tags: [],
    ...over,
  } as TorrentResult;
}

async function main(): Promise<void> {
  console.log("swarm probe\n");

  // The probe's internal timer is `.unref()`d so a probe can never hold a
  // server process open. In this test that means the event loop would drain and
  // Node would exit before the probe's window elapses; a ref'd keepalive holds
  // the loop open until every awaited probe resolves.
  const keepAlive = setInterval(() => {}, 60_000);

  const writtenHashes: string[] = [];

  try {
    // ── Required bitrate ────────────────────────────────────────────────
    check("required bitrate derives from size ÷ duration when both are known", () => {
      // 1,400,000,000 bytes over 2000 s = 700,000 bytes/sec.
      assert.equal(
        requiredBitrateBps({ sizeBytes: 1_400_000_000, durationSec: 2000 }),
        700_000,
      );
    });

    check("required bitrate falls back to the named default when duration is unknown", () => {
      const expected = (DEFAULT_REQUIRED_MBPS * 1_000_000) / 8;
      assert.equal(requiredBitrateBps({ sizeBytes: 1_400_000_000 }), expected);
      assert.equal(requiredBitrateBps({}), expected);
      assert.equal(requiredBitrateBps({ sizeBytes: 0, durationSec: 0 }), expected);
    });

    // ── The verdict rule, table-driven ──────────────────────────────────
    const REQ = 1_000_000; // bytes/sec
    const good = REQ * MIN_HEADROOM; // exactly 1.5x
    interface Row {
      name: string;
      reachedSwarm: boolean;
      peersConnected: number;
      bytesReceived: number;
      effectiveBps: number;
      expect: SwarmVerdict;
    }
    const table: Row[] = [
      {
        name: "never reached the swarm → unknown",
        reachedSwarm: false,
        peersConnected: 0,
        bytesReceived: 0,
        effectiveBps: 0,
        expect: "unknown",
      },
      {
        name: "reached but nobody connected → unknown (not dead)",
        reachedSwarm: true,
        peersConnected: 0,
        bytesReceived: 0,
        effectiveBps: 0,
        expect: "unknown",
      },
      {
        name: "peers connected, delivered nothing → dead",
        reachedSwarm: true,
        peersConnected: 6,
        bytesReceived: 0,
        effectiveBps: 0,
        expect: "dead",
      },
      {
        name: "exactly 1.5x headroom → good (the boundary)",
        reachedSwarm: true,
        peersConnected: 6,
        bytesReceived: 5_000_000,
        effectiveBps: good,
        expect: "good",
      },
      {
        name: "a hair below 1.5x → weak",
        reachedSwarm: true,
        peersConnected: 6,
        bytesReceived: 5_000_000,
        effectiveBps: good - 1,
        expect: "weak",
      },
      {
        name: "delivering exactly 1.0x → weak (refills as fast as it drains)",
        reachedSwarm: true,
        peersConnected: 6,
        bytesReceived: 5_000_000,
        effectiveBps: REQ,
        expect: "weak",
      },
      {
        name: "well above 1.5x → good",
        reachedSwarm: true,
        peersConnected: 12,
        bytesReceived: 50_000_000,
        effectiveBps: REQ * 10,
        expect: "good",
      },
    ];
    for (const row of table) {
      check(`classify: ${row.name}`, () => {
        assert.equal(
          classifySwarm({
            reachedSwarm: row.reachedSwarm,
            peersConnected: row.peersConnected,
            bytesReceived: row.bytesReceived,
            effectiveBps: row.effectiveBps,
            requiredBps: REQ,
          }),
          row.expect,
        );
      });
    }

    check("unknown is never reachable via the dead branch", () => {
      // Bytes are zero here, which is the dead precondition — but with no peer
      // connected it must stay unknown. This is the load-bearing distinction.
      for (const reached of [false, true]) {
        assert.equal(
          classifySwarm({
            reachedSwarm: reached,
            peersConnected: 0,
            bytesReceived: 0,
            effectiveBps: 0,
            requiredBps: REQ,
          }),
          "unknown",
        );
      }
    });

    // ── The probe: teardown discipline on a fresh probe ─────────────────
    await checkAsync("a fresh probe tears down everything it created", async () => {
      const hash = sha1();
      const t = fakeTorrent({ numPeers: 8 });
      let addCalls = 0;
      const client: ProbeClient = { add: () => t, torrents: [] };

      // Deterministic clock: startedAt=0, elapsed reads 1000ms, measuredAt=1000.
      const nowSeq = [0, 1000, 1000, 1000];
      let i = 0;
      const now = () => nowSeq[Math.min(i++, nowSeq.length - 1)];

      const p = probeSwarm(
        { infoHash: hash },
        {
          getClient: async () => client,
          addTorrent: () => {
            addCalls += 1;
            return t;
          },
          findLive: () => null,
          now,
          windowMs: 40,
        },
      );

      await tick(); // let the promise executor register listeners
      const wire = fakeWire();
      t.emit("wire", wire);
      wire.emit("download"); // this peer actually sent a byte
      t.emit("download", 3_000_000); // 3 MB over 1s = 3 MB/s

      const m = await p;

      assert.equal(addCalls, 1, "the probe adds exactly one torrent");
      assert.equal(t.destroyCalls, 1, "the probe destroys the torrent it added");
      assert.equal(
        t.lastDestroyStore,
        true,
        "destroyStore:true so the throwaway partial data is deleted",
      );
      assert.ok(
        t.removedListeners.includes("download") &&
          t.removedListeners.includes("wire") &&
          t.removedListeners.includes("error"),
        "every listener the probe added is removed",
      );
      assert.equal(m.fromLiveDownload, false);
      assert.equal(m.peersConnected, 8);
      assert.equal(m.peersUnchoked, 1, "only the peer that sent a byte counts");
      assert.equal(m.bytesReceived, 3_000_000);
      assert.equal(m.effectiveBps, 3_000_000, "3 MB over the 1s elapsed window");
      assert.equal(m.verdict, "good");
    });

    // ── The guard: a live download is never probed or destroyed ─────────
    await checkAsync("a live download is read, never added or destroyed", async () => {
      const hash = sha1();
      const wire = { downloaded: 500 };
      const live = fakeTorrent({
        numPeers: 20,
        downloaded: 900_000_000,
        downloadSpeed: 5_000_000,
        wires: [wire, { downloaded: 0 }],
      });
      let addCalls = 0;

      const m = await probeSwarm(
        { infoHash: hash },
        {
          getClient: async () => ({ add: () => fakeTorrent(), torrents: [] }),
          addTorrent: () => {
            addCalls += 1;
            return fakeTorrent();
          },
          findLive: () => live,
          windowMs: 40,
        },
      );

      assert.equal(addCalls, 0, "a live download must never be re-added");
      assert.equal(live.destroyCalls, 0, "a live download must never be destroyed");
      assert.equal(m.fromLiveDownload, true);
      assert.equal(m.peersConnected, 20);
      assert.equal(m.peersUnchoked, 1, "only the wire that received bytes counts");
      assert.equal(m.bytesReceived, 900_000_000);
      assert.equal(m.effectiveBps, 5_000_000);
    });

    await checkAsync("a live-download reading is never persisted", async () => {
      const hash = sha1();
      writtenHashes.push(hash);
      const live = fakeTorrent({ numPeers: 5, downloaded: 1, downloadSpeed: 9_000_000 });
      const m = await probeSwarm(
        { infoHash: hash },
        { findLive: () => live, windowMs: 10 },
      );
      await recordSwarmMeasurement(m, { db: prisma });
      const stored = await getSwarmMeasurement(hash, { db: prisma });
      assert.equal(stored, null, "a momentary live snapshot must not be cached as a probe");
    });

    // ── The guard fails CLOSED ──────────────────────────────────────────
    // A failure to *determine* liveness must never be read as *determined
    // absent* — because a fresh probe ends in destroyStore, and re-adding a
    // held magnet reuses the user's real download path. So a throwing check
    // yields `unknown` and NOTHING is added or destroyed.
    await checkAsync("a liveness check that throws yields unknown, adds nothing", async () => {
      const hash = sha1();
      const wouldBeAdded = fakeTorrent();
      let addCalls = 0;
      const m = await probeSwarm(
        { infoHash: hash },
        {
          findLive: () => {
            throw new Error("engine unreachable — liveness cannot be determined");
          },
          getClient: async () => ({ add: () => wouldBeAdded, torrents: [] }),
          addTorrent: () => {
            addCalls += 1;
            return wouldBeAdded;
          },
          windowMs: 40,
        },
      );

      assert.equal(m.verdict, "unknown", "could-not-determine is unknown, never dead");
      assert.equal(m.fromLiveDownload, false);
      assert.equal(addCalls, 0, "a probe must not run when liveness is unknown");
      assert.equal(
        wouldBeAdded.destroyCalls,
        0,
        "nothing was created, so nothing — least of all a user file — is destroyed",
      );
    });

    await checkAsync("a live torrent is found even when the input hash is uppercase", async () => {
      const lower = sha1();
      const upper = lower.toUpperCase();
      const live = fakeTorrent({ numPeers: 7, downloaded: 5, downloadSpeed: 6_000_000 });
      let addCalls = 0;
      // The engine keys on lowercase-hex. The probe must normalise before the
      // guard, or a live torrent looks absent — the same failure as failing open.
      const m = await probeSwarm(
        { infoHash: upper },
        {
          findLive: (h) => (h === lower ? live : null),
          addTorrent: () => {
            addCalls += 1;
            return fakeTorrent();
          },
          windowMs: 40,
        },
      );

      assert.equal(m.fromLiveDownload, true, "the uppercase input still matched the live torrent");
      assert.equal(addCalls, 0, "a matched live download is never re-added");
      assert.equal(live.destroyCalls, 0, "a matched live download is never destroyed");
    });

    // ── Storage + expiry ────────────────────────────────────────────────
    await checkAsync("a stored verdict reads back, then reads unknown once expired", async () => {
      const hash = sha1();
      writtenHashes.push(hash);
      const base = Date.now();
      await recordSwarmMeasurement(
        {
          infoHash: hash,
          peersConnected: 10,
          peersUnchoked: 4,
          bytesReceived: 20_000_000,
          elapsedMs: 8000,
          effectiveBps: 5_000_000,
          requiredBps: 1_000_000,
          verdict: "good",
          measuredAt: base,
          fromLiveDownload: false,
        },
        { db: prisma, ttlMs: 1000, now: base },
      );

      const fresh = await getSwarmMeasurement(hash, { db: prisma, now: base });
      assert.ok(fresh);
      assert.equal(fresh.verdict, "good", "within TTL the measured verdict stands");
      assert.equal(fresh.expired, false);

      const stale = await getSwarmMeasurement(hash, { db: prisma, now: base + 2000 });
      assert.ok(stale, "the row still exists");
      assert.equal(
        stale.verdict,
        "unknown",
        "an expired verdict reads unknown, never its last value",
      );
      assert.equal(stale.expired, true);
      assert.notEqual(
        stale.verdict,
        "good",
        "a swarm that has decayed is not pinned to its old pass",
      );
    });

    // ── Selection: demote, never filter ─────────────────────────────────
    const target: PreRankTarget = { title: "Zzqx", mediaType: "movie" };

    check("orderByVerdict promotes good, demotes dead, keeps unknown neutral", () => {
      const a = result({ title: "A" });
      const b = result({ title: "B" });
      const c = result({ title: "C" });
      const v = new Map<string, SwarmVerdict>([
        [a.infoHash!, "dead"],
        [b.infoHash!, "unknown"],
        [c.infoHash!, "good"],
      ]);
      const ordered = orderByVerdict([a, b, c], (r) => v.get(r.infoHash!) ?? "unknown");
      assert.deepEqual(
        ordered.map((r) => r.title),
        ["C", "B", "A"],
        "good first, unknown (neutral) next, dead last",
      );
    });

    check("a measured good beats a release merely advertising more seeders", () => {
      // `claim` is first in rank order (more advertised seeders); `measured` is
      // second but has been probed good. The measurement must win.
      const claim = result({ title: "Claim 999 seeders", seeders: 999 });
      const measured = result({ title: "Measured good", seeders: 30 });
      const v = new Map<string, SwarmVerdict>([[measured.infoHash!, "good"]]);
      const pick = selectBestRelease([claim, measured], target, {
        verdictOf: (r) => v.get(r.infoHash!) ?? "unknown",
      });
      assert.equal(pick?.title, "Measured good");
    });

    check("a dead release is demoted behind an unknown one, but not removed", () => {
      const dead = result({ title: "Dead but top-ranked", seeders: 500 });
      const unknown = result({ title: "Unknown", seeders: 5 });
      const v = new Map<string, SwarmVerdict>([[dead.infoHash!, "dead"]]);
      const pick = selectBestRelease([dead, unknown], target, {
        verdictOf: (r) => v.get(r.infoHash!) ?? "unknown",
      });
      assert.equal(pick?.title, "Unknown", "dead is demoted below neutral");
    });

    check("a dead release that is the ONLY release is still returned", () => {
      const dead = result({ title: "Only option, measured dead", seeders: 500 });
      const v = new Map<string, SwarmVerdict>([[dead.infoHash!, "dead"]]);
      const pick = selectBestRelease([dead], target, {
        verdictOf: (r) => v.get(r.infoHash!) ?? "unknown",
      });
      assert.equal(
        pick?.title,
        "Only option, measured dead",
        "demote never filters: the alternative is offering the user nothing",
      );
    });

    check("with no verdicts supplied the ranker order is untouched", () => {
      const a = result({ title: "A" });
      const b = result({ title: "B" });
      assert.equal(selectBestRelease([a, b], target)?.title, "A");
      assert.equal(selectBestRelease([b, a], target)?.title, "B");
    });
  } finally {
    clearInterval(keepAlive);
    if (writtenHashes.length) {
      await prisma.swarmMeasurement.deleteMany({
        where: { infoHash: { in: writtenHashes } },
      });
    }
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? "\nPASS — swarm probe measures, remembers, and demotes without filtering"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

void main();
