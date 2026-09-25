import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router";
import { Search, X, AlertTriangle } from "lucide-react";
import { TitleResultsList } from "./title-results-list";
import { titlesFromSearchHits } from "./title-search";
import { partialResultsNotice } from "./partial-results-notice";
import type { TitleResult } from "./group-titles";
import {
  DEFAULT_SCOPE_ID,
  SEARCH_SCOPES,
} from "@/lib/torrents/search-scopes";
import {
  parseWorkSearchScope,
  type WorkSearchScope,
} from "@/lib/search/work-search";
import {
  placeholderFor,
  searchDisplayFor,
  searchErrorMessage,
  searchRequestFor,
  searchUrlFor,
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
export function openSearchOverlay(
  initialQuery?: string,
  options: {
    preserveUrl?: boolean;
    category?: WorkSearchScope;
  } = {},
) {
  window.dispatchEvent(
    new CustomEvent(OPEN_EVENT, {
      detail: {
        query: initialQuery ?? "",
        preserveUrl: options.preserveUrl ?? false,
        category: options.category ?? DEFAULT_SCOPE_ID,
      },
    }),
  );
}

/**
 * Search as an overlay, not a page.
 *
 * Every category returns canonical works. The only result interaction is the
 * title link; acquisition starts on the title page, never in discovery.
 */
export function SearchOverlay() {
  const pathname = useLocation().pathname;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] =
    useState<WorkSearchScope>(DEFAULT_SCOPE_ID);
  const [titles, setTitles] = useState<TitleResult[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const returnUrlRef = useRef<string | null>(null);
  const ownsSearchUrlRef = useRef(false);
  const openRef = useRef(false);
  const mountedRef = useRef(false);
  const activeRef = useRef(false);

  const close = useCallback(() => {
    activeRef.current = false;
    openRef.current = false;
    setOpen(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    if (
      ownsSearchUrlRef.current &&
      window.location.pathname === "/search" &&
      returnUrlRef.current
    ) {
      window.history.back();
    }
    ownsSearchUrlRef.current = false;
    returnUrlRef.current = null;
  }, []);

  const canCommit = useCallback((reqId: number) => {
    return mountedRef.current && activeRef.current && reqId === reqIdRef.current;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // Open on the global event; set the query if one was passed. Focus is handled
  // by a dedicated effect below, once the input is actually mounted.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (
        e as CustomEvent<{
          query?: string;
          preserveUrl?: boolean;
          category?: WorkSearchScope;
        }>
      ).detail;
      activeRef.current = true;
      const category = parseWorkSearchScope(detail?.category);
      if (!openRef.current) {
        openerRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        if (!detail?.preserveUrl && window.location.pathname !== "/search") {
          returnUrlRef.current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
          ownsSearchUrlRef.current = true;
          window.history.pushState(
            null,
            "",
            searchUrlFor(detail?.query ?? "", category),
          );
        }
      }
      openRef.current = true;
      setOpen(true);
      setScopeId(category);
      setQuery(detail?.query ?? "");
      setTitles([]);
      setError(null);
      setNotice(null);
      if (detail?.query) {
        runSearch(detail.query, category);
      } else {
        setLoading(false);
      }
    }
    window.addEventListener(OPEN_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(OPEN_EVENT, onOpen as EventListener);
  }, []);

  // Treat the palette as a real modal: lock both viewport roots, trap focus,
  // and return focus to the control that opened it.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";

    const focusables = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);

    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!dialogRef.current?.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      const opener = openerRef.current;
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
    };
  }, [open, close]);

  // Let the title link complete its own Next navigation. Closing from the
  // results click handler unmounted that link during the same event and raced
  // the router; the owned /search history entry won and sent users home.
  useEffect(() => {
    if (!open || window.location.pathname === "/search") return;
    openerRef.current = null;
    const frame = requestAnimationFrame(close);
    return () => cancelAnimationFrame(frame);
  }, [open, pathname, close]);

  function runSearch(q: string, scope: WorkSearchScope) {
    if (!mountedRef.current || !activeRef.current) return;

    const request = searchRequestFor(scope, q);
    if (!request) {
      setTitles([]);
      setError(null);
      setNotice(null);
      setLoading(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    setNotice(null);

    fetch(request.url, { signal: ac.signal })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as {
          results?: unknown;
          error?: string | null;
          partial?: boolean;
          failedProviders?: string[];
        } | null;
        if (!canCommit(reqId)) return;

        if (!res.ok) {
          setTitles([]);
          setNotice(null);
          setError(searchErrorMessage(res.status, json));
          setLoading(false);
          return;
        }

        setTitles(
          titlesFromSearchHits(
            (json?.results ?? []) as Parameters<typeof titlesFromSearchHits>[0],
          ),
        );
        // Partial success is still success: keep the results and name what is
        // missing instead of replacing the panel with an error.
        setNotice(
          partialResultsNotice({
            partial: json?.partial,
            failedProviders: json?.failedProviders,
          }),
        );
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!canCommit(reqId)) return;
        setTitles([]);
        setNotice(null);
        setError("Could not reach the server.");
        setLoading(false);
      });
  }

  function onQueryChange(value: string) {
    setQuery(value);
    if (window.location.pathname === "/search") {
      window.history.replaceState(null, "", searchUrlFor(value, scopeId));
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      abortRef.current?.abort();
      setTitles([]);
      setError(null);
      setNotice(null);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(value, scopeId), 220);
  }

  /** Switching category re-runs immediately for the query already entered. */
  function onScopeChange(next: WorkSearchScope) {
    if (next === scopeId) return;
    setScopeId(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setTitles([]);
    setError(null);
    setNotice(null);
    if (window.location.pathname === "/search") {
      window.history.replaceState(null, "", searchUrlFor(query, next));
    }
    if (query.trim().length >= 2) runSearch(query, next);
    else setLoading(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  /** Every keyboard-reachable result is one canonical title link. */
  function resultTargets(): HTMLElement[] {
    return Array.from(
      resultsRef.current?.querySelectorAll<HTMLElement>(
        '[data-card-target="title"]',
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
      const [first] = resultTargets();
      if (!first) return;
      e.preventDefault();
      first.click();
    }
  }

  function onCategoryKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const last = SEARCH_SCOPES.length - 1;
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = index === last ? 0 : index + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = index === 0 ? last : index - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    } else {
      return;
    }
    event.preventDefault();
    const category = SEARCH_SCOPES[next].id as WorkSearchScope;
    onScopeChange(category);
    requestAnimationFrame(() => tabRefs.current[next]?.focus());
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

  if (!open) return null;

  const display = searchDisplayFor({
    scopeId,
    query,
    loading,
    error,
    resultCount: titles.length,
  });
  const statusMessage = loading
    ? `Searching ${display.scope.label.toLowerCase()}`
    : error
      ? `Search problem: ${error}`
      : query.trim().length >= 2
        ? `${titles.length} ${titles.length === 1 ? "result" : "results"} for ${query.trim()}`
        : `Search ${display.scope.label.toLowerCase()}`;

  return (
    <div
      className="fixed inset-0 z-[100] flex justify-center p-0 sm:px-6 sm:pt-[10vh]"
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
        ref={dialogRef}
        className="relative z-[1] flex h-dvh max-h-dvh w-full max-w-3xl flex-col overflow-hidden border-y-0 border-x-0 border-[var(--border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-md)] sm:h-auto sm:max-h-[80vh] sm:rounded-[var(--radius)] sm:border"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <p className="sr-only" role="status" aria-live="polite">
          {statusMessage}
        </p>
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

          <div
            role="tablist"
            aria-label="Search category"
            className="mt-2.5 grid grid-cols-4 gap-1.5"
          >
            {SEARCH_SCOPES.map((s, index) => {
              const active = s.id === scopeId;
              return (
                <button
                  key={s.id}
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`search-scope-${s.id}`}
                  aria-selected={active}
                  aria-controls="search-results-region"
                  title={s.blurb}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onScopeChange(s.id as WorkSearchScope)}
                  onKeyDown={(event) => onCategoryKeyDown(event, index)}
                  className={cn(
                    "min-h-11 touch-manipulation rounded-full border px-2 text-[13px] transition-colors duration-200 ease-out motion-reduce:transition-none sm:min-h-8 sm:px-3",
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
          aria-label={`${display.scope.label} search results`}
          onKeyDown={onResultsKeyDown}
          className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4"
        >
          {notice && display.state === "results" ? (
            <div
              className="mb-3 flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2.5"
              role="status"
              aria-live="polite"
              data-partial-notice
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
                aria-hidden
              />
              <p className="min-w-0 text-[12px] text-[var(--text-secondary)]">
                {notice}
              </p>
            </div>
          ) : null}
          {(() => {
            switch (display.state) {
              case "prompt":
              case "typing":
                // Never a blank panel: the active category supplies one concise
                // prompt and a real example.
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
                    role="alert"
                    data-search-error
                  >
                    <p className="text-[13px] text-[var(--text-secondary)]">
                      {display.message}
                    </p>
                    <button
                      type="button"
                      className="btn btn-secondary btn-md mt-4"
                      onClick={() => runSearch(query, scopeId)}
                    >
                      Try search again
                    </button>
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
                return (
                  <TitleResultsList
                    titles={[]}
                    loading
                    query={query}
                    skeletonCount={4}
                  />
                );

              case "results":
                return (
                  <TitleResultsList
                    titles={titles}
                    loading={loading}
                    query={query}
                    skeletonCount={4}
                  />
                );
            }
          })()}
        </div>
      </div>
    </div>
  );
}
