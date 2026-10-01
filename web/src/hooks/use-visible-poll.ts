import { useEffect, useRef } from "react";
import { startVisiblePoller } from "@/lib/visible-poller";

/**
 * The one way a page polls. Polls only while the page is visible, schedules
 * the next tick only after the previous one settles (a slow server never
 * stacks requests), and polls at once when the page becomes visible again.
 * `useApiQuery`'s `refreshMs` runs on this too.
 *
 * `poll`, `intervalMs` and `paused` are read on every tick, so they can change
 * without restarting the poller. The first load is the caller's: this only
 * schedules what comes after it.
 */
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
  const intervalRef = useRef(intervalMs);
  const pausedRef = useRef(paused);
  useEffect(() => {
    pollRef.current = poll;
    intervalRef.current = intervalMs;
    pausedRef.current = paused;
  });

  const active = enabled && intervalMs > 0;
  useEffect(() => {
    if (!active) return;
    return startVisiblePoller({
      poll: () => pollRef.current(),
      intervalMs: () => intervalRef.current,
      isPaused: () => pausedRef.current,
    });
    // A new interval restarts the wait so the change applies now, not after
    // the old (perhaps 20s) timer fires.
  }, [active, intervalMs, paused]);
}
