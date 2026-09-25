/**
 * Opt-in phase timing for a single request.
 *
 * Search latency complaints were impossible to act on because the only number
 * anyone had was "the whole request took 16 seconds". Measuring a route
 * in-process with a script measures a different thing than the route: the
 * script skips auth, settings reads and serialization. This records the real
 * boundaries inside the handler, and stays silent unless `SEARCH_TIMING=1`, so
 * production behaviour and output are unchanged.
 */

export const PHASE_TIMING_ENABLED = process.env.SEARCH_TIMING === "1";

export interface PhaseTimer {
  /** Records `label` as ending now, measured from the previous mark. */
  mark(label: string): void;
  /** Records an already-measured duration (for concurrent work). */
  record(label: string, ms: number): void;
  /** Times one awaited phase without disturbing the sequential marks. */
  step<T>(label: string, run: () => Promise<T>): Promise<T>;
  /** Emits the collected marks on one line. No-op when disabled. */
  done(extra?: Record<string, unknown>): void;
}

const NOOP: PhaseTimer = {
  mark() {},
  record() {},
  async step(_label, run) {
    return run();
  },
  done() {},
};

export function createPhaseTimer(scope: string): PhaseTimer {
  if (!PHASE_TIMING_ENABLED) return NOOP;

  const start = performance.now();
  let last = start;
  const marks: string[] = [];

  const record = (label: string, ms: number) => {
    marks.push(`${label}=${Math.round(ms)}ms`);
  };

  return {
    mark(label) {
      const now = performance.now();
      record(label, now - last);
      last = now;
    },
    record,
    async step(label, run) {
      const t0 = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        record(label, now - t0);
        last = now;
      }
    },
    done(extra) {
      const total = Math.round(performance.now() - start);
      const tail = extra
        ? " " +
          Object.entries(extra)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(" ")
        : "";
      console.log(`[timing] ${scope} total=${total}ms ${marks.join(" ")}${tail}`);
    },
  };
}
