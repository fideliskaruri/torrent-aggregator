import { useLayoutEffect, useRef, useState } from "react";

const FOLD_PREVIEW_LABEL = 1;
const FOLD_WORDMARK = 2;
const FOLD_SEARCH_LABEL = 3;
const FOLD_TIGHT_LINKS = 4;
const FOLD_OVERFLOW = 5;

export const HEADER_FOLD = {
  wordmark: FOLD_WORDMARK,
  searchLabel: FOLD_SEARCH_LABEL,
  previewLabel: FOLD_PREVIEW_LABEL,
  tightLinks: FOLD_TIGHT_LINKS,
  overflow: FOLD_OVERFLOW,
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
