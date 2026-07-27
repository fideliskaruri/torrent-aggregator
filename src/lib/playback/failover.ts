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
 *  - **Bounded attempts.** After {@link MAX_FAILOVER_ATTEMPTS} committed
 *    sources, the session reaches a terminal `exhausted` state that is reported
 *    honestly — not a permanent "trying…".
 */
import type { TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { releaseInfoHash, selectBestRelease } from "@/lib/prewarm/prerank";
import type { PlaybackNarration } from "./narration";

/**
 * Maximum number of distinct sources we will commit to for one piece of
 * content before giving up.
 *
 * WHY 4: the observed content had exactly four releases (28/3/4/1 seeders), so
 * four attempts lets us try every distinct source once and then stop. Each
 * source is tried at most once (never retried), so a higher cap would only
 * re-select nothing — the pool is exhausted, not deeper. A hard cap with a
 * clear terminal state beats trying forever; the terminal state is what the UI
 * turns into an honest answer instead of a spinner.
 */
export const MAX_FAILOVER_ATTEMPTS = 4;

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
 * candidates or hit the attempt cap.
 */
export interface FailoverSession {
  contentKey: string;
  tried: string[];
  current: string | null;
  status: "active" | "exhausted";
  /**
   * A source the **user** explicitly chose from the quality selector. While a
   * source is pinned the automatic watchdog will detect a stall and narrate it,
   * but must never silently swap it away — an explicit human choice is not the
   * watchdog's to override. Cleared only by another manual choice or by playback
   * ending. `null` when the current source was picked by the ranker/auto-failover.
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

/**
 * Commit to a source the user explicitly chose, and PIN it.
 *
 * Pinning is the load-bearing half of the manual switch: nothing is more
 * alienating than a UI that argues with a decision the user just made, so an
 * explicit choice is exempted from automatic failover for the rest of the
 * session. The watchdog still *detects* a stall on a pinned source and narrates
 * it (so the selector can say "this stalled — pick another?"), it just does not
 * perform the swap itself. The user keeps the wheel.
 */
export function pinSource(
  session: FailoverSession,
  infoHash: string,
): FailoverSession {
  const committed = commitSource(session, infoHash);
  return { ...committed, pinnedHash: infoHash.toLowerCase() };
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
): FailoverCandidate | null {
  const tried = new Set(triedHashes.map((h) => h.toLowerCase()));
  const untried = results.filter((r) => {
    const hash = releaseInfoHash(r);
    return hash !== null && !tried.has(hash);
  });

  const release = selectBestRelease(untried, target);
  if (!release) return null;

  const infoHash = releaseInfoHash(release);
  // `selectBestRelease` only returns releases that pass `releaseInfoHash`, so
  // this is non-null; the guard keeps the type honest without a cast.
  if (!infoHash) return null;

  return { release, infoHash };
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
      /** No untried candidate, or the attempt cap was reached. Terminal. */
      kind: "exhausted";
      session: FailoverSession;
      narration: PlaybackNarration;
    };

/**
 * Decide what to do when the current source is judged stalled.
 *
 * Terminal when the attempt cap is reached or the pool holds no untried,
 * usable candidate. Otherwise returns the next candidate together with the
 * session that has already committed to it — the caller starts the download and
 * abandons the old one. Never selects a source already in `tried`, and the
 * returned narration is structured facts only.
 */
export function failOver(
  session: FailoverSession,
  results: readonly TorrentResult[],
  target: PreRankTarget,
  cap: number = MAX_FAILOVER_ATTEMPTS,
): FailoverStep {
  if (session.status === "exhausted" || session.tried.length >= cap) {
    const exhausted: FailoverSession = { ...session, status: "exhausted" };
    return {
      kind: "exhausted",
      session: exhausted,
      narration: { phase: "exhausted", triedCount: session.tried.length },
    };
  }

  const candidate = chooseNextRelease(results, target, session.tried);
  if (!candidate) {
    const exhausted: FailoverSession = { ...session, status: "exhausted" };
    return {
      kind: "exhausted",
      session: exhausted,
      narration: { phase: "exhausted", triedCount: session.tried.length },
    };
  }

  const next = commitSource(session, candidate.infoHash);
  return {
    kind: "switch",
    candidate,
    session: next,
    narration: {
      phase: "switching",
      triedCount: session.tried.length,
      nextName: candidate.release.title ?? null,
    },
  };
}
