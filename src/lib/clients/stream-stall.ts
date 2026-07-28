/**
 * Byte-progress stall guard for a live stream read.
 *
 * WHY THIS EXISTS (I45/I37)
 * -------------------------
 * The stream route used to race every `reader.read()` against a fixed 15s
 * wall-clock timeout. A slow-but-healthy swarm — pieces genuinely arriving, just
 * not fast enough to complete the head piece the player is blocked on within
 * 15s — was 503'd and abandoned even though it WAS working (the real Eternals
 * case: it plays if given more time). A clock cannot tell "slow" from "dead".
 *
 * So the verdict here is built on DELIVERED BYTES over a rolling window, reusing
 * the pure {@link evaluateStall} rule. A stream that is still receiving bytes is
 * NEVER declared stalled, however slow; only a stream that has delivered nothing
 * for a continuous window errors — and it errors with a structured code, sooner
 * than 15s of dead air, instead of hanging.
 *
 * TIMER SAFETY (I44)
 * ------------------
 * Every timer callback is wrapped in try/catch, the sampling timer is cleared on
 * a SINGLE settled path, and the parked `read()` promise is always observed
 * (its rejection is folded into the settled result), so no rejection can escape
 * as an `unhandledRejection` with a node-internal-only stack.
 */
import {
  evaluateStall,
  type StallOptions,
  type StallVerdict,
  type TransferSample,
} from "@/lib/playback/stall";

/** The minimal torrent shape this guard needs to sample byte progress. */
export interface StallSampleSource {
  progress?: number | null;
  /** Absolute bytes fetched so far (WebTorrent `torrent.downloaded`). Preferred. */
  downloaded?: number | null;
  /** Total torrent bytes, used to derive delivered bytes from `progress`. */
  length?: number | null;
  numPeers?: number | null;
}

/**
 * Stream-specific window. Shorter than the watchdog's 30s: a viewer staring at a
 * spinner needs an answer sooner than a background prewarm does, and the stream
 * route has already committed to serving this one file, so a dead swarm should
 * become actionable well under the old 15s. Progressing streams are unaffected —
 * the window only bounds ZERO-byte spans.
 */
export const STREAM_STALL_WINDOW_MS = 12_000;

/**
 * Cold-start grace for a stream. A fresh press-play swarm can legitimately
 * deliver nothing for its first seconds; without active piece requests, though,
 * a zero-byte stream is dead and becomes actionable at the window.
 */
export const STREAM_COLD_START_GRACE_MS = 12_000;

export function streamStallOptions(windowMs = STREAM_STALL_WINDOW_MS): StallOptions {
  return {
    windowMs,
    coldStartGraceMs: STREAM_COLD_START_GRACE_MS,
  };
}

/** Evaluate a stream sample series with stream-tuned options. */
export function evaluateStreamStall(
  samples: readonly TransferSample[],
  options: StallOptions = streamStallOptions(),
): StallVerdict {
  return evaluateStall(samples, options);
}

/**
 * One reading of a torrent's byte progress for the stall guard.
 *
 * `state` is fixed to "downloading": entering this guard means the route is
 * actively pulling this file, so the engine is (or should be) downloading. That
 * keeps {@link evaluateStall} on its byte-progress branch instead of bailing out
 * as "not-downloading".
 */
export function sampleStreamTransfer(
  source: StallSampleSource,
  atMs = Date.now(),
): TransferSample {
  const progress =
    typeof source.progress === "number" && Number.isFinite(source.progress)
      ? source.progress
      : 0;
  const length =
    typeof source.length === "number" && Number.isFinite(source.length)
      ? source.length
      : 0;
  const downloaded =
    typeof source.downloaded === "number" && Number.isFinite(source.downloaded)
      ? source.downloaded
      : length > 0
        ? Math.round(progress * length)
        : 0;
  return {
    atMs,
    downloadedBytes: Math.max(0, downloaded),
    progress,
    state: "downloading",
    peerCount:
      typeof source.numPeers === "number" && Number.isFinite(source.numPeers)
        ? source.numPeers
        : null,
  };
}

export type StallGuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "stalled" | "aborted"; verdict?: StallVerdict; error?: unknown };

export interface StallGuardDeps {
  /** Snapshot the torrent's byte progress. Called at each sampling tick. */
  sample: () => TransferSample;
  /** Stall options; defaults to {@link streamStallOptions}. */
  options?: StallOptions;
  /**
   * Sampling interval. Defaults to a fraction of the window so a short test
   * window still gathers enough samples to reach a verdict quickly. Bounded so a
   * production window does not spin a hot timer.
   */
  sampleIntervalMs?: number;
  now?: () => number;
  // Injectable timers keep the guard testable without real wall-clock waits.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function defaultSampleInterval(windowMs: number): number {
  // A third of the window gives ~3 baseline candidates before the window
  // elapses, clamped so neither a 50ms test window nor a 12s prod window is
  // pathological.
  return Math.max(10, Math.min(Math.floor(windowMs / 3), 1_000));
}

/**
 * Await `read()` but abandon it if the torrent goes byte-stalled or the request
 * aborts. Resolves — never rejects — so callers can branch on a single shape.
 *
 * The core invariant: `read()` resolving ALWAYS wins if it happens, so a stream
 * that is progressing (even slowly) is served. Only a genuine zero-byte stall
 * over the window, or an abort, or a thrown read, produces `ok: false`.
 */
export function readWithStallGuard<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
  deps: StallGuardDeps,
): Promise<StallGuardResult<T>> {
  const options = deps.options ?? streamStallOptions();
  const windowMs = options.windowMs ?? STREAM_STALL_WINDOW_MS;
  const intervalMs = deps.sampleIntervalMs ?? defaultSampleInterval(windowMs);
  const setTimer =
    deps.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));

  const samples: TransferSample[] = [];
  const pushSample = () => {
    try {
      samples.push(deps.sample());
    } catch {
      /* a sampler that throws must not crash the guard; a missing sample only
         delays the verdict, and read()/abort still settle it. */
    }
  };
  pushSample();

  return new Promise<StallGuardResult<T>>((resolve) => {
    let settled = false;
    let timer: unknown;
    let onAbort: (() => void) | undefined;

    const settle = (result: StallGuardResult<T>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        try {
          clearTimer(timer);
        } catch {
          /* best-effort */
        }
        timer = undefined;
      }
      if (onAbort) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          /* best-effort */
        }
        onAbort = undefined;
      }
      resolve(result);
    };

    if (signal.aborted) {
      settle({ ok: false, reason: "aborted" });
      return;
    }
    onAbort = () => settle({ ok: false, reason: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });

    timer = setTimer(() => {
      // I44: a throw in this timer callback must be caught here, never allowed to
      // surface as an unhandledRejection from node's timer internals.
      try {
        pushSample();
        const verdict = evaluateStreamStall(samples, options);
        if (verdict.stalled) settle({ ok: false, reason: "stalled", verdict });
      } catch (err) {
        settle({ ok: false, reason: "stalled", error: err });
      }
    }, intervalMs);

    // Always observe the read: fold its rejection into the settled result so a
    // late rejection after a stall/abort cannot escape unhandled.
    read().then(
      (value) => settle({ ok: true, value }),
      (err) => settle({ ok: false, reason: "stalled", error: err }),
    );
  });
}
