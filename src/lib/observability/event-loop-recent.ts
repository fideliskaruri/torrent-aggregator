/**
 * Recent-window event-loop lag.
 *
 * `event-loop-delay.ts` reports a histogram that is armed once and never reset,
 * deliberately: two readers must not blind each other. The cost of that choice
 * is that its percentiles are LIFETIME values. On this machine the dev server
 * had been up 13 hours and reported `p99: 880.8, max: 2128.6` — numbers that
 * are true, unactionable, and unable to move. A single pathological minute
 * during startup pins p99 for the rest of the day, so "did my fix help?" and
 * "is the server blocked right now?" are both unanswerable from it.
 *
 * This module answers those. It keeps its own cheap sampler — a 1s interval
 * that measures how late it actually fired — in a bounded ring, and reports
 * percentiles over the recent window only. Lateness of a timer is the same
 * quantity `monitorEventLoopDelay` measures; sampling it once a second is far
 * coarser, but coarse and *recent* is what a "is it blocked now" reading needs,
 * and it is the only form that can be compared before and after a change.
 *
 * Design constraints, all of which the lifetime histogram also honours:
 *   - Armed exactly once per process (`armIntervalOnce`), so Next's HMR
 *     re-evaluation cannot stack samplers.
 *   - The timer is unref'd: diagnostics must never keep Node alive.
 *   - Bounded memory: a fixed-size ring, never a growing array.
 *   - Never throws on a diagnostics path; an unarmed sampler reports
 *     `available: false` rather than failing the health route.
 *   - Lateness is measured on a MONOTONIC clock (`performance.now()`), never
 *     `Date.now()`. Wall-clock time is adjustable: an NTP forward step or a
 *     laptop resume moves it by seconds-to-hours in a single tick, which a
 *     `Date.now()` delta reports as a multi-second "event loop block" that
 *     never happened. Such a sample is unactionable and pins the recent-window
 *     percentiles for the next five minutes — exactly the failure this module
 *     exists to avoid. A monotonic clock cannot step, so the number stays a
 *     measurement of the loop rather than of the clock.
 */

import { performance } from "node:perf_hooks";

import { armIntervalOnce } from "@/lib/observability/arm-interval-once";

/** Sampling cadence. One second: cheap enough to leave on forever. */
export const RECENT_SAMPLE_MS = 1_000;
/** Ring capacity — 300 samples at 1s = a 5 minute window. */
export const RECENT_WINDOW_SAMPLES = 300;

const RING_KEY = Symbol.for("torrentflow.observability.eventLoopRecent.ring");
const TIMER_KEY = Symbol.for("torrentflow.observability.eventLoopRecent.timer");

/**
 * A clock that only ever moves forward at the rate of elapsed time.
 *
 * `performance.now()` is monotonic and high-resolution; unlike `Date.now()` it
 * is immune to NTP steps and manual clock changes, so a delta taken across two
 * calls is a duration and nothing else. Exported so callers (and tests) can
 * inject an equivalent monotonic source.
 */
export type MonotonicClock = () => number;

/** The default monotonic source. Falls back to `Date.now` only if absent. */
export function monotonicNowMs(): number {
  return typeof performance?.now === "function" ? performance.now() : Date.now();
}

interface Ring {
  samples: number[];
  next: number;
  filled: boolean;
  lastAt: number;
}

function ring(): Ring {
  const g = globalThis as unknown as Record<symbol, Ring | undefined>;
  if (!g[RING_KEY]) {
    g[RING_KEY] = {
      samples: new Array<number>(RECENT_WINDOW_SAMPLES).fill(0),
      next: 0,
      filled: false,
      lastAt: 0,
    };
  }
  return g[RING_KEY]!;
}

/** Test-only: forget every sample without disarming the timer. */
export function resetRecentEventLoopSamples(): void {
  const g = globalThis as unknown as Record<symbol, Ring | undefined>;
  delete g[RING_KEY];
}

/**
 * Record one observed lateness in milliseconds.
 *
 * Exported so tests can drive the ring deterministically instead of sleeping.
 * Negative or non-finite values are dropped rather than clamped: a clock that
 * went backwards is not a zero-lag sample, it is no sample at all.
 */
export function recordEventLoopLag(lagMs: number): void {
  if (!Number.isFinite(lagMs) || lagMs < 0) return;
  const r = ring();
  r.samples[r.next] = lagMs;
  r.next = (r.next + 1) % RECENT_WINDOW_SAMPLES;
  if (r.next === 0) r.filled = true;
  // Wall clock on purpose: this is "when did we last sample", a timestamp for
  // humans, never a subtrahend. Durations use the monotonic clock instead.
  r.lastAt = Date.now();
}

/** The samples currently in the window, oldest-first order not guaranteed. */
export function recentEventLoopSamples(): number[] {
  const r = ring();
  return r.filled ? r.samples.slice() : r.samples.slice(0, r.next);
}

export interface RecentEventLoopSummary {
  available: boolean;
  /** How many samples the percentiles are computed over. */
  samples: number;
  /** Milliseconds of lateness. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Window length actually covered, in seconds. */
  windowSeconds: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Percentiles over a sample set. Pure — no globals, no clock.
 *
 * Nearest-rank on a copy: with at most 300 numbers a sort per read is far
 * cheaper than maintaining an ordered structure on the write path, and the
 * write path is the one that runs on a timer.
 */
export function summarizeLagSamples(samples: readonly number[]): RecentEventLoopSummary {
  if (!samples || samples.length === 0) {
    return {
      available: false,
      samples: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      windowSeconds: 0,
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => {
    const rank = Math.ceil((p / 100) * sorted.length);
    const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return round1(sorted[index]!);
  };
  return {
    available: true,
    samples: sorted.length,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: round1(sorted[sorted.length - 1]!),
    windowSeconds: Math.round((sorted.length * RECENT_SAMPLE_MS) / 1000),
  };
}

/**
 * Arm the sampler. Idempotent per process; safe to call from any route.
 *
 * The measured quantity is `elapsed - RECENT_SAMPLE_MS`: how much later than
 * requested this timer actually ran. A loop with nothing blocking it reports
 * single-digit milliseconds; a synchronous 800ms sweep shows up as an 800ms
 * sample in the very window it happened in.
 */
export function armRecentEventLoopSampler(now: MonotonicClock = monotonicNowMs): boolean {
  const tick = makeLagSampler(now);
  const result = armIntervalOnce(TIMER_KEY, RECENT_SAMPLE_MS, tick);
  return result.armed;
}

/**
 * The sampler's tick, factored out so tests can drive it with an injected
 * monotonic clock instead of waiting on real timers.
 *
 * Each call records `elapsed - RECENT_SAMPLE_MS` against the previous call.
 * Because `now` is monotonic, a wall-clock jump between two ticks contributes
 * nothing; only time the loop actually spent does.
 */
export function makeLagSampler(now: MonotonicClock = monotonicNowMs): () => void {
  let previous = now();
  return () => {
    const current = now();
    recordEventLoopLag(current - previous - RECENT_SAMPLE_MS);
    previous = current;
  };
}

/** Arm-on-read summary for the health payload. Never throws. */
export function recentEventLoopDelay(): RecentEventLoopSummary {
  try {
    armRecentEventLoopSampler();
    return summarizeLagSamples(recentEventLoopSamples());
  } catch {
    return summarizeLagSamples([]);
  }
}
