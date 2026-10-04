import { useLayoutEffect, useRef, useState } from "react";

export const HEADER_FOLD = {
  wordmark: 2,
  searchLabel: 3,
  previewLabel: 1,
  tightLinks: 4,
  overflow: 5,
};

export function useHeaderFold(contentKey: string, maxFold: number) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const [fold, setFold] = useState(0);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const [, setNavTick] = useState(0);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setNavTick((n) => n + 1));
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);

  const measuredKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = `${width}|${contentKey}`;
    if (measuredKey.current !== key) {
      measuredKey.current = key;
      if (fold !== 0) {
        setFold(0);
        return;
      }
    }
    const row = rowRef.current;
    const nav = navRef.current;
    if (!row || !nav || nav.offsetParent === null) return;
    if ((nav.scrollWidth > nav.clientWidth || row.scrollWidth > row.clientWidth) && fold < maxFold) {
      setFold(fold + 1);
    }
  });

  return { rowRef, navRef, fold };
}
