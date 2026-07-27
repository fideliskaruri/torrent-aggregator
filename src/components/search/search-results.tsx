"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Rows3,
  RefreshCw,
  SearchX,
  SlidersHorizontal,
} from "lucide-react";
import type { SearchResponse, TorrentResult, TorrentSourceId } from "@/lib/torrents/types";
import {
  groupReleasesByWork,
  type WorkGroup,
} from "@/lib/torrents/work-identity";
import {
  describeSourceFailure,
  sourceShortLabel,
} from "@/lib/torrents/source-labels";
import { TorrentCard } from "./torrent-card";
import { cn } from "@/lib/utils";
import { SEARCH_HREF } from "@/lib/navigation";
import { useReleaseArtwork } from "@/hooks/use-release-artwork";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import { useUiPreferences } from "@/components/providers/ui-preferences";
import { Button } from "@/components/ui/button";

const ALL_SOURCES: { id: TorrentSourceId; label: string }[] = (
  ["nyaa", "apibay", "torrentscsv", "yts", "1337x"] as const
).map((id) => ({ id, label: sourceShortLabel(id) }));

/** Fetch enough ranked results that scrolling feels like a flow, not a teaser. */
const DEFAULT_PAGE_SIZE = 200;

interface SearchResultsProps {
  query: string;
  category?: string;
}

export function SearchResults({ query, category = "all" }: SearchResultsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { density, setDensity } = useUiPreferences();
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  const minSeeders = searchParams.get("minSeeders") ?? "";
  const releaseKind = searchParams.get("releaseKind") ?? "";
  const resolution = searchParams.get("resolution") ?? "";
  const codec = searchParams.get("codec") ?? "";
  const maxSizeGb = searchParams.get("maxSizeGb") ?? "";
  const sourcesParam = searchParams.get("sources") ?? "";
  const pageParam = searchParams.get("page");
  const page = Math.max(parseInt(pageParam ?? "1", 10) || 1, 1);
  const pageSize = DEFAULT_PAGE_SIZE;

  const selectedSources = useMemo(() => {
    if (!sourcesParam)
      return ALL_SOURCES.filter((s) => s.id !== "1337x").map((s) => s.id);
    return sourcesParam.split(",").filter(Boolean) as TorrentSourceId[];
  }, [sourcesParam]);

  /**
   * Build the search URL (`/search?q=…`). Non-page overrides clear `page` so
   * filters/sources always reset to page 1 unless `page` is set in overrides.
   */
  const buildUrl = useCallback(
    (overrides: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("q", query);
      if (category && category !== "all") params.set("category", category);
      else params.delete("category");

      if (!("page" in overrides)) {
        params.delete("page");
      }

      for (const [k, v] of Object.entries(overrides)) {
        if (v == null || v === "") params.delete(k);
        else params.set(k, v);
      }
      return `${SEARCH_HREF}?${params.toString()}`;
    },
    [searchParams, query, category],
  );

  const goToPage = useCallback(
    (nextPage: number) => {
      const p = Math.max(1, nextPage);
      router.push(
        buildUrl({ page: p <= 1 ? null : String(p) }),
        { scroll: true },
      );
    },
    [router, buildUrl],
  );

  const load = useCallback(
    async (refresh = false) => {
      if (!query) return;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          q: query,
          page: String(page),
          pageSize: String(pageSize),
        });
        if (category && category !== "all") params.set("category", category);
        if (minSeeders) params.set("minSeeders", minSeeders);
        if (releaseKind) params.set("releaseKind", releaseKind);
        if (resolution) params.set("resolution", resolution);
        if (codec) params.set("codec", codec);
        if (maxSizeGb) {
          const bytes = Math.round(parseFloat(maxSizeGb) * 1e9);
          if (Number.isFinite(bytes)) params.set("maxSize", String(bytes));
        }
        if (sourcesParam) params.set("sources", sourcesParam);
        if (refresh) params.set("refresh", "1");

        const res = await fetch(`/api/search?${params.toString()}`);
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.message || json.error || "Search failed");
        }
        setData(json as SearchResponse);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [
      query,
      category,
      minSeeders,
      releaseKind,
      resolution,
      codec,
      maxSizeGb,
      sourcesParam,
      page,
      pageSize,
    ],
  );

  useEffect(() => {
    // Search results are external API state; fetching them from URL params belongs in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Keep URL in sync if the API clamps an out-of-range page.
  useEffect(() => {
    if (!data?.page || data.totalPages <= 0) return;
    if (data.page === page) return;
    router.replace(
      buildUrl({ page: data.page <= 1 ? null : String(data.page) }),
    );
  }, [data?.page, data?.totalPages, page, router, buildUrl]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      const cards = Array.from(
        document.querySelectorAll<HTMLElement>("[data-torrent-card]"),
      );
      if (!cards.length) return;

      const focused = document.activeElement as HTMLElement | null;
      let idx = cards.findIndex((c) => c === focused || c.contains(focused));

      if (e.key === "j") {
        e.preventDefault();
        idx = Math.min(idx + 1, cards.length - 1);
        if (idx < 0) idx = 0;
        cards[idx].focus();
        cards[idx].scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else if (e.key === "k") {
        e.preventDefault();
        idx = Math.max(idx - 1, 0);
        cards[idx].focus();
        cards[idx].scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else if (e.key === "m" && idx >= 0) {
        cards[idx].querySelector<HTMLElement>('[data-action="copy"]')?.click();
      } else if (e.key === "p" && !e.metaKey && !e.ctrlKey && idx >= 0) {
        e.preventDefault();
        cards[idx].querySelector<HTMLElement>('[data-action="stream"]')?.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data]);

  function toggleSource(id: TorrentSourceId) {
    const set = new Set(selectedSources);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    const next = Array.from(set);
    router.push(buildUrl({ sources: next.length ? next.join(",") : null }));
  }

  const totalCount = data?.totalCount ?? data?.results.length ?? 0;
  const totalPages = data?.totalPages ?? 0;
  const currentPage = data?.page ?? page;
  const rangeStart =
    totalCount === 0 ? 0 : (currentPage - 1) * (data?.pageSize ?? pageSize) + 1;
  const rangeEnd = Math.min(
    currentPage * (data?.pageSize ?? pageSize),
    totalCount,
  );

  const densityLabel =
    density === "comfortable" ? "Comfortable" : "Compact";

  /**
   * Group identity is only used for per-work artwork and labels. It must never
   * decide which ranked releases are visible: `data.results` is already the
   * server-ranked truth, so the page renders that list directly below.
   */
  const works = useMemo(() => {
    if (!data?.results.length) return [];
    return groupReleasesByWork(
      data.results,
      (t) => t.title,
      (t) => t.metadata,
    );
  }, [data]);

  /**
   * Artwork for works whose releases carried no usable catalog match.
   *
   * `groupReleasesByWork` only accepts a poster from a release whose catalog
   * title agrees with the group name, which is the right rule — it is what
   * stops a card wearing another film's poster. But it leaves real gaps: a
   * "dune" search puts `Dune Part Two (2024) [1080p] [WEBRip] 88` in its own
   * group, the stray `88` makes the catalog title disagree, and the top card
   * on the page renders as a grey letter tile even though the poster is
   * sitting in the payload.
   *
   * This asks the artwork resolver for the *group's own name*, which is the
   * question that card is actually posing. One batched request for the page,
   * only for the groups that are missing art.
   */
  const artworkNeeds = useMemo(
    () =>
      works
        .filter((work) => !work.posterUrl)
        .map((work) => ({
          name: work.year ? `${work.name} ${work.year}` : work.name,
          category: work.isSeries ? "tv" : "movie",
        })),
    [works],
  );
  const fallbackArtwork = useReleaseArtwork(artworkNeeds);

  const resultFlow = useMemo(() => {
    if (!data?.results.length) return [];
    const groupById = new Map<string, WorkGroup<TorrentResult>>();
    const firstIdByWork = new Map<string, string>();
    for (const work of works) {
      for (const item of work.items) {
        groupById.set(item.id, work);
        if (!firstIdByWork.has(work.key)) firstIdByWork.set(work.key, item.id);
      }
    }
    const routeKeys = data.results.map((torrent) => routeKey(torrent));
    const distinctRoutes = new Set(routeKeys.filter(Boolean));
    const base = (currentPage - 1) * (data.pageSize ?? pageSize);
    return data.results.map((torrent, offset) => {
      const work = groupById.get(torrent.id) ?? null;
      const currentRoute = routeKeys[offset];
      const prevRoute = routeKeys[offset - 1] ?? null;
      const nextRoute = routeKeys[offset + 1] ?? null;
      return {
        torrent,
        work,
        index: base + offset,
        featured: offset === 0 && currentPage === 1,
        showPoster: work ? firstIdByWork.get(work.key) === torrent.id : true,
        showRoute:
          Boolean(currentRoute) &&
          distinctRoutes.size > 1 &&
          (currentRoute !== prevRoute || currentRoute !== nextRoute),
      };
    });
  }, [data, works, currentPage, pageSize]);

  if (loading) {
    return (
      <div className="space-y-0 overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
        <div className="border-b border-[var(--border)] px-4 py-3 text-[12px] text-[var(--text-tertiary)]">
          Searching sources…
        </div>
        {/*
          Mirrors the loaded row: title line, meta line, action block right.
          It deliberately does NOT draw a per-row poster — artwork only appears
          on some result shapes, and a placeholder that vanishes on load is a
          reflow the user reads as the page changing its mind.
        */}
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-4 last:border-0"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className="skeleton h-4 w-4/5" />
              <div className="skeleton h-3 w-1/2" />
            </div>
            <div className="skeleton h-8 w-24 shrink-0 rounded-md" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="surface p-5 flex items-start gap-3">
        <AlertCircle className="h-4 w-4 text-[var(--danger)] shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text)]">Search failed</p>
          <p className="text-[13px] text-[var(--text-tertiary)] mt-1">{error}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => load(true)}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const hasActiveFilters = Boolean(
    minSeeders || resolution || codec || maxSizeGb || sourcesParam || releaseKind,
  );

  const failedSources = data?.sources.filter((s) => s.error) ?? [];

  return (
    <div className="space-y-3">
      {/* Sticky toolbar: count · density · filters · refresh */}
      <div className="results-toolbar py-2 space-y-2">
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
            <span>
              {totalCount > 0 ? (
                <>
                  <strong className="text-[var(--text-secondary)] font-medium tabular-nums">
                    {rangeStart}–{rangeEnd}
                  </strong>{" "}
                  of{" "}
                  <strong className="text-[var(--text-secondary)] font-medium tabular-nums">
                    {totalCount}
                  </strong>
                </>
              ) : (
                <>
                  <strong className="text-[var(--text-secondary)] font-medium tabular-nums">
                    0
                  </strong>{" "}
                  results
                </>
              )}
            </span>
            {data && (
              <>
                {data.cached && (
                  <>
                    <span className="text-[var(--border-strong)]">·</span>
                    <span>cached</span>
                  </>
                )}
                {failedSources.length > 0 && (
                  <>
                    <span className="text-[var(--border-strong)]">·</span>
                    {/* A public tracker being Cloudflare-blocked is routine and
                        nothing the user can act on. Red made it the loudest
                        thing on an otherwise calm page — especially on the
                        empty state, where it read as the reason for 0 results. */}
                    <button
                      type="button"
                      onClick={() => setShowFilters(true)}
                      title={failedSources
                        .map((s) => describeSourceFailure(s.id, s.error))
                        .join("\n")}
                      className="inline-flex cursor-pointer items-center gap-1 rounded text-[var(--text-tertiary)] outline-none hover:text-[var(--text-secondary)] hover:underline focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                    >
                      <AlertCircle className="h-3 w-3 shrink-0" />
                      <span>
                        {failedSources.length} of {data.sources.length} sources
                        unavailable
                      </span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* One decision, one control, always visible. The panel used to
                carry a second copy of this plus a grouping toggle that fought
                the automatic grouping. */}
            {category !== "movies" ? (
              <div
                role="group"
                aria-label="Release kind"
                className="mr-1 flex items-center rounded-lg bg-[var(--bg-muted)] p-0.5 ring-1 ring-[var(--border)]"
              >
                {[
                  { value: "", label: "All" },
                  { value: "packs", label: "Packs" },
                  { value: "episodes", label: "Episodes" },
                ].map((opt) => {
                  const active = releaseKind === opt.value;
                  return (
                    <button
                      key={opt.value || "all"}
                      type="button"
                      aria-pressed={active}
                      title={
                        opt.value === "packs"
                          ? "Season packs and batches only"
                          : opt.value === "episodes"
                            ? "Single episodes only"
                            : "Packs and episodes"
                      }
                      onClick={() =>
                        router.push(buildUrl({ releaseKind: opt.value || null }))
                      }
                      className={cn(
                        "h-7 cursor-pointer rounded-[6px] px-2.5 text-[12px] transition-colors",
                        active
                          ? "bg-[var(--bg-elevated)] text-[var(--text)] shadow-sm"
                          : "text-[var(--text-tertiary)] hover:text-[var(--text)]",
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-[12px] text-[var(--text-tertiary)]"
              onClick={() =>
                setDensity(density === "compact" ? "comfortable" : "compact")
              }
              title={`Density: ${densityLabel}`}
              data-density-toggle
            >
              <Rows3 className="h-3.5 w-3.5 opacity-70" />
              <span className="hidden sm:inline">{densityLabel}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant={
                showFilters || hasActiveFilters ? "secondary" : "ghost"
              }
              onClick={() => setShowFilters((v) => !v)}
              aria-expanded={showFilters}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filters
              {hasActiveFilters && !showFilters ? (
                <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              ) : null}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => load(true)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>

        {data?.results.length ? (
          <p
            className="text-[12px] leading-relaxed text-[var(--text-tertiary)]"
            data-retention-help
          >
            Stream plays now and can be reclaimed later. Download keeps the file.
          </p>
        ) : null}

        {/* Sources + filters — collapsed by default (mobile-friendly) */}
        {showFilters && (
          <div className="surface p-2 sm:p-2.5 space-y-2.5">
            <div>
              <p className="text-[11px] text-[var(--text-tertiary)] mb-1.5">
                Sources
              </p>
              <div className="flex flex-wrap gap-1">
                {ALL_SOURCES.map((s) => {
                  const active = selectedSources.includes(s.id);
                  const src = data?.sources.find((x) => x.id === s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleSource(s.id)}
                      title={
                        src?.error
                          ? describeSourceFailure(s.id, src.error)
                          : src
                            ? `${src.count} results`
                            : "Not queried in this search"
                      }
                      className={cn(
                        "badge cursor-pointer transition-colors",
                        active && "badge-accent",
                        src?.error && active && "badge-danger",
                      )}
                    >
                      {s.label}
                      {/* Every chip carries a count slot, so an unqueried
                          source doesn't read as an unfinished one. */}
                      <span className="ml-1 tabular-nums opacity-70">
                        {src != null ? src.count : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 border-t border-[var(--border)]">
              <FilterField
                label="Min seeders"
                value={minSeeders}
                placeholder="Any"
                onChange={(v) =>
                  router.push(buildUrl({ minSeeders: v || null }))
                }
              />
              <label className="space-y-1 text-[11px] text-[var(--text-tertiary)]">
                Resolution
                <select
                  className="input-field h-8 w-full px-2 text-[12px]"
                  value={resolution}
                  onChange={(e) =>
                    router.push(
                      buildUrl({ resolution: e.target.value || null }),
                    )
                  }
                >
                  <option value="">Any</option>
                  <option value="2160p">2160p</option>
                  <option value="1080p">1080p</option>
                  <option value="720p">720p</option>
                </select>
              </label>
              <label className="space-y-1 text-[11px] text-[var(--text-tertiary)]">
                Codec
                <select
                  className="input-field h-8 w-full px-2 text-[12px]"
                  value={codec}
                  onChange={(e) =>
                    router.push(buildUrl({ codec: e.target.value || null }))
                  }
                >
                  <option value="">Any</option>
                  <option value="x265">x265 / HEVC</option>
                  <option value="x264">x264</option>
                  <option value="av1">AV1</option>
                </select>
              </label>
              <FilterField
                label="Max size (GB)"
                value={maxSizeGb}
                placeholder="8"
                onChange={(v) =>
                  router.push(buildUrl({ maxSizeGb: v || null }))
                }
              />
            </div>
          </div>
        )}
      </div>

      {/* Results list */}
      {!data?.results.length ? (
        <div className="surface px-5 py-12 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
            <SearchX className="h-5 w-5" aria-hidden />
          </div>
          <p className="text-sm text-[var(--text-secondary)] mt-3">
            No results for “{query}”
          </p>
          <p className="text-[12px] text-[var(--text-tertiary)] mt-1.5">
            {hasActiveFilters
              ? "Your filters may be too narrow."
              : "Try another spelling, or a different category."}
          </p>
          {failedSources.length > 0 && (
            <p className="mt-3 text-[12px] text-[var(--text-tertiary)]">
              {failedSources.length} of {data?.sources.length} sources could not
              be reached, so this may be incomplete:
              <span className="block mt-1 text-[var(--text-secondary)]">
                {failedSources
                  .map((s) => describeSourceFailure(s.id, s.error))
                  .join(" · ")}
              </span>
            </p>
          )}
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {hasActiveFilters && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  router.push(
                    buildUrl({
                      minSeeders: null,
                      releaseKind: null,
                      resolution: null,
                      codec: null,
                      maxSizeGb: null,
                      sources: null,
                    }),
                  )
                }
              >
                Clear filters
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => load(true)}>
              <RefreshCw className="h-3.5 w-3.5" />
              Search again
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3">
            {resultFlow.map(({ torrent, work, index, featured, showPoster, showRoute }) => {
              const fallbackPosterUrl = work?.posterUrl
                ? null
                : work
                  ? (fallbackArtwork[
                      artworkQueryForRelease(
                        work.year ? `${work.name} ${work.year}` : work.name,
                        work.isSeries ? "tv" : "movie",
                      ).key
                    ]?.posterUrl ?? null)
                  : null;
              return (
                <TorrentCard
                  key={torrent.id}
                  torrent={torrent}
                  index={index}
                  searchCategory={category}
                  featured={featured}
                  showPoster={showPoster}
                  showRoute={showRoute}
                  work={work}
                  fallbackPosterUrl={fallbackPosterUrl}
                />
              );
            })}
          </div>

          {totalPages > 1 && (
            <Pagination
              page={currentPage}
              totalPages={totalPages}
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              totalCount={totalCount}
              onPageChange={goToPage}
            />
          )}
        </>
      )}
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  rangeStart,
  rangeEnd,
  totalCount,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  rangeStart: number;
  rangeEnd: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}) {
  const pages = useMemo(
    () => buildPageList(page, totalPages),
    [page, totalPages],
  );

  return (
    <nav
      className="surface px-2.5 py-2.5 sm:px-3 sm:py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5"
      aria-label="Search results pagination"
    >
      <p className="text-[12px] text-[var(--text-tertiary)] text-center sm:text-left tabular-nums order-2 sm:order-1">
        <span className="text-[var(--text-secondary)]">
          {rangeStart}–{rangeEnd}
        </span>{" "}
        of {totalCount}
      </p>

      <div className="flex items-center justify-center gap-1 flex-wrap order-1 sm:order-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-h-9 min-w-9 px-2 sm:px-2.5"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Prev</span>
        </Button>

        <div className="flex items-center gap-0.5 sm:gap-1">
          {pages.map((p, i) =>
            p === "…" ? (
              <span
                key={`ellipsis-${i}`}
                className="px-1.5 text-[12px] text-[var(--text-tertiary)] select-none"
                aria-hidden
              >
                …
              </span>
            ) : (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={p === page ? "secondary" : "ghost"}
                onClick={() => onPageChange(p)}
                aria-label={`Page ${p}`}
                aria-current={p === page ? "page" : undefined}
                className="min-h-9 min-w-9 px-0 tabular-nums"
              >
                {p}
              </Button>
            ),
          )}
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-h-9 min-w-9 px-2 sm:px-2.5"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  );
}

/** Compact page number list with ellipses for large page counts. */
function buildPageList(
  current: number,
  total: number,
): (number | "…")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const set = new Set<number>();
  set.add(1);
  set.add(total);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 1 && p <= total) set.add(p);
  }
  // Prefer a bit more context near edges
  if (current <= 3) {
    set.add(2);
    set.add(3);
    set.add(4);
  }
  if (current >= total - 2) {
    set.add(total - 1);
    set.add(total - 2);
    set.add(total - 3);
  }

  const sorted = Array.from(set).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push("…");
    out.push(sorted[i]);
  }
  return out;
}

function routeKey(torrent: TorrentResult): string | null {
  return (
    torrent.route?.relativePath?.trim() ||
    torrent.route?.savePath?.trim() ||
    null
  );
}

function FilterField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  // Filter value is external URL state; syncing the local draft when it changes belongs in an effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setLocal(value), [value]);

  return (
    <label className="space-y-1 text-[11px] text-[var(--text-tertiary)]">
      {label}
      <input
        className="input-field h-8 w-full px-2 text-[12px]"
        value={local}
        placeholder={placeholder}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => onChange(local)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onChange(local);
        }}
      />
    </label>
  );
}
