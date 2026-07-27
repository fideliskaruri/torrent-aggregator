/**
 * The background pre-probe scheduler.
 *
 * `preProbeUpcoming` measures the swarms of the next things a user is likely to
 * watch and stores the verdicts, so that by the time they press play we already
 * know which magnet actually delivers. It was reachable from exactly one place:
 * the `action: "prerank"` branch of `POST /api/prewarm` — and *nothing in the
 * app ever sends that action*. The two client calls that hit `/api/prewarm` use
 * `action: "next"` and `action: "trigger"`; no component, script or server task
 * posts `prerank`. So the whole speculative-measurement path was dead: a
 * capability nothing invokes, which is indistinguishable from an unimplemented
 * one. This repo has been bitten by that exact shape before (`markForegroundActive`
 * sat with no caller while the feature it enabled was assumed to work).
 *
 * This arms it on a timer, mirroring the automation scheduler's proven pattern
 * (globalThis singleton against HMR, self-scheduling `setTimeout` so runs never
 * overlap, `unref` so it never holds the process open, every run wrapped so a
 * throw reschedules instead of crashing, settings re-read each tick).
 *
 * Every guard the pre-probe already carries is respected here rather than
 * bypassed:
 *   - **Scope.** `preProbeScope` (`off` | `watching` | `monitored`, default
 *     `monitored`) is re-read each tick. `off` is the user's explicit opt-out
 *     and the pass does nothing — no ranking, no probing.
 *   - **Never compete with a viewer.** The whole pass is skipped while a
 *     foreground stream is active, and `preProbeUpcoming` re-checks between
 *     targets and yields mid-pass. Speculative work always loses to playback.
 *   - **Never touch a live download.** `preProbeUpcoming` skips any info-hash
 *     the engine already holds — the guard that protects a user's real files.
 *   - **Bounded.** The per-run caps inside `preProbeUpcoming` (targets,
 *     candidates, probes) are unchanged; this only decides *when* a pass runs.
 *   - **Verdicts expire.** Measurements carry a 6h TTL and read back as
 *     `unknown` once stale, so a bad probe never hardens into a permanent
 *     judgement. The cadence below is chosen against that TTL.
 *
 * Why rank *then* probe: `preProbeUpcoming` measures the top candidates out of
 * the `SearchCache` pool for each target, so an empty or stale pool yields
 * nothing to measure. `preRankUpcoming` warms and ranks that pool first, on the
 * same shared background indexer budget — this is exactly the pair the sanctioned
 * `prerank` route action ran, now on a schedule.
 */
import { LOCAL_USER_ID } from "@/lib/auth-constants";
import { foregroundActive } from "@/lib/prewarm/foreground";
import { preRankUpcoming } from "@/lib/prewarm/prerank";
import {
  preProbeUpcoming,
  resolvePreProbeScope,
  type PreProbeResult,
  type PreProbeScope,
} from "@/lib/prewarm/preprobe";

/**
 * Steady-state cadence between pre-probe passes.
 *
 * Chosen against the 6h verdict TTL. `preProbeUpcoming` skips any info-hash
 * measured within TTL (even `unknown`), so a pass only does real work when a
 * verdict has expired or a new monitored target has appeared — the steady-state
 * cost is near zero. 30 minutes re-measures a monitored show's swarm several
 * times across its TTL window (keeping the "click and play" latency bought down
 * as swarms decay and revive) without ever re-probing a still-fresh verdict.
 */
export const PREPROBE_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Retry sooner than the steady cadence when a viewer is watching, so probing
 * resumes promptly once playback ends rather than waiting out a full interval.
 */
export const PREPROBE_FOREGROUND_RETRY_MS = 60 * 1000;

/** How long to wait before re-reading the scope while pre-probing is `off`. */
export const PREPROBE_DISABLED_POLL_MS = 5 * 60 * 1000;

/**
 * Let the server finish booting, and stagger behind the automation scheduler's
 * 30s startup so the two background timers do not both fire the instant the
 * process comes up.
 */
export const PREPROBE_STARTUP_DELAY_MS = 45 * 1000;

const GLOBAL_KEY = Symbol.for("torrentflow.preprobe.scheduler");

type SchedulerState = { started: boolean; timer: NodeJS.Timeout | null };

function state(): SchedulerState {
  const g = globalThis as unknown as Record<symbol, SchedulerState | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { started: false, timer: null };
  return g[GLOBAL_KEY]!;
}

/** Injectable dependencies so the tick logic is testable without a swarm, a DB, or real timers. */
export interface PreProbeTickDeps {
  userId?: string;
  resolveScope?: (userId: string) => Promise<PreProbeScope>;
  isForeground?: () => boolean;
  preRank?: (userId: string) => Promise<unknown>;
  preProbe?: (userId: string) => Promise<PreProbeResult>;
}

export interface PreProbeTickOutcome {
  /** Delay until the next tick, in ms. */
  delayMs: number;
  /** Whether a full rank+probe pass actually ran. */
  ran: boolean;
  /** Why the pass did not run, when it did not. */
  skipped?: "off" | "foreground" | "settings-error";
  /** The pass result, present only when a pass ran. */
  result?: PreProbeResult;
}

/**
 * One scheduler tick: decide whether to run, run the rank+probe pass if so, and
 * report how long to wait before the next one. Pure with respect to its
 * injected dependencies — no globals, no timers — so the guard behaviour can be
 * asserted directly.
 */
export async function runPreProbeTick(
  deps: PreProbeTickDeps = {},
): Promise<PreProbeTickOutcome> {
  const userId = deps.userId ?? LOCAL_USER_ID;
  const resolveScope = deps.resolveScope ?? ((u) => resolvePreProbeScope(u));
  const isForeground = deps.isForeground ?? foregroundActive;
  const preRank = deps.preRank ?? ((u) => preRankUpcoming(u));
  const preProbe = deps.preProbe ?? ((u) => preProbeUpcoming(u));

  let scope: PreProbeScope;
  try {
    scope = await resolveScope(userId);
  } catch (err) {
    console.error("[preprobe-scheduler] could not read scope", err);
    return { delayMs: PREPROBE_DISABLED_POLL_MS, ran: false, skipped: "settings-error" };
  }

  // `off` is the user's explicit opt-out: no ranking, no probing.
  if (scope === "off") {
    return { delayMs: PREPROBE_DISABLED_POLL_MS, ran: false, skipped: "off" };
  }

  // Never compete with a viewer. Skip the entire speculative pass and retry
  // soon so probing resumes shortly after playback ends.
  if (isForeground()) {
    return { delayMs: PREPROBE_FOREGROUND_RETRY_MS, ran: false, skipped: "foreground" };
  }

  try {
    // Warm and rank the candidate pools first so the probe has something fresh
    // to measure, then measure. A failure in either half logs and reschedules
    // rather than taking the timer down.
    await preRank(userId);
    const result = await preProbe(userId);
    console.log(
      `[preprobe-scheduler] scope ${result.scope} · probed ${result.probed.length} · fresh ${result.skippedFresh.length} · live ${result.skippedLive.length}${result.capped ? " · capped" : ""}`,
    );
    return { delayMs: PREPROBE_INTERVAL_MS, ran: true, result };
  } catch (err) {
    console.error("[preprobe-scheduler] pass failed", err);
    return { delayMs: PREPROBE_INTERVAL_MS, ran: false };
  }
}

function schedule(delayMs: number): void {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    void runPreProbeTick().then((o) => schedule(o.delayMs));
  }, delayMs);
  // Do not hold the process open purely for this timer.
  s.timer.unref?.();
}

/** Idempotent: safe to call on every module evaluation. */
export function startPreProbeScheduler(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  schedule(PREPROBE_STARTUP_DELAY_MS);
  console.log("[preprobe-scheduler] pre-probe scheduler armed");
}
