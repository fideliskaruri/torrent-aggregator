/**
 * Process-wide event-loop delay histogram.
 *
 * "The server feels slower the longer it runs" is only actionable with a number
 * attached. `perf_hooks.monitorEventLoopDelay` samples how late the loop is
 * relative to its own resolution, which is the closest single measure of
 * whether the Node process is CPU-starved — a torrent engine hashing pieces on
 * the main thread shows up here long before it shows up as a failed request.
 *
 * Armed once per process behind a `globalThis` symbol (same pattern as the
 * schedulers), because Next re-evaluates modules on every dev HMR pass and a
 * second histogram would both double the sampling cost and reset the numbers.
 * Everything is optional: on a runtime without `perf_hooks` the reader simply
 * reports `available: false` rather than throwing on a diagnostics path.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

interface DelayHistogram {
  enable(): boolean;
  disable(): boolean;
  percentile(p: number): number;
  reset(): void;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

const MONITOR_KEY = Symbol.for("torrentflow.observability.eventLoopDelay");
/**
 * 10ms resolution: fine enough to see stalls, cheap enough to leave running.
 *
 * Note the floor. `monitorEventLoopDelay` measures how late its own timer fires,
 * so the sampling resolution plus the platform's timer granularity is baked into
 * every reading — on Windows (≈15.6ms tick) an idle process still reports tens
 * of milliseconds. The number is therefore a *trend*, not an absolute: compare
 * it against `resolutionMs` and against itself over the session, and read a p99
 * that is many multiples of p50 as the real "something is blocking the loop"
 * signal. `resolutionMs` is reported alongside so a reader can do that.
 */
const RESOLUTION_MS = 10;

function monitor(): DelayHistogram | null {
  const g = globalThis as unknown as Record<
    symbol,
    DelayHistogram | null | undefined
  >;
  if (g[MONITOR_KEY] !== undefined) return g[MONITOR_KEY] ?? null;

  let histogram: DelayHistogram | null = null;
  try {
    if (typeof monitorEventLoopDelay === "function") {
      histogram = monitorEventLoopDelay({
        resolution: RESOLUTION_MS,
      }) as unknown as DelayHistogram;
      histogram.enable();
      // A diagnostics histogram must never keep the process alive.
      (histogram as unknown as { unref?: () => void }).unref?.();
    }
  } catch {
    histogram = null;
  }

  g[MONITOR_KEY] = histogram;
  return histogram;
}

export interface EventLoopDelaySnapshot {
  available: boolean;
  /** Percentiles in milliseconds. */
  p50: number;
  p99: number;
  max: number;
  mean: number;
  /**
   * The sampling resolution, in milliseconds. Every reading includes this plus
   * the platform's timer granularity as an irreducible floor — without it the
   * percentiles cannot be interpreted.
   */
  resolutionMs: number;
}

function toMs(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) return 0;
  // One decimal is all the precision a health payload can honestly claim.
  return Math.round((nanoseconds / 1e6) * 10) / 10;
}

/**
 * Read the histogram. Pure with respect to the measurement: it never resets,
 * so two readers cannot blind each other.
 */
export function eventLoopDelaySnapshot(): EventLoopDelaySnapshot {
  const histogram = monitor();
  if (!histogram) return unavailable();
  try {
    return {
      available: true,
      p50: toMs(histogram.percentile(50)),
      p99: toMs(histogram.percentile(99)),
      max: toMs(histogram.max),
      mean: toMs(histogram.mean),
      resolutionMs: RESOLUTION_MS,
    };
  } catch {
    return unavailable();
  }
}

function unavailable(): EventLoopDelaySnapshot {
  return {
    available: false,
    p50: 0,
    p99: 0,
    max: 0,
    mean: 0,
    resolutionMs: RESOLUTION_MS,
  };
}

/** Formats an already-sampled histogram. Exported pure for tests. */
export function formatEventLoopDelay(
  sample: { p50: number; p99: number; max: number; mean: number } | null,
): EventLoopDelaySnapshot {
  if (!sample) return unavailable();
  return {
    available: true,
    p50: toMs(sample.p50),
    p99: toMs(sample.p99),
    max: toMs(sample.max),
    mean: toMs(sample.mean),
    resolutionMs: RESOLUTION_MS,
  };
}
