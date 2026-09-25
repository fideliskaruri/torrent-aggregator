import { useEffect, useRef, useState } from "react";
import {
  LOADING_MIN_VISIBLE_MS,
  LOADING_SHOW_DELAY_MS,
} from "./loading-state";

export function useStableLoading(
  active: boolean,
  {
    delayMs = LOADING_SHOW_DELAY_MS,
    minVisibleMs = LOADING_MIN_VISIBLE_MS,
    terminal = !active,
  }: {
    delayMs?: number;
    minVisibleMs?: number;
    terminal?: boolean;
  } = {},
) {
  const [visible, setVisible] = useState(false);
  const visibleSinceRef = useRef<number | null>(null);

  useEffect(() => {
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    if (active) {
      showTimer = setTimeout(() => {
        visibleSinceRef.current = Date.now();
        setVisible(true);
      }, delayMs);
    } else {
      const visibleSince = visibleSinceRef.current;
      const elapsed = visibleSince == null ? minVisibleMs : Date.now() - visibleSince;
      const wait = terminal ? 0 : Math.max(0, minVisibleMs - elapsed);
      hideTimer = setTimeout(() => {
        setVisible(false);
        visibleSinceRef.current = null;
      }, wait);
    }

    return () => {
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [active, delayMs, minVisibleMs, terminal]);

  return visible;
}
