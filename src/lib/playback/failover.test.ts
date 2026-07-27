import assert from "node:assert/strict";

import {
  chooseNextRelease,
  commitSource,
  createFailoverSession,
  failOver,
  MAX_FAILOVER_ATTEMPTS,
} from "./failover";
import type { TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";

const TARGET: PreRankTarget = { title: "The Bear", mediaType: "tv" };

function hash(n: number): string {
  return String(n).padStart(40, "0");
}

/** A ranked release. Order in the array is the ranker's order (authoritative). */
function release(n: number, seeders: number): TorrentResult {
  return {
    id: `r${n}`,
    title: `The Bear S01E01 release ${n}`,
    magnet: `magnet:?xt=urn:btih:${hash(n)}`,
    infoHash: hash(n),
    sizeBytes: 1_000_000,
    seeders,
    leechers: 0,
    source: "apibay",
    sourceUrl: "https://example.test",
    tags: [],
  };
}

// The observed pool: 28/3/4/1 seeders, already ranked best-first.
const POOL = [release(1, 28), release(2, 3), release(3, 4), release(4, 1)];

function run() {
  // ── chooseNextRelease excludes already-tried sources ──────────────────
  {
    const first = chooseNextRelease(POOL, TARGET, []);
    assert.ok(first, "picks a candidate from a fresh pool");
    assert.equal(first!.infoHash, hash(1), "picks the ranker's top first");

    const second = chooseNextRelease(POOL, TARGET, [hash(1)]);
    assert.equal(second!.infoHash, hash(2), "excludes the tried top, picks next in rank order");

    const third = chooseNextRelease(POOL, TARGET, [hash(1), hash(2)]);
    assert.equal(third!.infoHash, hash(3), "keeps the ranker's order among the untried");

    const none = chooseNextRelease(POOL, TARGET, POOL.map((r) => r.infoHash!));
    assert.equal(none, null, "returns null when every source is tried");
  }

  // ── A source is never retried twice across a sequence of stalls ────────
  {
    let session = createFailoverSession("the-bear|S1E1");
    session = commitSource(session, hash(1)); // opened on the top pick

    const picked: string[] = [hash(1)];
    for (let i = 0; i < 6; i++) {
      const step = failOver(session, POOL, TARGET);
      if (step.kind === "exhausted") break;
      picked.push(step.candidate.infoHash);
      session = step.session;
    }

    assert.deepEqual(
      picked,
      [hash(1), hash(2), hash(3), hash(4)],
      "every distinct source used at most once, in rank order",
    );
    assert.equal(new Set(picked).size, picked.length, "no source retried twice");
  }

  // ── The attempt cap is reached and reported as terminal ───────────────
  {
    let session = createFailoverSession("the-bear|S1E1");
    // Commit the cap's worth of distinct sources.
    for (let i = 1; i <= MAX_FAILOVER_ATTEMPTS; i++) {
      session = commitSource(session, hash(i));
    }
    assert.equal(session.tried.length, MAX_FAILOVER_ATTEMPTS);

    const step = failOver(session, POOL, TARGET);
    assert.equal(step.kind, "exhausted", "cap reached → terminal, not another switch");
    assert.equal(step.narration.phase, "exhausted");
    assert.equal(step.session.status, "exhausted");
    if (step.narration.phase === "exhausted") {
      assert.equal(step.narration.triedCount, MAX_FAILOVER_ATTEMPTS, "reports how many were tried");
    }
  }

  // ── Exhausted when the pool has no untried candidate, even below cap ───
  {
    let session = createFailoverSession("thin|S1E1");
    const thin = [release(1, 28), release(2, 3)];
    session = commitSource(session, hash(1));
    const a = failOver(session, thin, TARGET);
    assert.equal(a.kind, "switch");
    if (a.kind === "switch") {
      session = a.session;
      assert.equal(a.candidate.infoHash, hash(2));
    }
    const b = failOver(session, thin, TARGET);
    assert.equal(b.kind, "exhausted", "no untried candidate left → terminal below the cap");
    if (b.narration.phase === "exhausted") {
      assert.equal(b.narration.triedCount, 2);
    }
  }

  // ── A switch carries a structured narration with the next release name ─
  {
    let session = createFailoverSession("the-bear|S1E1");
    session = commitSource(session, hash(1));
    const step = failOver(session, POOL, TARGET);
    assert.equal(step.kind, "switch");
    if (step.kind === "switch" && step.narration.phase === "switching") {
      assert.equal(step.narration.triedCount, 1, "one source tried so far");
      assert.equal(step.narration.nextName, "The Bear S01E01 release 2");
    }
  }

  // ── Releases without a usable infoHash are never selected ─────────────
  {
    const unkeyable: TorrentResult = { ...release(9, 50), infoHash: undefined, magnet: undefined };
    const pool = [unkeyable, release(2, 3)];
    const step = chooseNextRelease(pool, TARGET, []);
    assert.equal(step!.infoHash, hash(2), "skips the higher-seeded but unkeyable release");
  }

  console.log("failover.test.ts: PASS");
}

try {
  run();
} catch (err) {
  console.error("failover.test.ts: FAIL");
  console.error(err);
  process.exit(1);
}
