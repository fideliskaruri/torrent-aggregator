import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { documentTitleFor } from "@/hooks/use-document-title";
import { SEARCH_HREF } from "@/lib/navigation";
import {
  parseWorkSearchScope,
  type WorkSearchScope,
} from "@/lib/search/work-search";
import { OPEN_SEARCH_EVENT } from "./search-overlay-event";
import { searchUrlFor } from "./search-overlay-state";
import type { TitleSearchState } from "./use-title-search";

function historyIndex(): number {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : 0;
}

export function useSearchOverlayController(search: TitleSearchState) {
  const pathname = useLocation().pathname;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const tabKeyNavRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(false);

  const close = useCallback(() => {
    const wasOpen = openRef.current;
    openRef.current = false;
    search.deactivate();
    setOpen(false);
    if (!wasOpen || window.location.pathname !== SEARCH_HREF) return;
    if (historyIndex() > 0) window.history.back();
    else void navigate("/", { replace: true });
  }, [navigate, search.deactivate]);

  useEffect(() => {
    function onOpen(event: Event) {
      const detail = (
        event as CustomEvent<{
          query?: string;
          preserveUrl?: boolean;
          category?: WorkSearchScope;
        }>
      ).detail;
      if (!openRef.current) {
        openerRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!detail?.preserveUrl && window.location.pathname !== SEARCH_HREF) {
          const category = parseWorkSearchScope(detail?.category);
          window.history.pushState(
            {
              key: Math.random().toString(36).slice(2, 10),
              idx: historyIndex() + 1,
            },
            "",
            searchUrlFor(detail?.query ?? "", category),
          );
        }
      }
      openRef.current = true;
      setOpen(true);
      search.openSearch(detail?.query ?? "", detail?.category);
    }
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
  }, [search.openSearch]);

  useEffect(() => {
    if (!open || window.location.pathname === SEARCH_HREF) return;
    openerRef.current = null;
    const frame = requestAnimationFrame(close);
    return () => cancelAnimationFrame(frame);
  }, [close, open, pathname]);

  useEffect(() => {
    if (!open) return;
    const previous = document.title;
    const applied = documentTitleFor(SEARCH_HREF);
    document.title = applied;
    return () => {
      if (document.title === applied) document.title = previous;
    };
  }, [open]);

  const resultTargets = useCallback(() => {
    return Array.from(
      resultsRef.current?.querySelectorAll<HTMLElement>('[data-card-target="title"]') ?? [],
    );
  }, []);

  const focusCard = useCallback((index: number) => {
    const cards = resultTargets();
    if (!cards.length) return;
    const target = cards[Math.max(0, Math.min(index, cards.length - 1))];
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }, [resultTargets]);

  const onInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusCard(0);
    } else if (event.key === "Enter") {
      const first = resultTargets()[0];
      if (!first) return;
      event.preventDefault();
      first.click();
    }
  }, [focusCard, resultTargets]);

  const onResultsKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "j", "k"].includes(event.key)) return;
    const cards = resultTargets();
    if (!cards.length) return;
    const focused = document.activeElement as HTMLElement | null;
    const index = cards.findIndex((card) => card === focused || card.contains(focused));
    const down = event.key === "ArrowDown" || event.key === "j";
    event.preventDefault();
    if (!down && index <= 0) {
      inputRef.current?.focus();
      return;
    }
    focusCard(down ? index + 1 : index - 1);
  }, [focusCard, resultTargets]);

  const onScopeChange = useCallback((value: string) => {
    search.onScopeChange(value as WorkSearchScope);
    if (tabKeyNavRef.current) tabKeyNavRef.current = false;
    else requestAnimationFrame(() => inputRef.current?.focus());
  }, [search.onScopeChange]);

  const onScopeKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      tabKeyNavRef.current = true;
    }
  }, []);

  return {
    open,
    close,
    inputRef,
    resultsRef,
    openerRef,
    onInputKeyDown,
    onResultsKeyDown,
    onScopeChange,
    onScopeKeyDown,
  };
}

export type SearchOverlayController = ReturnType<typeof useSearchOverlayController>;
