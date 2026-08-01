/**
 * Play-time failover: when a source stalls, move to the next-best release.
 *
 * WHY THIS EXISTS
 * ---------------
 * Even with perfect prediction, a swarm can die *after* we commit to it. The
 * observed failure had three other releases of the same episode sitting in
 * `SearchCache` (3, 4 and 1 seeders) and the app tried none of them — it
 * committed to one dead source and waited forever. The product thesis is "click
 * and start playing immediately", so a dead swarm must route to another
 * candidate, not to an infinite spinner.
 *
 * SINGLE SEAM
 * -----------
 * Candidate ranking is not re-implemented here. `searchTorrents` already ran
 * `rankResults`, and `selectBestRelease` (prerank.ts) is the one rule for
 * choosing among the ranked pool. This module only *excludes what we have
 * already tried* and then defers to that seam — so the fallback order is the
 * ranker's order, and a second ranking path can never drift from the first.
 *
 * GUARANTEES
 * ----------
 *  - **Never retry the same source.** Every committed infoHash is remembered
 *    and filtered out of future selections.
 *  - **Exhaustive attempts.** Every unique viable source is tried once. A pool
 *    size is data, never an attempt cap.
 */
import type { TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { releaseInfoHash, selectBestRelease } from "@/lib/prewarm/prerank";
import type { SwarmVerdict } from "./candidates";
import type {
  FailureCause,
  PlaybackActionOutcome,
  PlaybackNarration,
  PlaybackSourceOption,
} from "./narration";

/** A candidate resolved for a switch. */
export interface FailoverCandidate {
  release: TorrentResult;
  /** Canonical lowercase-hex infoHash. Non-null by construction (see below). */
  infoHash: string;
}

/**
 * The durable state of one content's failover attempts.
 *
 * `tried` is the ordered list of infoHashes we have committed to. `current` is
 * the one playing now. `status` becomes `exhausted` once we run out of untried
 * candidates.
 */
export interface FailoverSession {
  contentKey: string;
  tried: string[];
  current: string | null;
  status: "active" | "exhausted";
  /**
   * A source the user explicitly chose from the quality selector. This records
   * provenance for status/UI; it does not block automatic recovery.
   */
  pinnedHash: string | null;
}

export function createFailoverSession(contentKey: string): FailoverSession {
  return { contentKey, tried: [], current: null, status: "active", pinnedHash: null };
}

/**
 * Record that we have committed to a source. Idempotent per infoHash, so the
 * same source can never appear in `tried` twice and can never be retried.
 */
export function commitSource(
  session: FailoverSession,
  infoHash: string,
): FailoverSession {
  const hash = infoHash.toLowerCase();
  const tried = session.tried.includes(hash)
    ? session.tried
    : [...session.tried, hash];
  return { ...session, tried, current: hash };
}

/** Record a failed start without making that source current. */
export function recordAttempt(
  session: FailoverSession,
  infoHash: string,
): FailoverSession {
  const hash = infoHash.toLowerCase();
  return session.tried.includes(hash)
    ? session
    : { ...session, tried: [...session.tried, hash] };
}

/**
 * Commit to a source the user explicitly chose, and PIN it.
 *
 * The marker preserves the fact that the current choice was manual. If it later
 * fails, the watchdog still advances automatically; a manual preference is not
 * a command to remain stuck.
 */
export function pinSource(
  session: FailoverSession,
  infoHash: string,
): FailoverSession {
  const committed = commitSource(session, infoHash);
  return {
    ...committed,
    status: "active",
    pinnedHash: infoHash.toLowerCase(),
  };
}

/**
 * Prefer candidates the probe has **not** measured `dead`.
 *
 * WHY THIS EXISTS — the recurring defect this fixes
 * -------------------------------------------------
 * The swarm verdict (`good | weak | dead | unknown`) is authoritative truth the
 * measurement agent already computed, cached (6h TTL) and even shows in the
 * quality selector — yet the failover picker used to consult only the ranker and
 * never this verdict. So a stall could fail over straight onto a release the
 * probe had already watched deliver nothing, burning one of our few
 *     candidate budget on a known-dead swarm. That is exactly the
 * "truth computed, passed along, then not consulted at the decision" bug class.
 *
 * The rule is a *preference*, never a hiding filter:
 *   - `unknown` is not `dead` — an unmeasured release is offered normally
 *     (mirrors the invariant that runs through candidates.ts / availability.ts);
 *   - `dead` is only DEPRIORITIZED: if every untried candidate is measured dead
 *     we still return the pool unchanged so the ranker can pick one, because a
 *     6h-old `dead` measurement may be stale and trying a stale-dead swarm is
 *     still better than giving up while candidates remain;
 *   - absent a verdict map (no reader wired, or a read failed) the pool is
 *     returned untouched, so behaviour is identical to before measurement
 *     existed. A missing measurement can never make a release *less* selectable.
 *
 * Pure and unit-testable: a function over releases + a verdict map, no I/O.
 */
export function preferLiveCandidates(
  untried: readonly TorrentResult[],
  verdicts?: ReadonlyMap<string, SwarmVerdict> | null,
): readonly TorrentResult[] {
  if (!verdicts || verdicts.size === 0) return untried;
  const live = untried.filter((r) => {
    const hash = releaseInfoHash(r);
    // An unkeyable release has no measurement to consult; leave it in and let
    // selectBestRelease drop it, exactly as it does today.
    return hash === null || verdicts.get(hash) !== "dead";
  });
  // Deprioritize, never hide: fall back to the full pool if excluding dead ones
  // would leave nothing to try.
  return live.length > 0 ? live : untried;
}

/**
 * The next-best release we have **not** already tried, or `null` if none.
 *
 * Filters the already-tried infoHashes out of the ranked pool, then hands the
 * remainder to `selectBestRelease` — the single selection rule — so ordering
 * stays the ranker's. A release we cannot key by infoHash is unusable for
 * failover (we could never mark it tried), so it is dropped, exactly as
 * `selectBestRelease` already requires.
 */
export function chooseNextRelease(
  results: readonly TorrentResult[],
  target: PreRankTarget,
  triedHashes: readonly string[],
  verdicts?: ReadonlyMap<string, SwarmVerdict> | null,
): FailoverCandidate | null {
  const tried = new Set(triedHashes.map((h) => h.toLowerCase()));
  const untried = results.filter((r) => {
    const hash = releaseInfoHash(r);
    return hash !== null && !tried.has(hash);
  });

  // Consult the cached swarm verdict before the ranker: never spend a scarce
  // failover attempt on a release the probe already measured dead when a live
  // one is available. `unknown` is not `dead`; see preferLiveCandidates.
  const preferred = preferLiveCandidates(untried, verdicts);

  const release = selectBestRelease(preferred, target);
  if (!release) return null;

  const infoHash = releaseInfoHash(release);
  // `selectBestRelease` only returns releases that pass `releaseInfoHash`, so
  // this is non-null; the guard keeps the type honest without a cast.
  if (!infoHash) return null;

  return { release, infoHash };
}

export function sourceOptionFromRelease(
  release: TorrentResult,
  infoHash: string,
): PlaybackSourceOption {
  return {
    infoHash,
    title: release.title,
    seeders: Math.max(0, release.seeders ?? 0),
  };
}

export function listSourceOptions(
  results: readonly TorrentResult[],
  excludeHashes: readonly string[] = [],
): PlaybackSourceOption[] {
  const excluded = new Set(excludeHashes.map((h) => h.toLowerCase()));
  const seen = new Set<string>();
  const out: PlaybackSourceOption[] = [];
  for (const release of results) {
    const infoHash = releaseInfoHash(release);
    if (!infoHash || excluded.has(infoHash) || seen.has(infoHash)) continue;
    seen.add(infoHash);
    out.push(sourceOptionFromRelease(release, infoHash));
  }
  return out;
}

function exhaustedOutcome(
  results: readonly TorrentResult[],
  triedCount: number,
  cause: FailureCause,
): PlaybackActionOutcome {
  const candidates = listSourceOptions(results);
  const seededCandidateCount = candidates.filter((c) => c.seeders > 0).length;
  return {
    kind: "none-available",
    reason:
      cause === "playability"
        ? "no-playable-sources"
        : candidates.length > 0 && seededCandidateCount === 0
          ? "no-seeders"
          : "all-sources-failed",
    triedCount,
    totalCandidates: candidates.length,
    seededCandidateCount,
  };
}

/** The outcome of asking the session to fail over after a stall. */
export type FailoverStep =
  | {
      /** A next source was chosen; commit to it and start it. */
      kind: "switch";
      candidate: FailoverCandidate;
      session: FailoverSession;
      narration: PlaybackNarration;
    }
  | {
      /** No untried candidate remains. */
      kind: "exhausted";
      session: FailoverSession;
      narration: PlaybackNarration;
    };

/**
 * Decide what to do when the current source has failed.
 *
 * `cause` is why the current source failed — `delivery` (stalled, delivered no
 * bytes) or `playability` (bytes fine, the browser cannot decode it). It is
 * carried into the resulting narration so the UI can say which, and into the
 * terminal `exhausted` state so the honest terminal sentence differs for each.
 *
 * Terminal when the pool holds no untried usable candidate. Otherwise returns
 * the next candidate together with the
 * session that has already committed to it — the caller starts the download and
 * abandons the old one. Never selects a source already in `tried`, and the
 * returned narration is structured facts only.
 *
 * `verdicts` are cached swarm measurements (never probed here — this can run on
 * a UI-latency path). When supplied, a measured-`dead` release is deprioritized
 * so we do not fail over onto a swarm already known to deliver nothing; see
 * {@link preferLiveCandidates}. Omitted/empty means "no measurements", which is
 * exactly the pre-measurement behaviour.
 */
export function failOver(
  session: FailoverSession,
  results: readonly TorrentResult[],
  target: PreRankTarget,
  cause: FailureCause = "delivery",
  verdicts?: ReadonlyMap<string, SwarmVerdict> | null,
): FailoverStep {
  const candidate = chooseNextRelease(results, target, session.tried, verdicts);
  if (!candidate) {
    const exhausted: FailoverSession = { ...session, status: "exhausted" };
    return {
      kind: "exhausted",
      session: exhausted,
      narration: {
        phase: "exhausted",
        cause,
        triedCount: session.tried.length,
        outcome: exhaustedOutcome(results, session.tried.length, cause),
      },
    };
  }

  const next = commitSource(session, candidate.infoHash);
  const alternatives = listSourceOptions(results, [...session.tried, candidate.infoHash]);
  return {
    kind: "switch",
    candidate,
    session: next,
    narration: {
      phase: "switching",
      cause,
      triedCount: session.tried.length,
      nextName: candidate.release.title ?? null,
      outcome: {
        kind: "switch-source",
        reason: cause,
        selected: sourceOptionFromRelease(candidate.release, candidate.infoHash),
        alternatives,
        remainingCount: alternatives.length,
      },
    },
  };
}
