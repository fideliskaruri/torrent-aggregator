type TimerHandle = ReturnType<typeof setTimeout>;

type SchedulerEntry<T> = {
  pending: T | undefined;
  timer: TimerHandle | undefined;
  inFlight: Promise<void> | undefined;
  lastStartedAt: number;
};

export function createSnapshotScheduler<K, T>(options: {
  intervalMs: number;
  persist: (key: K, value: T) => Promise<void>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const entries = new Map<K, SchedulerEntry<T>>();

  function entryFor(key: K): SchedulerEntry<T> {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: SchedulerEntry<T> = {
      pending: undefined,
      timer: undefined,
      inFlight: undefined,
      lastStartedAt: Number.NEGATIVE_INFINITY,
    };
    entries.set(key, created);
    return created;
  }

  function arm(key: K, entry: SchedulerEntry<T>): void {
    if (entry.timer || entry.inFlight || entry.pending === undefined) return;
    const elapsed = now() - entry.lastStartedAt;
    const delay = Math.max(0, options.intervalMs - elapsed);
    entry.timer = setTimer(() => {
      entry.timer = undefined;
      void flush(key, entry).catch(() => {
        // Ordinary progress snapshots are best-effort. Terminal writes use the
        // explicit finalizer and surface their failures separately.
      });
    }, delay);
  }

  async function flush(key: K, entry: SchedulerEntry<T>): Promise<void> {
    if (entry.inFlight || entry.pending === undefined) return;
    const value = entry.pending;
    entry.pending = undefined;
    entry.lastStartedAt = now();
    const write = options.persist(key, value);
    entry.inFlight = write;
    try {
      await write;
    } finally {
      entry.inFlight = undefined;
      if (entry.pending !== undefined) arm(key, entry);
      else if (!entry.timer) entries.delete(key);
    }
  }

  return {
    schedule(key: K, value: T): void {
      const entry = entryFor(key);
      entry.pending = value;
      arm(key, entry);
    },

    async cancelAndDrain(key: K): Promise<void> {
      const entry = entries.get(key);
      if (!entry) return;
      if (entry.timer) {
        clearTimer(entry.timer);
        entry.timer = undefined;
      }
      entry.pending = undefined;
      if (entry.inFlight) {
        try {
          await entry.inFlight;
        } catch {
          // The final durable write owns error reporting and retry semantics.
        }
      }
      if (entry.timer) clearTimer(entry.timer);
      entry.pending = undefined;
      entries.delete(key);
    },

    size(): number {
      return entries.size;
    },
  };
}
