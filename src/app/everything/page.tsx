"use client";

/**
 * `/everything` — the section for what Browse cannot show.
 *
 * ## Why this page exists
 *
 * Browse and the title page are TMDB-backed, and TMDB knows films and
 * television and nothing else. Music, games, software, books and anime were
 * already fully supported everywhere else — the indexers return them,
 * `smart-category.ts` classifies them, and the download pipeline files them
 * into Music/Games/Software/Books folders — but there was no way to *ask* for
 * them. The owner's words: *"i can download them but it's not easy to search
 * for them."* This is the way in.
 *
 * ## Why it is rows, not a poster grid
 *
 * There is no "work" behind an album or a repack: no canonical title, no
 * synopsis, no poster. The release *is* the artifact, and its name carries the
 * edition, the format and the version. A poster grid here would be decoration
 * standing in for information, so results render as {@link ArtifactRow} — the
 * release name leading, then the two or three facts that actually decide it.
 * See `search-scopes.ts` for the full reasoning behind the two shapes.
 *
 * ## What this file is *not* responsible for
 *
 * Every rule — which scope a URL means, which state to render, which page may
 * be requested, what an error was, where the bytes land — lives in
 * `everything-state.ts` so it can be driven as a table without a DOM. This file
 * holds markup, the debounce/abort loop, and nothing else worth testing twice.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  Clock,
  FolderDown,
  Loader2,
  Search,
  SearchX,
  X,
} from "lucide-react";
import { TfPageHeader } from "@/components/tf/page-header";
import { Button } from "@/components/ui/button";
import { SkeletonBlock } from "@/components/ui/loading";
import { ArtifactRow } from "@/components/search/artifact-row";
import { buildSearchQuery } from "@/components/search/pagination";
import {
  DEFAULT_SECTION_SCOPE,
  MIN_SECTION_QUERY,
  SECTION_PAGE_SIZE,
  clampPage,
  downloadDestination,
  exampleQueries,
  hasMorePages,
  isSearchable,
  loadedLabel,
  networkErrorFrom,
  parseSectionParams,
  retryLabel,
  searchErrorFrom,
  sectionHref,
  sectionView,
  type ClientPathSettings,
  type SectionError,
  type SectionNotice,
} from "@/components/search/everything-state";
import {
  SECTION_SCOPES,
  type SearchScope,
} from "@/lib/torrents/search-scopes";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import { cn } from "@/lib/utils";

/** Long enough that a fast typist sends one request, short enough to feel live. */
const DEBOUNCE_MS = 250;

/** Two pages can never overlap, but React keys must be unique regardless. */
function mergeResults(
  previous: TorrentResult[],
  incoming: TorrentResult[],
): TorrentResult[] {
  const seen = new Set(previous.map((r) => r.id));
  return [...previous, ...incoming.filter((r) => !seen.has(r.id))];
}

export default function EverythingPage() {
  const [scope, setScope] = useState<SearchScope>(DEFAULT_SECTION_SCOPE);
  const [notice, setNotice] = useState<SectionNotice>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TorrentResult[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<SectionError | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  /** Null until the settings request answers — "unknown" is not "unconfigured". */
  const [pathSettings, setPathSettings] = useState<ClientPathSettings | null>(null);
  const [pathSettingsLoaded, setPathSettingsLoaded] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * One request loop for every path into a search.
   *
   * Same shape as the search overlay: a monotonic request id plus an
   * AbortController, so a slower earlier response can never overwrite a newer
   * one and an abandoned keystroke stops costing bandwidth the moment the next
   * one arrives.
   */
  const runSearch = useCallback(
    (
      target: SearchScope,
      rawQuery: string,
      wantedPage: number,
      mode: "replace" | "append",
    ) => {
      const trimmed = rawQuery.trim();
      const reqId = (reqIdRef.current += 1);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError(null);
      if (mode === "append") setLoadingMore(true);
      else setLoading(true);

      const qs = buildSearchQuery({
        query: trimmed,
        page: wantedPage,
        pageSize: SECTION_PAGE_SIZE,
        category: target.category ?? undefined,
      });

      fetch(`/api/search?${qs}`, { signal: controller.signal })
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as
            | (Partial<SearchResponse> & {
                error?: string;
                message?: string;
                retryAfterSeconds?: number;
              })
            | null;
          if (reqId !== reqIdRef.current) return;

          if (!res.ok) {
            setError(searchErrorFrom(res.status, body));
            setLoading(false);
            setLoadingMore(false);
            return;
          }

          const incoming = Array.isArray(body?.results) ? body.results : [];
          setResults((prev) =>
            mode === "append" ? mergeResults(prev, incoming) : incoming,
          );
          setPage(body?.page ?? wantedPage);
          setTotalPages(body?.totalPages ?? 0);
          setTotalCount(body?.totalCount ?? incoming.length);
          setLoading(false);
          setLoadingMore(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (reqId !== reqIdRef.current) return;
          setError(networkErrorFrom(err));
          setLoading(false);
          setLoadingMore(false);
        });
    },
    [],
  );

  /** Restore `?scope=…&q=…`. The URL is an external store, so this is an effect. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const restored = parseSectionParams(window.location.search);
    /* eslint-disable react-hooks/set-state-in-effect */
    setScope(restored.scope);
    setNotice(restored.notice);
    setQuery(restored.query);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (isSearchable(restored.query)) {
      runSearch(restored.scope, restored.query, 1, "replace");
    }
  }, [runSearch]);

  /** The configured download folder, so the header can promise where bytes go. */
  useEffect(() => {
    let alive = true;
    fetch("/api/settings/client")
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { settings?: ClientPathSettings };
        if (!alive) return;
        setPathSettings(json.settings ?? null);
        setPathSettingsLoaded(true);
      })
      .catch(() => {
        // Unknown is not "unconfigured": say only the category folder, and do
        // not accuse the owner of skipping setup they may well have done.
        if (alive) setPathSettingsLoaded(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Count a rate limit down so the retry button is honest about when to press it. */
  useEffect(() => {
    if (error?.kind !== "throttled" || !error.retryAfterSeconds) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRetryIn(0);
      return;
    }
    setRetryIn(error.retryAfterSeconds);
    const id = setInterval(() => {
      setRetryIn((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [error]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  function syncUrl(nextScope: SearchScope, nextQuery: string) {
    if (typeof window === "undefined") return;
    window.history.replaceState(null, "", sectionHref(nextScope.id, nextQuery));
  }

  function stopPendingWork() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    reqIdRef.current += 1;
    abortRef.current?.abort();
  }

  function resetResults() {
    setResults([]);
    setPage(1);
    setTotalPages(0);
    setTotalCount(0);
  }

  function onQueryChange(value: string) {
    setQuery(value);
    syncUrl(scope, value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!isSearchable(value)) {
      stopPendingWork();
      resetResults();
      setError(null);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    // Loading starts at the keystroke, not at the request: the debounce window
    // must never read as "nothing matched".
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      runSearch(scope, value, 1, "replace");
    }, DEBOUNCE_MS);
  }

  function selectScope(next: SearchScope) {
    if (next.id === scope.id) return;
    setScope(next);
    setNotice(null);
    syncUrl(next, query);
    stopPendingWork();
    resetResults();
    setError(null);
    setLoadingMore(false);
    if (isSearchable(query)) {
      setLoading(true);
      runSearch(next, query, 1, "replace");
    } else {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!isSearchable(query)) {
      inputRef.current?.focus();
      return;
    }
    setLoading(true);
    runSearch(scope, query, 1, "replace");
  }

  function applyExample(example: string) {
    setQuery(example);
    syncUrl(scope, example);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setLoading(true);
    runSearch(scope, example, 1, "replace");
    inputRef.current?.focus();
  }

  function clearQuery() {
    onQueryChange("");
    inputRef.current?.focus();
  }

  function loadMore() {
    const next = clampPage(page + 1, totalPages);
    if (next === page) return;
    runSearch(scope, query, next, "append");
  }

  function retry() {
    if (results.length > 0) loadMore();
    else runSearch(scope, query, 1, "replace");
  }

  /** Arrow keys move focus only; Enter/Space activates, per the tabs pattern. */
  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = SECTION_SCOPES.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    tabRefs.current[next]?.focus();
  }

  const view = sectionView({
    query,
    loading,
    resultCount: results.length,
    error,
  });
  const destination = downloadDestination(scope, pathSettings);
  const examples = exampleQueries(scope);
  const trimmedQuery = query.trim();
  const showMore = hasMorePages(page, totalPages);
  const panelId = `everything-panel-${scope.id}`;
  const throttleWait = error?.kind === "throttled" && retryIn > 0;

  return (
    <div className="container-app max-w-5xl py-6 sm:py-8 space-y-5 min-w-0">
      <TfPageHeader
        title="Everything"
        description="Music, games, software, books and anime — the things Browse cannot describe, because there are no posters or episodes behind them."
      />

      {notice ? (
        <div
          className="surface mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 p-4 text-[13px]"
          data-section-notice={notice}
        >
          <span className="text-[var(--text-secondary)]">
            {notice === "films"
              ? "Films and series live on Browse, where they get posters, seasons and episodes."
              : "That link asked for a category this app does not have."}
          </span>
          <span className="text-[var(--text-tertiary)]">
            Showing {scope.label}.
          </span>
          {notice === "films" ? (
            <Link
              href="/"
              className="inline-flex min-h-[44px] items-center gap-1 text-[var(--accent-text)] underline-offset-2 hover:underline lg:min-h-0"
            >
              Go to Browse
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* Scope tabs — driven entirely by SECTION_SCOPES. Horizontally
          scrollable rather than wrapped so the row keeps one line on a phone
          and never pushes the search field below the fold. */}
      <div
        role="tablist"
        aria-label="Category"
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
        data-scope-tabs
      >
        {SECTION_SCOPES.map((s, i) => {
          const active = s.id === scope.id;
          return (
            <button
              key={s.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`everything-tab-${s.id}`}
              aria-selected={active}
              aria-controls={active ? panelId : undefined}
              tabIndex={active ? 0 : -1}
              data-scope-tab={s.id}
              onClick={() => selectScope(s)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={cn(
                "inline-flex min-h-[44px] shrink-0 items-center rounded-md border px-3.5 text-[13px] font-medium transition-colors lg:min-h-9",
                "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                active
                  ? "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent-text)]"
                  : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
              )}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <section
        id={panelId}
        role="tabpanel"
        aria-labelledby={`everything-tab-${scope.id}`}
        className="mt-3 space-y-4"
      >
        {/* Scope header: what this shelf holds, and where its files land. The
            second half is the answer to the question the owner kept asking. */}
        <div className="surface space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="text-sm font-semibold tracking-tight text-[var(--text)]">
              {scope.label}
            </h2>
            <p className="text-[13px] text-[var(--text-secondary)]">
              {scope.blurb}
            </p>
          </div>

          <p
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--text-tertiary)]"
            data-destination
          >
            <FolderDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {destination.perResult
                ? "Files land in a folder chosen per result, under"
                : "Files land in"}
            </span>
            <code className="rounded-[var(--radius-sm)] bg-[var(--bg-muted)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
              {destination.path || destination.category || "your download folder"}
            </code>
            {pathSettingsLoaded && !destination.configured ? (
              <Link
                href="/settings?tab=folders"
                className="inline-flex min-h-[44px] items-center text-[var(--accent-text)] underline-offset-2 hover:underline lg:min-h-0"
              >
                Choose a download folder
              </Link>
            ) : null}
          </p>

          <form role="search" onSubmit={onSubmit} className="flex gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 transition-[border-color,box-shadow] duration-200 ease-out motion-reduce:transition-none focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-dim)]">
              <Search
                className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]"
                aria-hidden
              />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder={scope.placeholder}
                aria-label={`Search ${scope.label}`}
                autoComplete="off"
                spellCheck={false}
                data-section-input
                className="h-11 w-full min-w-0 bg-transparent text-base text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)] sm:text-sm [&::-webkit-search-cancel-button]:appearance-none"
              />
              {query ? (
                <button
                  type="button"
                  onClick={clearQuery}
                  aria-label="Clear search"
                  className="-mr-1 flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--text)] motion-reduce:transition-none lg:h-9 lg:w-9"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <Button type="submit" className="shrink-0">
              Search
            </Button>
          </form>
        </div>

        <div aria-live="polite" aria-busy={loading || loadingMore}>
          {view === "brief" ? (
            <div className="surface p-5 sm:p-6" data-section-state="brief">
              <h3 className="text-sm font-medium text-[var(--text)]">
                What is in {scope.label}
              </h3>
              <p className="mt-1.5 max-w-prose text-[13px] leading-relaxed text-[var(--text-secondary)]">
                {scope.blurb} Results are individual releases — the name carries
                the edition, the format and the version, so there is nothing to
                open before you pick one.
              </p>
              <p className="mt-3 text-[12px] text-[var(--text-tertiary)]">
                {trimmedQuery.length > 0
                  ? `Keep typing — searches start at ${MIN_SECTION_QUERY} characters.`
                  : `Type at least ${MIN_SECTION_QUERY} characters to search ${scope.label.toLowerCase()}.`}
              </p>

              {examples.length ? (
                <div className="mt-4">
                  <p className="text-[11px] font-medium tracking-wide text-[var(--text-tertiary)]">
                    Try one
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {examples.map((example) => (
                      <button
                        key={example}
                        type="button"
                        onClick={() => applyExample(example)}
                        data-example-query
                        className="inline-flex min-h-[44px] items-center rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-[13px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] motion-reduce:transition-none lg:min-h-9"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-[12px] text-[var(--text-tertiary)]">
                  This scope searches every category at once — useful when you
                  are not sure what a thing counts as.
                </p>
              )}
            </div>
          ) : null}

          {view === "loading" ? (
            <div
              className="surface px-4 sm:px-5"
              role="status"
              aria-label={`Searching ${scope.label}`}
              data-section-state="loading"
            >
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-4 border-b border-[var(--border)] py-3.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <SkeletonBlock className="h-3.5 w-[70%] rounded" />
                    <SkeletonBlock className="h-3 w-[35%] rounded" />
                  </div>
                  <SkeletonBlock className="h-9 w-24 shrink-0 rounded-md" />
                </div>
              ))}
              <span className="sr-only">
                Searching {scope.label} for {trimmedQuery}
              </span>
            </div>
          ) : null}

          {view === "results" ? (
            <div data-section-state="results">
              <div className="surface px-4 sm:px-5">
                {results.map((torrent) => (
                  <ArtifactRow key={torrent.id} torrent={torrent} scope={scope} />
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[12px] text-[var(--text-tertiary)]">
                  {loadedLabel(results.length, totalCount)}
                  {loading || loadingMore ? (
                    <span className="ml-2 inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      Updating…
                    </span>
                  ) : null}
                </p>
                {showMore ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={loadMore}
                    disabled={loadingMore}
                    data-load-more
                  >
                    {loadingMore ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        Loading…
                      </>
                    ) : (
                      `Load ${Math.min(
                        SECTION_PAGE_SIZE,
                        Math.max(0, totalCount - results.length),
                      )} more`
                    )}
                  </Button>
                ) : (
                  <span className="text-[12px] text-[var(--text-tertiary)]">
                    End of results
                  </span>
                )}
              </div>

              {error ? (
                <div
                  className="surface mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 p-4"
                  data-section-error="partial"
                >
                  <AlertCircle
                    className="h-4 w-4 shrink-0 text-[var(--danger)]"
                    aria-hidden
                  />
                  <p className="min-w-0 flex-1 text-[13px] text-[var(--text-secondary)]">
                    {error.message}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={retry}
                    disabled={throttleWait}
                  >
                    {error.kind === "throttled" ? retryLabel(retryIn) : "Try again"}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {view === "empty" ? (
            <div
              className="surface px-5 py-12 text-center"
              data-section-state="empty"
            >
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
                <SearchX className="h-5 w-5" aria-hidden />
              </div>
              <p className="mt-3 text-sm text-[var(--text-secondary)]">
                No {scope.label.toLowerCase()} releases matched “{trimmedQuery}”
              </p>
              <p className="mx-auto mt-1.5 max-w-prose text-[12px] text-[var(--text-tertiary)]">
                Every indexer answered; none of them had it under this category.
                Release names carry the edition, so a shorter query — just the
                artist, the studio or the program name — usually finds more.
              </p>
              {scope.id !== "everything" ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="mt-4"
                  data-widen-scope
                  onClick={() => {
                    const wider = SECTION_SCOPES.find((s) => s.id === "everything");
                    if (wider) selectScope(wider);
                  }}
                >
                  Search every category for “{trimmedQuery}”
                </Button>
              ) : null}
            </div>
          ) : null}

          {view === "throttled" ? (
            <div
              className="surface flex items-start gap-3 p-5"
              data-section-state="throttled"
            >
              <Clock
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text)]">
                  The indexers need a moment
                </p>
                <p className="mt-1 max-w-prose text-[13px] text-[var(--text-tertiary)]">
                  {error?.message} Nothing is broken and nothing was lost — this
                  is the rate limit that keeps the indexers answering at all.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={retry}
                  disabled={throttleWait}
                  data-retry
                >
                  {retryLabel(retryIn)}
                </Button>
              </div>
            </div>
          ) : null}

          {view === "error" ? (
            <div
              className="surface flex items-start gap-3 p-5"
              data-section-state="error"
            >
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]"
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text)]">
                  Could not search {scope.label.toLowerCase()}
                </p>
                <p className="mt-1 max-w-prose text-[13px] text-[var(--text-tertiary)]">
                  {error?.message}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={retry}
                  data-retry
                >
                  Try again
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
