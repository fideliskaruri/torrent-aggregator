type Timer = ReturnType<typeof setTimeout>;

type VisiblePollerDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

export interface VisiblePollerOptions {
  poll: () => Promise<void> | void;
  intervalMs: () => number;
  isPaused?: () => boolean;
  document?: VisiblePollerDocument;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer | undefined) => void;
}

export type StopVisiblePoller = () => void;

/**
 * Poll only while a viewer can see the page, and schedule the next tick only
 * after the previous one settles.
 */
export function startVisiblePoller({
  poll,
  intervalMs,
  isPaused = () => false,
  document: doc = globalThis.document,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: VisiblePollerOptions): StopVisiblePoller {
  let stopped = false;
  let running = false;
  let timer: Timer | undefined;

  const visible = () => doc.visibilityState === "visible";

  const clear = () => {
    clearTimer(timer);
    timer = undefined;
  };

  const schedule = () => {
    clear();
    if (stopped || isPaused() || !visible()) return;
    timer = setTimer(() => {
      void tick();
    }, intervalMs());
  };

  const tick = async () => {
    if (stopped || running || isPaused() || !visible()) return;
    running = true;
    clear();
    try {
      await poll();
    } finally {
      running = false;
      schedule();
    }
  };

  const onVisibilityChange = () => {
    if (stopped) return;
    if (!visible()) {
      clear();
      return;
    }
    void tick();
  };

  doc.addEventListener("visibilitychange", onVisibilityChange);
  schedule();

  return () => {
    stopped = true;
    clear();
    doc.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
