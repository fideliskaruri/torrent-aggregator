/**
 * The background automation scheduler.
 *
 * Until this existed, `runUserAutomation` was reachable *only* from
 * `POST /api/automation/run` — so nothing ever downloaded on its own, while
 * the watchlist cheerfully rendered "· monitoring" next to every show. This
 * closes that gap and makes the label true.
 *
 * Deliberately opt-in (`automationIntervalMinutes` is NULL by default). A timer
 * that grabs torrents and writes to disk is not something to switch on behind
 * someone's back, and an existing install must not change behaviour merely
 * because the feature shipped.
 *
 * Failure modes this guards against, all of which are easy to hit:
 *
 * - **Duplicate schedulers.** Next dev/HMR re-evaluates modules, and
 *   `register()` can fire more than once. Two timers means two concurrent
 *   automation runs, which means duplicate grabs. A `globalThis` singleton
 *   survives module re-evaluation, which a module-level variable does not.
 * - **Overlapping runs.** A run that takes longer than the interval would
 *   stack under `setInterval`. This self-schedules with `setTimeout` *after*
 *   each run settles, so the gap is measured between runs, never between
 *   starts. `runUserAutomation` also takes a DB run-lock, so even a second
 *   process cannot double-grab.
 * - **A throwing run killing the process.** Every run is wrapped; a failure
 *   logs and reschedules rather than taking the server down.
 * - **Settings changes needing a restart.** The interval is re-read from the
 *   database before every sleep, so turning the timer on, off, or changing its
 *   period takes effect on the next tick without a restart.
 * - **Running in the wrong runtime.** Edge/browser bundles have no timers we
 *   want and no Prisma; the caller gates on `NEXT_RUNTIME === "nodejs"`.
 */
import prisma from "@/lib/prisma";
import { runUserAutomation } from "./runner";

/** Never hammer indexers, whatever is in the database. */
const MIN_INTERVAL_MINUTES = 15;
/** How long to wait before re-reading settings while the timer is disabled. */
const DISABLED_POLL_MS = 5 * 60 * 1000;
/** Give the server a moment to finish booting before the first run. */
const STARTUP_DELAY_MS = 30 * 1000;

const GLOBAL_KEY = Symbol.for("torrentflow.automation.scheduler");

type SchedulerState = { started: boolean; timer: NodeJS.Timeout | null };

function state(): SchedulerState {
  const g = globalThis as unknown as Record<symbol, SchedulerState | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { started: false, timer: null };
  return g[GLOBAL_KEY]!;
}

/**
 * Resolve the configured interval in ms, or null when automation is off.
 * Values below the floor are raised rather than honoured.
 */
async function resolveIntervalMs(): Promise<{
  userId: string;
  intervalMs: number;
} | null> {
  const row = await prisma.clientSettings.findFirst({
    where: { automationIntervalMinutes: { gt: 0 } },
    select: { userId: true, automationIntervalMinutes: true },
  });
  if (!row?.automationIntervalMinutes) return null;
  const minutes = Math.max(MIN_INTERVAL_MINUTES, row.automationIntervalMinutes);
  return { userId: row.userId, intervalMs: minutes * 60_000 };
}

async function tick(): Promise<number> {
  let config: { userId: string; intervalMs: number } | null = null;
  try {
    config = await resolveIntervalMs();
  } catch (err) {
    console.error("[scheduler] could not read settings", err);
    return DISABLED_POLL_MS;
  }

  if (!config) return DISABLED_POLL_MS;

  try {
    const summary = await runUserAutomation(config.userId);
    const { sent, skipped, failed, checked } = summary.library;
    console.log(
      `[scheduler] checked ${checked} · sent ${sent} · skipped ${skipped} · failed ${failed}`,
    );
  } catch (err) {
    // A dead client or an indexer outage must not stop the timer.
    console.error("[scheduler] run failed", err);
  }

  return config.intervalMs;
}

function schedule(delayMs: number): void {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    void tick().then(schedule);
  }, delayMs);
  // Do not hold the process open purely for this timer.
  s.timer.unref?.();
}

/** Idempotent: safe to call on every module evaluation. */
export function startAutomationScheduler(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  schedule(STARTUP_DELAY_MS);
  console.log("[scheduler] automation scheduler armed");
}
