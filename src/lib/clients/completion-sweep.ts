/**
 * The periodic "did anything finish while nobody was listening?" sweep.
 *
 * ## The bug this exists for
 *
 * `persistAndParkCompletedTorrent` is only ever reached from an *event*:
 * `download` / `done` / `verified` on the torrent, or the one-shot check when a
 * torrent is attached or rehydrated. Verification of the final piece can settle
 * *after* the last event that would have triggered a check — WebTorrent's
 * `verified` fires per piece and `progress` is recomputed lazily — so a torrent
 * that becomes genuinely complete on the trailing edge of its own event stream
 * has no later opportunity to be parked. It then seeds forever.
 *
 * A live 9-minute diagnosis measured exactly that shape: 17 live torrents, 15
 * of them fully verified complete, zero stream leases, `parking` and
 * `parkRetryPending` flat at 0 for the whole window, one core pinned at ~106%
 * and ~460 ms event-loop p50, with complete torrents still receiving and
 * discarding traffic. Nothing was mid-park; nothing was ever going to be.
 *
 * This module is the missing later check. It is deliberately:
 *
 *   1. **Pure-by-injection.** Every engine touch point (hash, verification,
 *      leases, park maps, quiesce, park) arrives as a callback, so the decision
 *      logic is testable without WebTorrent, Prisma or a live swarm.
 *   2. **Timer-free.** It does not own a timer. The engine drives it from the
 *      existing 5 s `startUploadThrottleLoop` beat — adding a second interval
 *      to fix a CPU-pressure bug would be self-defeating.
 *   3. **Conservative.** A stream lease, an in-flight park, or a pending park
 *      retry each mean "someone else owns this torrent right now" and the sweep
 *      keeps its hands off. It never destroys, never deletes, never touches
 *      files or DB rows; the only mutation it performs itself is deselecting
 *      files on a torrent that is already complete, which stops redundant piece
 *      requests without losing a byte.
 *
 * ## Cost
 *
 * The verification predicate the engine passes in short-circuits on `progress`
 * before it scans a bitfield, so the common case per torrent is one float
 * compare. A full bitfield scan only happens for torrents already claiming
 * complete progress, and for those the sweep stops re-scanning as soon as they
 * are parked (they leave the client). That is cheap enough that memoising the
 * result — which would risk a stale *positive* surviving a failed hash check,
 * i.e. parking a torrent that is not actually complete — is not worth it.
 */

/** Why the sweep did, or did not, act on one torrent. */
export type CompletionSweepDecision =
  | "parked"
  | "quiesced-no-owner"
  | "skipped-incomplete"
  | "skipped-leased"
  | "skipped-foreground"
  | "skipped-parking"
  | "skipped-retry-pending"
  | "error";

/**
 * Park candidates started per beat.
 *
 * Parking runs media probes and a Prisma transaction per torrent. On a cold
 * start with a backlog of finished torrents (the live diagnosis had 15) an
 * uncapped sweep would launch that fleet at once and trade a seeding leak for a
 * probe storm. Two per 5 s beat drains fifteen in under a minute while leaving
 * the event loop alone; the rest are simply re-seen on the next beat.
 */
export const COMPLETION_SWEEP_PARK_BUDGET = 2;

export interface CompletionSweepStats {
  /** Torrents examined this sweep. */
  scanned: number;
  /** Verified-complete torrents seen (whatever was then decided). */
  complete: number;
  /** Complete torrents left alone because a stream reader holds them open. */
  skippedLeased: number;
  /**
   * Complete torrents left alone because they are (or just were) the
   * foreground playback target — a paused player holds no lease.
   */
  skippedForeground: number;
  /** Complete torrents already mid-park. */
  skippedParking: number;
  /** Complete torrents owned by a pending park retry timer. */
  skippedRetryPending: number;
  /** Eligible torrents deferred to a later beat by the park budget. */
  deferred: number;
  /** Complete torrents whose files were deselected by this sweep. */
  quiesced: number;
  /** Park calls this sweep actually made. */
  parkAttempted: number;
  /**
   * Complete, unleased, unparked torrents with no known owning user, so no
   * park could be attempted. Distinct from "no attempt was needed".
   */
  parkSkippedNoOwner: number;
  /** Per-torrent exceptions swallowed so one bad handle cannot stop the sweep. */
  errors: number;
}

/** Cumulative, process-lifetime counters. */
export interface CompletionSweepCounters extends CompletionSweepStats {
  /** Sweeps run. */
  sweeps: number;
  /** Park attempts that resolved false / rejected. */
  parkFailed: number;
  /** Park attempts that resolved true. */
  parkSucceeded: number;
  /** Sweeps that returned immediately because one was already running. */
  reentrantSkipped: number;
  /** Durable owner lookups started. */
  ownerLookupAttempted: number;
  /** Owner lookups that reported a recovered owner. */
  ownerLookupRecovered: number;
  /** Owner lookups that found no row or failed, and so were rescheduled. */
  ownerLookupFailed: number;
}

export interface CompletionSweepDeps<T> {
  torrents: readonly T[];
  /** Lower-cased info hash, or "" when unreadable. */
  hashOf: (torrent: T) => string;
  /** True only when every piece is actually held (not a latched `done`). */
  isVerifiedComplete: (torrent: T) => boolean;
  /** Active engine-backed HTTP responses for this hash. */
  leaseCount: (hash: string) => number;
  /** True while this hash is, or was just, the foreground playback target. */
  isForeground?: (hash: string) => boolean;
  isParking: (hash: string) => boolean;
  isParkRetryPending: (hash: string) => boolean;
  /** Owning user id, or undefined when the engine has no record. */
  ownerOf: (hash: string) => string | undefined;
  /**
   * Called when no owner could be resolved, so a durable lookup can backfill
   * it out of band.
   *
   * Return `true` when the owner was actually recovered, `false`/`undefined`
   * when it was not (no durable row, or a transient database failure). The
   * sweep never calls this more than once per
   * `COMPLETION_SWEEP_OWNER_RETRY_MS` per hash, so a permanently orphaned
   * torrent costs one query every 30 s rather than one every beat — and a
   * transient failure is *not* fatal, unlike a once-per-process notice.
   */
  onMissingOwner?: (hash: string) => boolean | void | Promise<boolean | void>;
  /** Injected clock for the owner-retry cooldown; defaults to `Date.now`. */
  now?: () => number;
  /** Park calls to start per sweep. Defaults to `COMPLETION_SWEEP_PARK_BUDGET`. */
  parkBudget?: number;
  /** Stop redundant piece requests without destroying anything. */
  quiesce: (torrent: T) => void;
  /** The engine's durable persist-then-detach transition. */
  park: (userId: string, torrent: T) => Promise<boolean> | boolean | void;
  /** Injected for tests; defaults to `console.warn`. */
  log?: (message: string) => void;
}

function emptyStats(): CompletionSweepStats {
  return {
    scanned: 0,
    complete: 0,
    skippedLeased: 0,
    skippedForeground: 0,
    skippedParking: 0,
    skippedRetryPending: 0,
    deferred: 0,
    quiesced: 0,
    parkAttempted: 0,
    parkSkippedNoOwner: 0,
    errors: 0,
  };
}

const COUNTERS_KEY = Symbol.for("torrentflow.engine.completionSweepCounters");
const NOTICED_KEY = Symbol.for("torrentflow.engine.completionSweepNoticed");
const MISSING_OWNER_KEY = Symbol.for(
  "torrentflow.engine.completionSweepMissingOwners",
);
const FLAGS_KEY = Symbol.for("torrentflow.engine.completionSweepFlags");

/**
 * Cooldown between durable owner lookups for one hash.
 *
 * A once-per-process notice was wrong: a transient Prisma failure would then
 * suppress owner resolution for the life of the process and strand the torrent
 * quiesced-but-live forever. A bounded retry keeps the orphan cost at one query
 * per 30 s (six beats) while still recovering from a blip.
 */
export const COMPLETION_SWEEP_OWNER_RETRY_MS = 30_000;

type OwnerLookupState = {
  /** Lookups started for this hash. */
  attempts: number;
  /** Earliest wall-clock time another lookup may start. */
  nextAttemptAt: number;
  /** A lookup is in flight; do not start another. */
  inFlight: boolean;
};

function sweepFlags(): { running: boolean } {
  const g = globalThis as unknown as Record<
    symbol,
    { running: boolean } | undefined
  >;
  if (!g[FLAGS_KEY]) g[FLAGS_KEY] = { running: false };
  return g[FLAGS_KEY]!;
}

function missingOwners(): Map<string, OwnerLookupState> {
  const g = globalThis as unknown as Record<
    symbol,
    Map<string, OwnerLookupState> | undefined
  >;
  if (!g[MISSING_OWNER_KEY]) g[MISSING_OWNER_KEY] = new Map<string, OwnerLookupState>();
  return g[MISSING_OWNER_KEY]!;
}

function counters(): CompletionSweepCounters {
  const g = globalThis as unknown as Record<
    symbol,
    CompletionSweepCounters | Set<string> | Map<string, OwnerLookupState> | undefined
  >;
  if (!g[COUNTERS_KEY]) {
    g[COUNTERS_KEY] = {
      ...emptyStats(),
      sweeps: 0,
      parkFailed: 0,
      parkSucceeded: 0,
      reentrantSkipped: 0,
      ownerLookupAttempted: 0,
      ownerLookupRecovered: 0,
      ownerLookupFailed: 0,
    };
  }
  return g[COUNTERS_KEY] as CompletionSweepCounters;
}

function noticed(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[NOTICED_KEY]) g[NOTICED_KEY] = new Set<string>();
  return g[NOTICED_KEY]!;
}

/** Cumulative sweep counters for diagnostics. Never mutated by the reader. */
export function completionSweepCounters(): CompletionSweepCounters {
  return { ...counters() };
}

/** Test-only reset of the cumulative counters and once-per-hash notices. */
export function resetCompletionSweepCountersForTests(): void {
  const current = counters();
  Object.assign(current, emptyStats(), {
    sweeps: 0,
    parkFailed: 0,
    parkSucceeded: 0,
    reentrantSkipped: 0,
    ownerLookupAttempted: 0,
    ownerLookupRecovered: 0,
    ownerLookupFailed: 0,
  });
  noticed().clear();
  missingOwners().clear();
  sweepFlags().running = false;
}

/**
 * Drop owner-resolution state. Called on engine shutdown so a restarted engine
 * cannot inherit a cooldown — or a lookup left flagged in-flight — from the
 * dead one and stall owner recovery.
 */
export function clearCompletionSweepOwnerState(): void {
  missingOwners().clear();
  sweepFlags().running = false;
}

/**
 * Decide what to do with one already-scanned torrent.
 *
 * Split out so the precedence of the guards — lease beats park-in-flight beats
 * retry-pending beats act — is assertable on its own. Ordering matters: a
 * leased torrent that is also mid-park must report as leased-skipped, because
 * the lease is the reason nothing further will happen this beat.
 */
export function decideCompletionSweep(facts: {
  verifiedComplete: boolean;
  leases: number;
  foreground?: boolean;
  parking: boolean;
  parkRetryPending: boolean;
  owner: string | undefined;
}): CompletionSweepDecision {
  if (!facts.verifiedComplete) return "skipped-incomplete";
  if (facts.leases > 0) return "skipped-leased";
  if (facts.foreground === true) return "skipped-foreground";
  if (facts.parking) return "skipped-parking";
  if (facts.parkRetryPending) return "skipped-retry-pending";
  if (!facts.owner) return "quiesced-no-owner";
  return "parked";
}

/**
 * One pass over the live torrents. Synchronous and re-entrant-safe: parking is
 * fire-and-forget, and the engine's own `parking` map makes a repeated sweep
 * over the same torrent a no-op rather than a second transition.
 */
export function runCompletionSweep<T>(
  deps: CompletionSweepDeps<T>,
): CompletionSweepStats {
  const stats = emptyStats();
  const log = deps.log ?? ((message: string) => console.warn(message));
  const list = Array.isArray(deps.torrents) ? deps.torrents : [];
  const totals = counters();
  const flags = sweepFlags();
  // Re-entrancy is guarded in shared (global) state rather than a module-local
  // so a dev hot-reload re-evaluating this module cannot hand out a fresh
  // "nothing is running" flag while a park from the previous copy is in flight.
  if (flags.running) {
    totals.reentrantSkipped += 1;
    return stats;
  }
  flags.running = true;
  totals.sweeps += 1;
  const now = deps.now ?? Date.now;
  let budget = Math.max(0, deps.parkBudget ?? COMPLETION_SWEEP_PARK_BUDGET);

  try {
    for (const torrent of list) {
      if (!torrent || typeof torrent !== "object") continue;
      stats.scanned += 1;
      let hash = "";
      try {
        hash = deps.hashOf(torrent) || "";
        const verifiedComplete = deps.isVerifiedComplete(torrent) === true;
        const owner = verifiedComplete ? deps.ownerOf(hash) : undefined;
        if (owner && hash) {
          // The owner is known again (event, attach, or a backfilled lookup):
          // forget any retry state so a later loss starts from a clean slate.
          missingOwners().delete(hash);
        }
        const decision = decideCompletionSweep({
          verifiedComplete,
          leases: verifiedComplete ? deps.leaseCount(hash) : 0,
          foreground: verifiedComplete
            ? deps.isForeground?.(hash) === true
            : false,
          parking: verifiedComplete ? deps.isParking(hash) : false,
          parkRetryPending: verifiedComplete
            ? deps.isParkRetryPending(hash)
            : false,
          owner: verifiedComplete ? owner : undefined,
        });

        if (decision === "skipped-incomplete") continue;
        stats.complete += 1;

        if (decision === "skipped-leased") {
          stats.skippedLeased += 1;
          continue;
        }
        if (decision === "skipped-foreground") {
          stats.skippedForeground += 1;
          continue;
        }
        if (decision === "skipped-parking") {
          stats.skippedParking += 1;
          continue;
        }
        if (decision === "skipped-retry-pending") {
          stats.skippedRetryPending += 1;
          continue;
        }

        // An unownable torrent can never be parked, so it does not spend the
        // park budget; it is quiesced (free) and reported once.
        if (decision === "quiesced-no-owner") {
          deps.quiesce(torrent);
          stats.quiesced += 1;
          noteSweptHash(hash, log);
          stats.parkSkippedNoOwner += 1;
          noteMissingOwner(hash, deps.onMissingOwner, log, now(), totals);
          continue;
        }

        // Budget spent: leave this torrent untouched and re-see it next beat.
        // Quiescing it anyway would be free, but deselecting a torrent the
        // sweep is not about to park only widens the window in which a
        // resume/reselect could observe a selection-less torrent.
        if (budget <= 0) {
          stats.deferred += 1;
          continue;
        }
        budget -= 1;

        // Complete, unleased and nobody else's problem: stop the redundant
        // request traffic first, so quiescing still happens even if the park
        // below fails.
        deps.quiesce(torrent);
        stats.quiesced += 1;
        noteSweptHash(hash, log);

        stats.parkAttempted += 1;
        const result = deps.park(deps.ownerOf(hash) as string, torrent);
        void Promise.resolve(result)
          .then((ok) => {
            if (ok === false) totals.parkFailed += 1;
            else totals.parkSucceeded += 1;
          })
          .catch(() => {
            totals.parkFailed += 1;
          });
      } catch (err) {
        stats.errors += 1;
        try {
          log(
            `[completion-sweep] failed to sweep ${hash || "<unknown hash>"}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        } catch {
          // Observability must never break the sweep.
        }
      }
    }
  } finally {
    flags.running = false;
  }

  for (const key of Object.keys(stats) as Array<keyof CompletionSweepStats>) {
    totals[key] += stats[key];
  }
  return stats;
}

/**
 * Attempt a durable owner lookup for a complete torrent with no owner, at most
 * once per `COMPLETION_SWEEP_OWNER_RETRY_MS` per hash.
 *
 * The cooldown replaces an earlier once-per-process notice, which had a real
 * failure mode: one transient database error permanently suppressed the lookup
 * and the torrent stayed quiesced-but-live for the life of the process. Now a
 * failure (or an absent row) only costs one query per cooldown, and a recovered
 * owner clears the state so the next beat parks normally.
 */
function noteMissingOwner(
  hash: string,
  onMissingOwner: ((hash: string) => boolean | void | Promise<boolean | void>) | undefined,
  log: (message: string) => void,
  now: number,
  totals: CompletionSweepCounters,
): void {
  if (!hash) return;
  const states = missingOwners();
  const state = states.get(hash);

  if (!state) {
    try {
      log(
        `[completion-sweep] ${hash} is verified complete but has no owning user in engine state; quiesced without a park attempt`,
      );
    } catch {
      // Observability must never break the sweep.
    }
  } else if (state.inFlight || now < state.nextAttemptAt) {
    // Either a lookup is running or we are inside the backoff window.
    return;
  }

  const next: OwnerLookupState = {
    attempts: (state?.attempts ?? 0) + 1,
    nextAttemptAt: now + COMPLETION_SWEEP_OWNER_RETRY_MS,
    inFlight: true,
  };
  states.set(hash, next);
  totals.ownerLookupAttempted += 1;

  const settle = (recovered: boolean) => {
    const current = states.get(hash);
    if (current !== next) return; // reset/shutdown happened underneath us
    if (recovered) {
      states.delete(hash);
      totals.ownerLookupRecovered += 1;
      return;
    }
    current.inFlight = false;
    totals.ownerLookupFailed += 1;
  };

  try {
    const outcome = onMissingOwner?.(hash);
    if (outcome && typeof (outcome as Promise<unknown>).then === "function") {
      void (outcome as Promise<boolean | void>)
        .then((ok) => settle(ok === true))
        .catch(() => settle(false));
      return;
    }
    settle(outcome === true);
  } catch {
    // A failed durable lookup must not stop the sweep — just retry it later.
    settle(false);
  }
}

/**
 * Say once per hash that a torrent finished without any event-driven park.
 *
 * Once-per-hash because this runs every 5 s: the interesting fact is that the
 * sweep — not an event — was what caught this torrent, and repeating it would
 * only bury the next one.
 */
function noteSweptHash(hash: string, log: (message: string) => void): void {
  if (!hash) return;
  const seen = noticed();
  if (seen.has(hash)) return;
  seen.add(hash);
  try {
    log(
      `[completion-sweep] ${hash} was verified complete but had not been parked by any completion event; quiescing and parking now`,
    );
  } catch {
    // Observability must never break the sweep.
  }
}

/** Hashes the sweep (rather than an event) caught this process. */
export function completionSweepNoticedHashes(): string[] {
  return [...noticed()].sort();
}
