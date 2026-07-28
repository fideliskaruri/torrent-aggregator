"use client";

import { SearchX } from "lucide-react";
import type { TitleResult } from "./group-titles";
import {
  TitleResultCard,
  TitleResultCardSkeleton,
} from "./title-result-card";

interface TitleResultsListProps {
  titles: TitleResult[];
  loading: boolean;
  query: string;
  searchCategory?: string;
  /** Overlay renders a denser skeleton count than the full page. */
  skeletonCount?: number;
}

/**
 * The shared results surface — one card per work, best match first, the rest
 * in server rank order. No toolbar, no counts, no filters: the query is the
 * control, and the cards are the answer.
 *
 * Skeletons occupy the real cards' geometry so results swapping in never shift
 * the page (no CLS). The full skeleton shows only on a cold load (`loading`
 * with nothing to show yet); once cards exist a refetch leaves them in place.
 */
export function TitleResultsList({
  titles,
  loading,
  query,
  searchCategory,
  skeletonCount = 6,
}: TitleResultsListProps) {
  if (loading && titles.length === 0) {
    return (
      <div className="space-y-3" aria-busy data-results-loading>
        <TitleResultCardSkeleton featured />
        {Array.from({ length: Math.max(0, skeletonCount - 1) }).map((_, i) => (
          <TitleResultCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (titles.length === 0) {
    if (!query.trim()) return null;
    return (
      <div className="surface px-5 py-12 text-center" data-results-empty>
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
          <SearchX className="h-5 w-5" aria-hidden />
        </div>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          Nothing found for “{query.trim()}”
        </p>
        <p className="mt-1.5 text-[12px] text-[var(--text-tertiary)]">
          Try another spelling.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-results-list>
      {titles.map((title, i) => (
        <TitleResultCard
          key={title.key}
          title={title}
          searchCategory={searchCategory}
          featured={i === 0}
        />
      ))}
    </div>
  );
}
