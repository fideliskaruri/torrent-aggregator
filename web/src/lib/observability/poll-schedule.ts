/**
 * Poll scheduling policy — when a background refresh is worth a request.
 *
 * Every live panel in this app is a `setInterval` that fires a fetch on a fixed
 * cadence. Two properties of that shape cost the server real time:
 *
 *  1. **Hidden tabs keep polling.** A `/title/...` page left open in a
 *     background tab re-queries every 2.5s forever. Nobody is looking at it,
 *     but the request still walks the DB, the engine and the metadata caches.
 *     Browsers throttle background timers to ~1/min, which softens this but
 *     does not remove it — and a *visible-but-occluded* window is not
 *     throttled at all.
 *  2. **Ticks pile up on a slow server.** The interval does not know a request
 *     is still in flight. When the event loop is blocked (a torrent engine
 *     hashing pieces will do it), each tick adds another concurrent request to
 *     a server that is already behind, so load rises exactly when capacity
 *     falls. That is a positive feedback loop, and it is the reason a
 *     momentary hitch turns into a multi-second one.
 *
 * The fix for both is a decision, not a rewrite: skip the tick. This module is
 * that decision, kept pure so it can be tested without a DOM, a timer or a
 * server. The hook owns the wiring; the policy lives here.
 *
 * Deliberately NOT backoff or a request queue. Skipping is safe because the
 * next tick is always coming: a dropped poll costs at most one interval of
 * staleness, and the caller refetches immediately when the tab comes back, so
 * a returning user never reads stale data.
 */

export interface PollDecisionFacts {
  /** `document.hidden` — the tab is backgrounded/minimised. */
  hidden: boolean;
  /** A request from this query has not settled yet. */
  inFlight: boolean;
  /**
   * How long the outstanding request has been outstanding, in ms. Only read
   * when `inFlight` is true. Omitted means "unknown", which is treated as
   * young — suppression stays the default, recovery is the exception.
   */
  inFlightForMs?: number;
  /**
   * Past this age an outstanding request stops suppressing ticks and the
   * caller is expected to abort and re-issue it. Omitted means no deadline.
   */
  deadlineMs?: number;
}

export type PollSkipReason = "hidden" | "in-flight";

export interface PollDecision {
  poll: boolean;
  /** Why the tick was dropped, for diagnostics. `null` when polling. */
  reason: PollSkipReason | null;
}

/**
 * Should this interval tick actually issue a request?
 *
 * `hidden` is checked first so the reason reported for a backgrounded tab is
 * "hidden" even if a request happens to be outstanding — that is the
 * actionable one.
 */
export function decidePoll(facts: PollDecisionFacts): PollDecision {
  if (facts.hidden) return { poll: false, reason: "hidden" };
  if (facts.inFlight && !isRequestPastDeadline(facts)) {
    return { poll: false, reason: "in-flight" };
  }
  return { poll: true, reason: null };
}

/**
 * Has an outstanding request outlived the point where suppressing polls costs
 * more than it saves?
 *
 * Overlap suppression assumes the outstanding request will settle. A fetch
 * that never settles — a connection a proxy black-holes, a server that
 * accepted the socket and stopped writing — breaks that assumption, and
 * without a deadline the panel stops refreshing *forever* while still looking
 * live. So suppression is bounded: past the deadline the tick is allowed
 * through, and the caller aborts and re-issues.
 *
 * Not backoff and not a retry count: one outstanding request is replaced by
 * exactly one new request on the normal cadence, so the recovery path can
 * never be a load amplifier.
 */
function isRequestPastDeadline(facts: PollDecisionFacts): boolean {
  const { inFlightForMs, deadlineMs } = facts;
  if (typeof deadlineMs !== "number" || !(deadlineMs > 0)) return false;
  if (typeof inFlightForMs !== "number" || !Number.isFinite(inFlightForMs)) {
    return false;
  }
  return inFlightForMs >= deadlineMs;
}

/**
 * How long a single request is allowed to stay outstanding before a poll tick
 * may abort and replace it.
 *
 * Derived from the poll interval rather than a flat constant: a 2.5s panel
 * that has heard nothing for 10s is stuck, while a 60s panel is not. Clamped
 * at both ends so a fast cadence cannot turn a merely-slow server into a
 * cancel/retry storm, and a slow cadence cannot leave a wedged request
 * suppressing polls for the rest of the session.
 *
 * A flat deadline is not enough on its own, and the failure it causes is
 * subtle: the 2.5s title poll would get a 15s deadline, so an endpoint that
 * honestly takes ~20s (cold metadata fetch, a scrape behind a slow tracker)
 * is aborted at 15s, re-issued, aborted at 15s, forever. The panel never
 * loads, and the server does *more* work than if we had simply waited. So the
 * deadline is patient on a first load and grows on each consecutive
 * deadline-triggered replacement, resetting the moment any request settles
 * normally.
 */
export const MIN_REQUEST_DEADLINE_MS = 15_000;
export const MAX_REQUEST_DEADLINE_MS = 60_000;

/**
 * First loads get a materially more patient deadline than refreshes. There is
 * nothing on screen to go stale, aborting buys the user nothing, and cold
 * paths (no caches warm) are exactly when a response legitimately takes tens
 * of seconds.
 */
export const FIRST_LOAD_REQUEST_DEADLINE_MS = 60_000;

/**
 * The saturation point for the adaptive growth. Chosen so a genuinely slow
 * endpoint is eventually given far more time than it needs, while a
 * black-holed socket is still retried periodically rather than never — a
 * deadline that grew without bound would be a permanent stuck owner wearing a
 * different hat.
 */
export const MAX_ADAPTIVE_REQUEST_DEADLINE_MS = 600_000;

export interface RequestDeadlineFacts {
  /** Nothing has ever loaded for this query yet. */
  firstLoad?: boolean;
  /**
   * Consecutive replacements caused by a deadline, with no request settling
   * normally in between. Reset to 0 by any normal settle.
   */
  timeoutStreak?: number;
}

export function requestDeadlineMs(
  intervalMs: number,
  facts: RequestDeadlineFacts = {},
): number {
  const cadence =
    !(intervalMs > 0) || !Number.isFinite(intervalMs)
      ? MIN_REQUEST_DEADLINE_MS
      : Math.min(
          MAX_REQUEST_DEADLINE_MS,
          Math.max(MIN_REQUEST_DEADLINE_MS, intervalMs * 4),
        );

  const base = facts.firstLoad
    ? Math.max(cadence, FIRST_LOAD_REQUEST_DEADLINE_MS)
    : cadence;

  const streak =
    typeof facts.timeoutStreak === "number" &&
    Number.isFinite(facts.timeoutStreak) &&
    facts.timeoutStreak > 0
      ? Math.min(Math.floor(facts.timeoutStreak), 20)
      : 0;

  return Math.min(MAX_ADAPTIVE_REQUEST_DEADLINE_MS, base * 2 ** streak);
}

export interface OutstandingRequest {
  /** The generation that owns the slot. Never reused. */
  generation: number;
  /** Epoch ms when the request was issued, for the deadline check. */
  startedAt: number;
}

/**
 * The "is a request outstanding?" slot, as a value instead of a boolean.
 *
 * A boolean loses *which* request set it, and that is exactly the information
 * needed to be correct: an aborted request's `finally` runs after its
 * replacement has already started, so a shared boolean gets cleared by a
 * request nobody is waiting for any more. Releases are therefore
 * generation-checked — a stale owner's release is a no-op — and a claim always
 * wins, because the caller that claims has just aborted whatever came before.
 */
export interface RequestSlot {
  claim(request: OutstandingRequest): void;
  /** Clears the slot only if `generation` still owns it. */
  release(generation: number): void;
  current(): OutstandingRequest | null;
}

export function createRequestSlot(): RequestSlot {
  let outstanding: OutstandingRequest | null = null;
  return {
    claim(request) {
      outstanding = request;
    },
    release(generation) {
      if (outstanding?.generation === generation) outstanding = null;
    },
    current() {
      return outstanding;
    },
  };
}

/**
 * The request lifecycle for one query: who owns the slot, how patient the
 * current deadline is, and whether a tick may replace what is outstanding.
 *
 * This exists as a pure object because the interesting behaviour is not in the
 * fetch — it is in the ordering. A superseded request's `finally` running
 * after its replacement claimed the slot, a deadline that must grow only on
 * consecutive timeouts, a first load that must be more patient than a
 * refresh: all of that is plain state-machine work, and pulling it out of the
 * hook is what makes it testable without a renderer.
 */
export interface RequestLifecycle {
  /** Claims the slot for a new request. Returns its generation. */
  begin(now: number): number;
  /**
   * A request finished on its own terms (resolved or rejected). Only the
   * owning generation counts: it clears the slot and resets the deadline
   * growth, because the endpoint has demonstrably answered.
   */
  settled(generation: number): void;
  /**
   * A request was abandoned (unmount, re-query, deadline replacement). Frees
   * the slot without claiming the endpoint is healthy.
   */
  abandon(generation: number): void;
  /**
   * The poll decision for this tick. A deadline breach is counted once per
   * generation, so two ticks firing before the replacement commits cannot
   * grow the deadline twice.
   */
  decide(facts: {
    hidden: boolean;
    now: number;
    intervalMs: number;
  }): PollDecision;
  /**
   * The refresh decision for a tab that just became visible again. Same
   * ownership and deadline rules as a poll tick: staleness is a reason to
   * *want* a request, it is not a reason to abort one that is still within
   * its (adaptive) deadline.
   */
  decideVisibilityRefresh(facts: {
    now: number;
    intervalMs: number;
    hiddenForMs: number;
    missedTick: boolean;
  }): VisibilityRefreshDecision;
  /** The deadline a request begun now would be given. */
  deadlineMs(intervalMs: number): number;
  outstanding(): OutstandingRequest | null;
  timeoutStreak(): number;
}

export type VisibilityRefreshSkipReason = "not-stale" | "in-flight";

export interface VisibilityRefreshDecision {
  refresh: boolean;
  /** Why the refresh was dropped, for diagnostics. `null` when refreshing. */
  reason: VisibilityRefreshSkipReason | null;
}

export function createRequestLifecycle(): RequestLifecycle {
  const slot = createRequestSlot();
  let generation = 0;
  let streak = 0;
  let everSettled = false;
  let lastTimedOutGeneration = -1;

  const deadlineFor = (intervalMs: number) =>
    requestDeadlineMs(intervalMs, {
      firstLoad: !everSettled,
      timeoutStreak: streak,
    });

  const decideTick = ({
    hidden,
    now,
    intervalMs,
  }: {
    hidden: boolean;
    now: number;
    intervalMs: number;
  }): PollDecision => {
    const outstanding = slot.current();
    const decision = decidePoll({
      hidden,
      inFlight: outstanding !== null,
      inFlightForMs: outstanding ? now - outstanding.startedAt : 0,
      deadlineMs: deadlineFor(intervalMs),
    });
    if (
      decision.poll &&
      outstanding &&
      outstanding.generation !== lastTimedOutGeneration
    ) {
      lastTimedOutGeneration = outstanding.generation;
      streak += 1;
    }
    return decision;
  };

  return {
    begin(now) {
      generation += 1;
      slot.claim({ generation, startedAt: now });
      return generation;
    },
    settled(gen) {
      // A stale generation's `finally` must not report the endpoint healthy:
      // it never got an answer, it got aborted.
      if (slot.current()?.generation !== gen) return;
      slot.release(gen);
      everSettled = true;
      streak = 0;
    },
    abandon(gen) {
      slot.release(gen);
    },
    decide: decideTick,
    decideVisibilityRefresh({ now, intervalMs, hiddenForMs, missedTick }) {
      // Staleness first: coming straight back from another window must not
      // fire an extra request at all.
      if (!shouldRefreshOnVisible({ intervalMs, hiddenForMs, missedTick })) {
        return { refresh: false, reason: "not-stale" };
      }
      // Then the same overlap/deadline rules a tick obeys. Without this, a
      // tab hidden and shown during a slow first load aborts and restarts a
      // request that was working — the exact starvation the deadline exists
      // to prevent, arriving through a different door.
      const decision = decideTick({ hidden: false, now, intervalMs });
      if (!decision.poll) return { refresh: false, reason: "in-flight" };
      return { refresh: true, reason: null };
    },
    deadlineMs(intervalMs) {
      return deadlineFor(intervalMs);
    },
    outstanding() {
      return slot.current();
    },
    timeoutStreak() {
      return streak;
    },
  };
}

/**
 * Should becoming visible trigger an immediate refresh?
 *
 * Only when the tab was hidden long enough for the data to be meaningfully
 * stale — i.e. at least one poll interval was missed. Flipping to another
 * window and straight back must not fire an extra request; that would trade
 * the saving for a burst.
 *
 * A query with no polling (`intervalMs <= 0`) never auto-refreshes on
 * visibility: it opted out of liveness, and honouring that is what makes this
 * safe to put in the shared hook.
 */
export function shouldRefreshOnVisible(args: {
  intervalMs: number;
  hiddenForMs: number;
  missedTick: boolean;
}): boolean {
  if (!(args.intervalMs > 0)) return false;
  if (args.missedTick) return true;
  return args.hiddenForMs >= args.intervalMs;
}
