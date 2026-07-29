"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Search, X } from "lucide-react";
import type { SearchResponse } from "@/lib/torrents/types";
import { groupTitles } from "./group-titles";
import { TitleResultsList } from "./title-results-list";
import { buildSearchQuery, DEFAULT_PAGE_SIZE } from "./pagination";
import { cn } from "@/lib/utils";

/** The window event that asks the overlay to open. */
const OPEN_EVENT = "tf:open-search";

/**
 * Open the search palette from anywhere — the `/` shortcut and the header's
 * Search affordance both call this. A window event keeps the trigger decoupled
 * from where the overlay is mounted, so nothing has to thread a callback down
 * the tree.
 */
export function openSearchOverlay(initialQuery?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(OPEN_EVENT, { detail: { query: initialQuery ?? "" } }),
  );
}

/**
 * Search as an overlay, not a page.
 *
 * Pressing `/` anywhere (or clicking the header Search) opens a single focused
 * input with live title cards rendered inline as you type — no navigation, no
 * second input. Esc closes it. Selecting a card navigates to that title page;
 * opening/closing the palette itself never changes the route.
 *
 * `/search` still exists as a deep-link fallback, but this is the primary UX.
 */
export function SearchOverlay() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // Drives a subtle scale+fade entrance; flipped on the frame after mount.
  const [entered, setEntered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // Open on the global event; set the query if one was passed. Focus is handled
  // by a dedicated effect below, once the input is actually mounted.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ query?: string }>).detail;
      setOpen(true);
      if (detail?.query) {
        setQuery(detail.query);
        runSearch(detail.query);
      }
    }
    window.addEventListener(OPEN_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(OPEN_EVENT, onOpen as EventListener);
    // runSearch is stable enough for this listener's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the input once the overlay has actually rendered. Doing this in an
  // effect (not the open event) guarantees the input ref exists — scheduling
  // focus straight from the event races React's commit.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Play a subtle scale+fade entrance the frame after the overlay mounts, and
  // reset it on close. prefers-reduced-motion users get no animation because
  // the transition classes carry `motion-reduce:transition-none`, so the panel
  // simply appears — this effect stays inert for them.
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Esc closes from anywhere while open — a global listener means focus does not
  // have to be inside the palette for the key to work.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setData(null);
      setLoading(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    const qs = buildSearchQuery({
      query: trimmed,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      category: "all",
    });
    fetch(`/api/search?${qs}`)
      .then((res) => res.json())
      .then((json: SearchResponse) => {
        if (reqId !== reqIdRef.current) return;
        setData(json);
        setLoading(false);
      })
      .catch(() => {
        if (reqId !== reqIdRef.current) return;
        setData(null);
        setLoading(false);
      });
  }, []);

  function onQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setData(null);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(value), 220);
  }

  const titles = useMemo(
    () => (data?.results?.length ? groupTitles(data.results) : []),
    [data],
  );

  function focusCard(index: number) {
    const cards = resultsRef.current?.querySelectorAll<HTMLElement>(
      '[data-card-target="title"]',
    );
    if (!cards || !cards.length) return;
    const i = Math.max(0, Math.min(index, cards.length - 1));
    cards[i].focus();
    cards[i].scrollIntoView({ block: "nearest" });
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusCard(0);
    } else if (e.key === "Enter") {
      // Enter from the input opens the top (best-match) result.
      const first = resultsRef.current?.querySelector<HTMLElement>(
        '[data-card-target="title"]',
      );
      if (first) {
        e.preventDefault();
        first.click();
      }
    }
  }

  // Arrow-key run through the result cards; ArrowUp from the top returns to
  // the input. Enter is handled by each card link itself.
  function onResultsKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "j" && e.key !== "k")
      return;
    const cards = Array.from(
      resultsRef.current?.querySelectorAll<HTMLElement>(
        '[data-card-target="title"]',
      ) ?? [],
    );
    if (!cards.length) return;
    const focused = document.activeElement as HTMLElement | null;
    const idx = cards.findIndex((c) => c === focused || c.contains(focused));
    const down = e.key === "ArrowDown" || e.key === "j";
    e.preventDefault();
    if (!down && idx <= 0) {
      inputRef.current?.focus();
      return;
    }
    focusCard(down ? idx + 1 : idx - 1);
  }

  // Selecting a title navigates to its page; the overlay must not linger on top
  // of the new route. The title link is the only element marked
  // data-card-target — Play, Download and the expander are siblings of it, so a
  // click on a control never matches and never closes. This also covers the
  // Enter path, which reaches the same link via .click().
  function onResultsClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-card-target="title"]')) {
      close();
    }
  }

  if (!open) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[100] flex justify-center px-4 pt-[8vh] transition-opacity duration-200 ease-out motion-reduce:transition-none sm:px-6 sm:pt-[12vh]",
        entered ? "opacity-100" : "opacity-0",
      )}
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      data-search-overlay
    >
      {/* Backdrop — click to dismiss. */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={close}
        aria-hidden
      />

      <div
        className={cn(
          "relative z-[1] flex max-h-[84vh] w-full max-w-3xl origin-top flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-md)] transition-transform duration-200 ease-out motion-reduce:transition-none",
          entered ? "scale-100" : "scale-[0.98]",
        )}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        {/* Header — the input lives in an inset shell whose focus ring is a soft
            glow on the bar itself. Being inset, the 3px ring has room to render
            fully and is never clipped by the modal's rounded, overflow-hidden
            edge (the defect the old container-ring had). */}
        <div className="border-b border-[var(--border)] p-3">
          <div
            role="search"
            className="flex items-center gap-2.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 transition-[border-color,box-shadow] duration-200 ease-out motion-reduce:transition-none focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-dim)]"
          >
            <Search
              className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]"
              aria-hidden
            />
            <input
              ref={inputRef}
              type="search"
              data-search-input="true"
              data-search-overlay-input="true"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search for something to watch…"
              aria-label="Search"
              autoComplete="off"
              spellCheck={false}
              className="h-11 w-full min-w-0 bg-transparent text-base text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)] [&::-webkit-search-cancel-button]:appearance-none"
            />
            <button
              type="button"
              onClick={close}
              aria-label="Close search"
              className="-mr-1 flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors duration-200 ease-out motion-reduce:transition-none hover:bg-[var(--bg-muted)] hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          ref={resultsRef}
          onKeyDown={onResultsKeyDown}
          onClick={onResultsClick}
          className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4"
        >
          {query.trim().length < 2 ? (
            <p className="px-1 py-10 text-center text-[13px] text-[var(--text-tertiary)]">
              Type to search across everything you can watch.
            </p>
          ) : (
            <TitleResultsList
              titles={titles}
              loading={loading}
              query={query}
              skeletonCount={4}
            />
          )}
        </div>
      </div>
    </div>
  );
}
