"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Rows3,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import type { SearchResponse, TorrentSourceId } from "@/lib/torrents/types";
import { TorrentCard } from "./torrent-card";
import { cn } from "@/lib/utils";
import { useUiPreferences } from "@/components/providers/ui-preferences";
import { Button } from "@/components/ui/button";

const ALL_SOURCES: { id: TorrentSourceId; label: string }[] = [
  { id: "nyaa", label: "Nyaa" },
  { id: "apibay", label: "TPB" },
  { id: "torrentscsv", label: "CSV" },
  { id: "yts", label: "YTS" },
  { id: "1337x", label: "1337x" },
];

const DEFAULT_PAGE_SIZE = 20;

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
   * Build home search URL (`/?q=…`). Non-page overrides clear `page` so
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
      return `/?${params.toString()}`;
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
      resolution,
      codec,
      maxSizeGb,
      sourcesParam,
      page,
      pageSize,
    ],
  );

  useEffect(() => {
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

  if (loading) {
    return (
      <div className="space-y-0 border border-[var(--border)] rounded-[var(--radius)] overflow-hidden">
        <div className="px-4 py-3 text-[12px] text-[var(--text-tertiary)] border-b border-[var(--border)]">
          Searching sources…
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="px-4 py-3.5 border-b border-[var(--border)] last:border-0 flex gap-3"
          >
            <div className="skeleton w-12 sm:w-14 aspect-[2/3] shrink-0" />
            <div className="flex-1 space-y-2 py-0.5">
              <div className="skeleton h-3 w-1/3" />
              <div className="skeleton h-4 w-4/5" />
              <div className="skeleton h-3 w-1/2" />
            </div>
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
    minSeeders || resolution || codec || maxSizeGb || sourcesParam,
  );

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
                <span className="text-[var(--border-strong)]">·</span>
                <span className="tabular-nums">{data.tookMs}ms</span>
                {data.cached && (
                  <>
                    <span className="text-[var(--border-strong)]">·</span>
                    <span>cached</span>
                  </>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
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
                      title={src?.error}
                      className={cn(
                        "badge cursor-pointer transition-colors",
                        active && "badge-accent",
                        src?.error && active && "badge-danger",
                      )}
                    >
                      {s.label}
                      {src != null ? ` ${src.count}` : ""}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 border-t border-[var(--border)]">
              <FilterField
                label="Min seeders"
                value={minSeeders}
                placeholder="5"
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
          <p className="text-sm text-[var(--text-secondary)]">
            No results for “{query}”
          </p>
          <p className="text-[12px] text-[var(--text-tertiary)] mt-1.5">
            Try fewer filters or another category.
          </p>
          {data?.sources?.some((s) => s.error) && (
            <ul className="mt-4 text-left max-w-md mx-auto space-y-1 text-[11px] text-[var(--text-tertiary)]">
              {data.sources
                .filter((s) => s.error)
                .map((s) => (
                  <li key={s.id}>
                    <span className="text-[var(--danger)]">{s.id}</span>:{" "}
                    {s.error}
                  </li>
                ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div className="surface overflow-x-hidden divide-y divide-[var(--border)]">
            {data.results.map((t, i) => (
              <TorrentCard
                key={t.id}
                torrent={t}
                index={(currentPage - 1) * (data.pageSize ?? pageSize) + i}
                searchCategory={category}
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
