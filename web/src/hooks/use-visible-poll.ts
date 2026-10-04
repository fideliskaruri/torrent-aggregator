import { useEffect, useRef } from "react";

export function useVisiblePoll(
  poll: () => Promise<void> | void,
  {
    intervalMs,
    enabled = true,
    paused = false,
  }: {
    intervalMs: number;
    enabled?: boolean;
    paused?: boolean;
  },
) {
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0 || typeof document === "undefined") return;
    let stopped = false;
    let running = false;
    let refreshWhenVisible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState === "visible";
    const clear = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clear();
      if (!stopped && !paused && visible()) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    };
    const tick = async () => {
      if (stopped || running || paused || !visible()) return;
      running = true;
      clear();
      try {
        await pollRef.current();
      } finally {
        running = false;
        if (refreshWhenVisible && visible() && !paused) {
          refreshWhenVisible = false;
          void tick();
          return;
        }
        refreshWhenVisible = false;
        schedule();
      }
    };
    const onVisibility = () => {
      if (!visible()) {
        clear();
      } else if (running) {
        refreshWhenVisible = true;
      } else {
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, paused]);
}
