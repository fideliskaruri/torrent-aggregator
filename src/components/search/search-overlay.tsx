"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Search, X } from "lucide-react";
import { TitleResultsList } from "./title-results-list";
import { ArtifactRow } from "./artifact-row";
import { titlesFromSearchHits } from "./title-search";
import type { TitleResult } from "./group-titles";
import type { TorrentResult } from "@/lib/torrents/types";
import {
  DEFAULT_SCOPE_ID,
  SEARCH_SCOPES,
  type SearchScopeId,
} from "@/lib/torrents/search-scopes";
import {
  placeholderFor,
  searchDisplayFor,
  searchErrorMessage,
  searchRequestFor,
} from "./search-overlay-state";
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
 * Two flows behind one input, chosen by scope:
 *
 *  - **Films & TV** (default) — TMDB discovery. Poster cards link to the title
 *    page; torrents never run from this surface. Unchanged.
 *  - **Music, games, software, books, anime** — these have no metadata provider
 *    behind them, so the release *is* the artifact and rows are actionable
 *    here. Sending the owner to a "title page" for an album that has no title
 *    record would be a dead end, which is why the two flows differ.
 *
 * See `search-scopes.ts` for why that split exists rather than one uniform
 * results list.
 */
export function SearchOverlay() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState<SearchScopeId>(DEFAULT_SCOPE_ID);
  const [titles, setTitles] = useState<TitleResult[]>([]);
  const [releases, setReleases] = useState<TorrentResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Drives a subtle scale+fade entrance; flipped on the frame after mount.
  const [entered, setEntered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, []);

  // Open on the global event; set the query if one was passed. Focus is handled
  // by a dedicated effect below, once the input is actually mounted.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ query?: string }>).detail;
      setOpen(true);
      if (detail?.query) {
        setQuery(detail.query);
        runSearch(detail.query, DEFAULT_SCOPE_ID);
      }
    }
    window.addEventListener(OPEN_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(OPEN_EVENT, onOpen as EventListener);
    // runSearch is stable enough for this listener's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the input once the overlay has actually rendered.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Esc closes from anywhere while open.
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

  const runSearch = useCallback(
    (q: string, scope: SearchScopeId) => {
      const request = searchRequestFor(scope, q);
      if (!request) {
        setTitles([]);
        setReleases([]);
        setError(null);
        setLoading(false);
        return;
      }
      const reqId = ++reqIdRef.current;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      setError(null);

      fetch(request.url, { signal: ac.signal })
        .then(async (res) => {
          const json = (await res.json().catch(() => null)) as {
            results?: unknown;
            error?: string | null;
          } | null;
          if (reqId !== reqIdRef.current) return;

          if (!res.ok) {
            // A refusal is not an empty corpus. Saying "no results" for a
            // rate-limited request sends the owner hunting for a spelling
            // mistake that was never the problem.
            setTitles([]);
            setReleases([]);
            setError(searchErrorMessage(res.status, json));
            setLoading(false);
            return;
          }

          if (request.kind === "work") {
            setReleases([]);
            setTitles(
              titlesFromSearchHits(
                (json?.results ?? []) as Parameters<typeof titlesFromSearchHits>[0],
              ),
            );
          } else {
            setTitles([]);
            setReleases(((json?.results ?? []) as TorrentResult[]) ?? []);
          }
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (reqId !== reqIdRef.current) return;
          setTitles([]);
          setReleases([]);
          setError("Could not reach the server.");
          setLoading(false);
        });
    },
    [],
  );

  function onQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      abortRef.current?.abort();
      setTitles([]);
      setReleases([]);
      setError(null);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(value, scopeId), 220);
  }

  /**
   * Switching scope re-runs immediately rather than waiting for another
   * keystroke: the owner has already told us what they want by typing, and
   * picking "Music" is itself the instruction to search again.
   */
  function onScopeChange(next: SearchScopeId) {
    if (next === scopeId) return;
    setScopeId(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setTitles([]);
    setReleases([]);
    setError(null);
    if (query.trim().length >= 2) runSearch(query, next);
    else setLoading(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  /**
   * Every keyboard-reachable result, whichever flow rendered them.
   *
   * A title card is one focusable link; an artifact row's equivalent is its
   * primary Download button. Without the second selector, arrow-key navigation
   * silently stopped working the moment the owner picked Music — the palette
   * would look identical and simply not respond, which is the worst kind of
   * regression to notice.
   */
  function resultTargets(): HTMLElement[] {
    return Array.from(
      resultsRef.current?.querySelectorAll<HTMLElement>(
        '[data-card-target="title"], [data-artifact-row] [data-action="download"]',
      ) ?? [],
    );
  }

  function focusCard(index: number) {
    const cards = resultTargets();
    if (!cards.length) return;
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
      // Enter from the input opens the top result. For films that navigates to
      // the title page; for an artifact it focuses Download rather than firing
      // it — starting a download on a stray Enter is not a recoverable action.
      const [first] = resultTargets();
      if (!first) return;
      e.preventDefault();
      if (first.closest('[data-card-target="title"]')) first.click();
      else first.focus();
    }
  }

  function onResultsKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "j" && e.key !== "k")
      return;
    // `j`/`k` are text in a search box, but this handler only ever sees keys
    // that reached the results region, so they are safe as vim-style motions.
    const cards = resultTargets();
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

  // Selecting a title navigates; close the overlay so it doesn't linger.
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
              placeholder={placeholderFor(scopeId)}
              aria-label="Search"
              autoComplete="off"
              spellCheck={false}
              className="h-11 w-full min-w-0 bg-transparent text-base text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)] [&::-webkit-search-cancel-button]:appearance-none"
            />
            <button
              type="button"
              onClick={close}
              aria-label="Close search"
              className="-mr-1 flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors duration-200 ease-out motion-reduce:transition-none hover:bg-[var(--bg-muted)] hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/*
            Scope chips. A horizontal scroller rather than a wrapping grid so the
            row's height never changes as scopes are added — the input must not
            jump under the cursor mid-type. `role="tablist"` because these select
            between views of one search, which is what a screen reader needs to
            hear; the results region is labelled by the active chip.
          */}
          <div
            role="tablist"
            aria-label="What to search"
            className="mt-2.5 -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {SEARCH_SCOPES.map((s) => {
              const active = s.id === scopeId;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  id={`search-scope-${s.id}`}
                  aria-selected={active}
                  aria-controls="search-results-region"
                  title={s.blurb}
                  onClick={() => onScopeChange(s.id)}
                  className={cn(
                    "shrink-0 touch-manipulation rounded-full border px-3 text-[13px] transition-colors duration-200 ease-out motion-reduce:transition-none",
                    // 44px on touch, tighter on pointer devices — the repo-wide
                    // convention, so the chip row does not eat the palette.
                    "min-h-[44px] sm:min-h-8",
                    active
                      ? "border-[var(--accent)] bg-[var(--accent-dim)] font-medium text-[var(--text)]"
                      : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
                  )}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          ref={resultsRef}
          id="search-results-region"
          role="tabpanel"
          aria-labelledby={`search-scope-${scopeId}`}
          onKeyDown={onResultsKeyDown}
          onClick={onResultsClick}
          className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4"
        >
          {(() => {
            const display = searchDisplayFor({
              scopeId,
              query,
              loading,
              error,
              resultCount: titles.length + releases.length,
            });

            switch (display.state) {
              case "prompt":
              case "typing":
                // Never a blank panel: the scope says what it holds, so picking
                // "Books" and pausing still teaches what a good query looks like.
                return (
                  <div className="px-1 py-10 text-center">
                    <p className="text-[13px] text-[var(--text-secondary)]">
                      {display.scope.blurb}
                    </p>
                    <p className="mt-1.5 text-[12px] text-[var(--text-tertiary)]">
                      Try “{display.scope.placeholder.split(",")[0].trim()}”
                    </p>
                  </div>
                );

              case "error":
                return (
                  <div
                    className="px-1 py-10 text-center"
                    role="status"
                    data-search-error
                  >
                    <p className="text-[13px] text-[var(--text-secondary)]">
                      {display.message}
                    </p>
                  </div>
                );

              case "empty":
                return (
                  <div className="px-1 py-10 text-center" data-results-empty>
                    <p className="text-[13px] text-[var(--text-secondary)]">
                      Nothing in {display.scope.label} matched “{display.query}”.
                    </p>
                    <p className="mt-1.5 text-[12px] text-[var(--text-tertiary)]">
                      Try another spelling, or a different category above.
                    </p>
                  </div>
                );

              case "loading":
                return display.scope.kind === "work" ? (
                  <TitleResultsList
                    titles={[]}
                    loading
                    query={query}
                    skeletonCount={4}
                  />
                ) : (
                  <p
                    className="px-1 py-10 text-center text-[13px] text-[var(--text-tertiary)]"
                    aria-busy
                  >
                    Searching {display.scope.label.toLowerCase()}…
                  </p>
                );

              case "results":
                return display.kind === "work" ? (
                  <TitleResultsList
                    titles={titles}
                    loading={loading}
                    query={query}
                    skeletonCount={4}
                  />
                ) : (
                  <div data-results-list>
                    {/* Where these land, said before the download starts —
                        not knowing has been a recurring complaint. */}
                    {display.scope.downloadCategory ? (
                      <p className="pb-2 text-[12px] text-[var(--text-tertiary)]">
                        Downloads go to your {display.scope.downloadCategory}{" "}
                        folder.
                      </p>
                    ) : null}
                    {releases.map((t) => (
                      <ArtifactRow
                        key={`${t.source}:${t.infoHash ?? t.sourceUrl ?? t.title}`}
                        torrent={t}
                        scope={display.scope}
                      />
                    ))}
                  </div>
                );
            }
          })()}
        </div>
      </div>
    </div>
  );
}
