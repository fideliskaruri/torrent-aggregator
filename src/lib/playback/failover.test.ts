import assert from "node:assert/strict";

import {
  chooseNextRelease,
  commitSource,
  createFailoverSession,
  failOver,
} from "./failover";
import type { SwarmVerdict } from "./candidates";
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

  // ── Pool size is not an attempt cap ───────────────────────────────────
  {
    const twelve = Array.from({ length: 12 }, (_, index) =>
      release(index + 1, 20 - index),
    );
    let session = createFailoverSession("twelve|S1E1");
    const attempted: string[] = [];
    while (true) {
      const step = failOver(session, twelve, TARGET);
      if (step.kind === "exhausted") {
        assert.equal(step.narration.phase, "exhausted");
        assert.equal(step.session.tried.length, 12);
        break;
      }
      attempted.push(step.candidate.infoHash);
      session = step.session;
    }
    assert.equal(attempted.length, 12);
    assert.equal(new Set(attempted).size, 12);
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
      assert.equal(step.narration.cause, "delivery", "a stall-driven switch carries a delivery cause");
      assert.equal(step.narration.outcome.kind, "switch-source", "a switch tells the UI exactly what source to offer");
      if (step.narration.outcome.kind === "switch-source") {
        assert.equal(step.narration.outcome.selected.infoHash, hash(2));
        assert.equal(step.narration.outcome.remainingCount, 2, "UI can show the remaining alternatives count");
      }
    }
  }

  // ── A no-seeder terminal state stays distinct from "we tried good-looking sources" ─
  {
    let session = createFailoverSession("dead|S1E1");
    const noSeeders = [release(1, 0), release(2, 0)];
    session = commitSource(session, hash(1));
    session = commitSource(session, hash(2));
    const step = failOver(session, noSeeders, TARGET);
    assert.equal(step.kind, "exhausted");
    if (step.narration.phase === "exhausted" && step.narration.outcome.kind === "none-available") {
      assert.equal(step.narration.outcome.reason, "no-seeders", "no seeders is an actionable terminal reason");
      assert.equal(step.narration.outcome.seededCandidateCount, 0);
    }
  }

  // ── The failure cause is threaded into the narration a caller passes ──
  {
    let session = createFailoverSession("the-bear|S1E1|play");
    session = commitSource(session, hash(1));
    const step = failOver(session, POOL, TARGET, "playability");
    assert.equal(step.kind, "switch");
    if (step.kind === "switch" && step.narration.phase === "switching") {
      assert.equal(
        step.narration.cause,
        "playability",
        "a playability-driven switch reports playability, so the UI writes the right sentence",
      );
    }
  }

  // ── Releases without a usable infoHash are never selected ─────────────
  {
    const unkeyable: TorrentResult = { ...release(9, 50), infoHash: undefined, magnet: undefined };
    const pool = [unkeyable, release(2, 3)];
    const step = chooseNextRelease(pool, TARGET, []);
    assert.equal(step!.infoHash, hash(2), "skips the higher-seeded but unkeyable release");
  }

  // ── The cached swarm verdict is consulted, not just the ranker ─────────
  // Regression for the recurring "truth computed then not consulted" defect:
  // the verdict is authoritative and cached, so failover must not re-select a
  // release the probe already measured dead when a live one is available.
  {
    // Top-ranked release (hash 1) is measured dead → skip it for a live one.
    const deadTop = new Map<string, SwarmVerdict>([[hash(1), "dead"]]);
    const picked = chooseNextRelease(POOL, TARGET, [], deadTop);
    assert.ok(picked, "still finds a candidate when the top one is dead");
    assert.equal(picked!.infoHash, hash(2), "skips the top-ranked release the probe measured dead");

    // `unknown` is not `dead`: an unmeasured top release is chosen normally.
    const unknownTop = new Map<string, SwarmVerdict>([[hash(1), "unknown"]]);
    assert.equal(
      chooseNextRelease(POOL, TARGET, [], unknownTop)!.infoHash,
      hash(1),
      "an unmeasured release is offered normally — unknown is not dead",
    );

    // A `good`/`weak` verdict never demotes a release either.
    const goodTop = new Map<string, SwarmVerdict>([[hash(1), "good"]]);
    assert.equal(
      chooseNextRelease(POOL, TARGET, [], goodTop)!.infoHash,
      hash(1),
      "a measured-good release keeps its rank",
    );

    // Deprioritize, never hide: every untried release dead → still try one.
    const allDead = new Map<string, SwarmVerdict>(
      POOL.map((r) => [r.infoHash!, "dead" as SwarmVerdict]),
    );
    const lastResort = chooseNextRelease(POOL, TARGET, [], allDead);
    assert.ok(lastResort, "when every candidate is measured dead, still try one rather than give up");
    assert.equal(lastResort!.infoHash, hash(1), "falls back to the ranker's top as a last resort");

    // No verdict map → behaviour identical to before measurement existed.
    assert.equal(
      chooseNextRelease(POOL, TARGET, [])!.infoHash,
      hash(1),
      "absent verdicts, selection is exactly rank order",
    );

    // failOver threads the verdict map through to selection.
    let session = createFailoverSession("the-bear|S1E1|verdict");
    session = commitSource(session, hash(1)); // opened on the top pick
    const deadNext = new Map<string, SwarmVerdict>([[hash(2), "dead"]]);
    const step = failOver(session, POOL, TARGET, "delivery", deadNext);
    assert.equal(step.kind, "switch");
    if (step.kind === "switch") {
      assert.equal(
        step.candidate.infoHash,
        hash(3),
        "failOver skips the measured-dead next release and picks the next live one",
      );
    }
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
