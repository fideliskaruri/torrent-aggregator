/**
 * One warm probe at a time, per file.
 *
 * Warming is speculative work nobody asked for, so it is not allowed to
 * multiply: a player that re-renders, or two tabs watching the same show, must
 * not queue several ffprobes against the same file. Callers share the single
 * in-flight promise instead.
 *
 * Deliberately tiny — no queue, no timers, no cooldown table. The probe itself
 * is already bounded, and the cache makes the second call cheap.
 */
const inFlight = new Map<string, Promise<unknown>>();

export function warmProbeKey(infoHash: string, filePath: string): string {
  return `${infoHash.toLowerCase()}|${filePath}`;
}

/**
 * Run `task` for `key`, or join the run already in flight for it.
 *
 * The entry is removed once the run settles, so a later warm of the same file
 * (after the cache was evicted, say) is free to run again.
 */
export function runWarmProbe<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const started = (async () => task())().finally(() => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

/** Test seam: how many warm probes are currently in flight. */
export function warmProbesInFlight(): number {
  return inFlight.size;
}
