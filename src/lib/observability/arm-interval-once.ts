/**
 * Arm a module-scope interval exactly once per process.
 *
 * Next evaluates a module once per route bundle that imports it, and again on
 * every dev HMR pass. A bare `setInterval` at module scope therefore stacked a
 * new timer each time, each closed over a *different* copy of the map it was
 * meant to sweep — so the old maps were pinned alive by their own sweeper and
 * the wakeups multiplied. Unref'ing hides the process-exit symptom but not the
 * leak. This is the same `globalThis` + `Symbol.for` singleton pattern the
 * schedulers use, factored out so every periodic sweep gets it by construction.
 *
 * The timer is unref'd: a housekeeping sweep must never keep Node alive.
 */
export function armIntervalOnce(
  key: symbol,
  intervalMs: number,
  tick: () => void,
): { armed: boolean; timer: unknown } {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const existing = g[key];
  if (existing) return { armed: false, timer: existing };
  if (typeof setInterval !== "function" || !(intervalMs > 0)) {
    return { armed: false, timer: null };
  }
  const timer = setInterval(() => {
    try {
      tick();
    } catch {
      // A sweep that throws must not take down the process it runs in.
    }
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  g[key] = timer;
  return { armed: true, timer };
}

/** The timer currently armed under `key`, if any. Diagnostics/tests only. */
export function armedInterval(key: symbol): unknown {
  return (globalThis as unknown as Record<symbol, unknown>)[key] ?? null;
}

/** Test-only: clear and forget the timer armed under `key`. */
export function disarmInterval(key: symbol): boolean {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const timer = g[key];
  if (!timer) return false;
  try {
    clearInterval(timer as ReturnType<typeof setInterval>);
  } catch {
    // Already cleared; forgetting it is still the right outcome.
  }
  delete g[key];
  return true;
}
