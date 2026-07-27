"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ChevronDown,
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
import {
  buildSections,
  defaultSectionKey,
  qualityLadder,
  seasonCount,
  workSubtitle,
} from "./work-sections";
import { TorrentCard } from "./torrent-card";
import { titleHrefForName } from "@/components/title/work-key";
import { cn } from "@/lib/utils";
import { SEARCH_HREF } from "@/lib/navigation";
import { useReleaseArtwork } from "@/hooks/use-release-artwork";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import { useUiPreferences } from "@/components/providers/ui-preferences";
import { Button } from "@/components/ui/button";

const ALL_SOURCES: { id: TorrentSourceId; label: string }[] = (
  ["nyaa", "apibay", "torrentscsv", "yts", "1337x"] as const
).map((id) => ({ id, label: sourceShortLabel(id) }));

/**
 * The page groups results into seasons and then a quality ladder, showing one
 * row per rung. Those counts are only honest if they are computed over the
 * whole pool, so the page fetches the pool rather than a 20-row window — the
 * old 20 made "best 1080p of season 5" mean "best among an arbitrary 20 of
 * 145". Rendering cost is unchanged; the ladder still shows a handful of rows.
 */
const DEFAULT_PAGE_SIZE = 200;

/**
 * A season the user cannot reach without scrolling past another season is a
 * season they will not reach. Seasons are therefore a *switcher*, not a stack:
 * one season is on screen at a time, complete and uncapped, and every other
 * season is one click away at a fixed position near the top of the page.
 */

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
      } else if (e.key === "s" && !e.metaKey && !e.ctrlKey && idx >= 0) {
        e.preventDefault();
        cards[idx].querySelector<HTMLElement>('[data-action="send"]')?.click();
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
   * One card per *work*, not one header per page.
   *
   * The page used to elect a single `subject` by majority vote on
   * `metadata.title` across the top 16 enriched rows. Two things were wrong
   * with that, and a "dune" search hit both: a page that is 60% one work and
   * 40% another got one header speaking for all of it ("DUNE · 2017 · 127
   * releases" over five different works), and the vote keyed on catalog
   * metadata — the very thing that had mis-matched. Worse, seasons were
   * bucketed by number alone, so clicking "S01" mixed *Dune: Prophecy*
   * episodes with *Children of Dune* episodes.
   *
   * Identity now comes from the release names, which are self-describing and
   * were never ambiguous, and every downstream decision — seasons, the quality
   * ladder, the count in the heading — is computed inside one work. Rank order
   * is still the server's: `groupReleasesByWork` preserves it within a group
   * and emits groups in the order their best-ranked release appeared, so the
   * work the user meant stays first without scoring relevance a second time.
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

  /**
   * Absolute rank of each row, for the number the card draws. Computed once
   * over the page rather than per work, so it stays the position in the
   * server's ranking and not a per-card counter.
   */
  const rankOf = useMemo(() => {
    const map = new Map<string, number>();
    if (!data?.results.length) return map;
    const base = (currentPage - 1) * (data.pageSize ?? pageSize);
    data.results.forEach((t, i) => map.set(t.id, base + i));
    return map;
  }, [data, currentPage, pageSize]);

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
            {data && typeof data.tookMs === "number" && (
              <>
                <span className="text-[var(--border-strong)]">·</span>
                <span className="tabular-nums">{data.tookMs}ms</span>
              </>
            )}
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
          {/*
            Works are separated by more space than anything inside one. On a
            multi-work page the reader's first question is "how many different
            things is this?", and a gap that matches the internal rhythm makes
            the next work's heading look like another row of the previous one.
          */}
          <div className="space-y-8">
            {works.map((work) => (
              <WorkCard
                key={work.key}
                work={work}
                query={query}
                category={category}
                rankOf={rankOf}
                soloWork={works.length === 1}
                fallbackPosterUrl={
                  work.posterUrl
                    ? null
                    : (fallbackArtwork[
                        artworkQueryForRelease(
                          work.year ? `${work.name} ${work.year}` : work.name,
                          work.isSeries ? "tv" : "movie",
                        ).key
                      ]?.posterUrl ?? null)
                }
              />
            ))}
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

/**
 * One work: its heading, its season switcher, and its releases.
 *
 * Everything here is scoped to `work.items`. That is the whole point of the
 * component existing — season and quality bucketing over a mixed page is what
 * put *Children of Dune* episodes behind *Dune: Prophecy*'s "S01" tab, and a
 * component that only ever receives one work's releases cannot express that
 * question again.
 *
 * Selection state lives here rather than in the parent so each work remembers
 * its own open season and expanded quality rungs. A new search produces new
 * work keys, which remounts these and clears the state for free.
 */
function WorkCard({
  work,
  query,
  category,
  rankOf,
  soloWork,
  fallbackPosterUrl,
}: {
  work: WorkGroup<TorrentResult>;
  query: string;
  category: string;
  /** Position in the server's ranking, for the number each row draws. */
  rankOf: Map<string, number>;
  /** True when this is the page's only work — see the sticky-tabs note below. */
  soloWork: boolean;
  /**
   * Art resolved from the group's own name, used only when the releases
   * themselves offered none the grouping was willing to trust.
   */
  fallbackPosterUrl: string | null;
}) {
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [openQuality, setOpenQuality] = useState<Set<string>>(new Set());
  const domId = useId();

  const sections = useMemo(
    () =>
      buildSections(work.items, {
        // A film has no seasons to group by, and a movies-category search must
        // never sprout a "Season 1" header from one stray TV hit.
        includeSeasons: work.isSeries && category !== "movies",
      }),
    [work.items, work.isSeries, category],
  );

  const switcher = sections.length > 1 ? sections : null;
  const defaultKey = useMemo(
    () => defaultSectionKey(sections, query),
    [sections, query],
  );
  const activeKey =
    activeSection && sections.some((s) => s.key === activeSection)
      ? activeSection
      : defaultKey;

  const activeItems =
    sections.find((s) => s.key === activeKey)?.items ?? work.items;
  const ladder = useMemo(() => qualityLadder(activeItems), [activeItems]);

  const heading = work.name;
  const posterUrl = work.posterUrl ?? fallbackPosterUrl;

  const titleAttr = work.year ? `${heading} (${work.year})` : heading;

  // Every card opens the page about the work, search included: this header is
  // a card, not a caption. Same funnel as the rails, so a result and its
  // poster on the home board land on the same page.
  const workHref = titleHrefForName(heading, { mediaType: category });

  const releases = ladder ? (
    <div className="space-y-2">
      {ladder.map((group) => {
        // Namespaced by section: "3 more 1080p" counts the rungs of *this*
        // season, so carrying the open state across a tab switch would show a
        // count that belongs to a list the user is no longer looking at.
        const stateKey = `${activeKey ?? ""}:${group.key}`;
        const open = openQuality.has(stateKey);
        const shown = open ? group.items : group.items.slice(0, 1);
        const hidden = group.items.length - shown.length;
        return (
          <section key={group.key} className="space-y-1">
            {/* h3, not h4: since the split, a quality rung sits directly under
                the work's own h2 — there is no longer an intermediate level
                between them for a screen reader to walk through. */}
            <h3
              data-quality-group={group.key}
              className="flex items-baseline gap-2 px-0.5 text-xs font-medium text-[var(--text-secondary)]"
            >
              {group.label}
              <span className="font-normal tabular-nums text-[var(--text-tertiary)]">
                {group.items.length}
              </span>
            </h3>
            <div className="surface divide-y divide-[var(--border)]">
              {shown.map((t) => (
                <TorrentCard
                  key={t.id}
                  torrent={t}
                  index={rankOf.get(t.id) ?? 0}
                  searchCategory={category}
                  grouped
                />
              ))}
              {hidden > 0 || open ? (
                <button
                  type="button"
                  onClick={() =>
                    setOpenQuality((prev) => {
                      const next = new Set(prev);
                      if (next.has(stateKey)) next.delete(stateKey);
                      else next.add(stateKey);
                      return next;
                    })
                  }
                  aria-expanded={open}
                  aria-label={
                    open
                      ? `Show only the best ${group.label} of ${heading}`
                      : `Show ${hidden} more ${group.label} of ${heading}`
                  }
                  className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left text-[12px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--text)] sm:px-4"
                >
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      open && "rotate-180",
                    )}
                  />
                  {open
                    ? `Show only the best ${group.label}`
                    : `${hidden} more ${group.label}`}
                </button>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  ) : (
    <div className="surface divide-y divide-[var(--border)]">
      {activeItems.map((t) => (
        <TorrentCard
          key={t.id}
          torrent={t}
          index={rankOf.get(t.id) ?? 0}
          searchCategory={category}
          grouped
        />
      ))}
    </div>
  );

  return (
    <section aria-labelledby={`${domId}-title`} className="space-y-2">
      {/*
        One poster per work, never per row. The rule that produced show-collapse
        still holds — twenty identical posters down the left edge is texture,
        not information — but the unit it applies to is the work, not the page.
        Several posters on a page is now the structure: each one heads a
        distinct thing, and no two of them are the same artwork.
      */}
      <div className="surface flex items-center gap-3 px-3 py-2.5 sm:px-4">
        <div className="relative w-11 shrink-0 overflow-hidden rounded-md sm:w-12">
          {posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={posterUrl}
              alt=""
              className="aspect-[2/3] w-full rounded-md bg-[var(--bg-muted)] object-cover"
            />
          ) : (
            // An initial, never an empty box: a grey rectangle is pixel-
            // identical to the loading skeleton.
            <div
              className="flex aspect-[2/3] w-full items-center justify-center rounded-md bg-[var(--bg-muted)]"
              aria-hidden
            >
              <span className="select-none text-base font-semibold text-[var(--text-tertiary)]">
                {heading.trim().charAt(0).toUpperCase() || "?"}
              </span>
            </div>
          )}
          {/* Sibling overlay, never a wrapper: the poster sits inside a header
              that also carries a heading link, and an `<a>` inside an `<a>` is
              invalid markup. */}
          {workHref ? (
            <Link
              href={workHref}
              tabIndex={-1}
              aria-hidden
              className="absolute inset-0 rounded-md"
            />
          ) : null}
        </div>
        <div className="min-w-0">
          <h2
            id={`${domId}-title`}
            title={titleAttr}
            className="truncate text-sm font-semibold text-[var(--text)]"
          >
            {workHref ? (
              <Link
                href={workHref}
                data-card-target="title"
                className="rounded-[4px] outline-none hover:text-[var(--accent-text)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {heading}
              </Link>
            ) : (
              heading
            )}
            {work.year ? (
              // Part of a film's identity, not trivia: *Dune* 1984 and *Dune*
              // 2021 are two works that would otherwise share a heading.
              //
              // The leading {" "} is load-bearing for assistive tech, not
              // decoration: `ml-*` is a CSS margin, and a screen reader
              // concatenates adjacent text nodes with no regard for it.
              // Without the space this heading announces as "Dune1984". The
              // margin is trimmed to keep the *visual* gap identical.
              <>
                {" "}
                <span className="ml-0.5 font-normal tabular-nums text-[var(--text-tertiary)]">
                  {work.year}
                </span>
              </>
            ) : null}
          </h2>
          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
            {workSubtitle({
              seasons: seasonCount(sections),
              releaseCount: work.items.length,
            })}
          </p>
        </div>
      </div>

      {switcher ? (
        <div className="space-y-2">
          <div
            role="tablist"
            // Several tab groups can now share a page, so "Seasons" alone would
            // announce two different shows' tabs identically — exactly the
            // confusion this whole change exists to remove.
            aria-label={`Seasons of ${heading}`}
            className={cn(
              "-mx-1 flex gap-1 overflow-x-auto px-1 py-1.5",
              // Sticky only when this card owns the page. Several sticky strips
              // would pile up on each other as you scroll past each work.
              soloWork &&
                "sticky top-0 z-20 bg-[var(--bg)]/95 backdrop-blur",
            )}
          >
            {switcher.map((section) => {
              const active = section.key === activeKey;
              return (
                <button
                  key={section.key}
                  type="button"
                  role="tab"
                  id={`${domId}-tab-${section.key}`}
                  aria-selected={active}
                  aria-controls={`${domId}-panel`}
                  data-season-tab={`${work.key}:${section.key}`}
                  onClick={() => setActiveSection(section.key)}
                  title={`${section.label} — ${heading}`}
                  aria-label={`${section.label} of ${heading}, ${section.items.length} releases`}
                  className={cn(
                    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "border-transparent bg-[var(--text)] text-[var(--bg)]"
                      : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text)]",
                  )}
                >
                  <span aria-hidden>{section.short}</span>
                  <span
                    aria-hidden
                    className={cn(
                      "tabular-nums",
                      active
                        ? "text-[var(--bg)]/70"
                        : "text-[var(--text-tertiary)]",
                    )}
                  >
                    {section.items.length}
                  </span>
                </button>
              );
            })}
          </div>
          <div
            role="tabpanel"
            id={`${domId}-panel`}
            aria-labelledby={
              activeKey ? `${domId}-tab-${activeKey}` : undefined
            }
            data-season-panel={`${work.key}:${activeKey ?? ""}`}
          >
            {releases}
          </div>
        </div>
      ) : (
        releases
      )}
    </section>
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
