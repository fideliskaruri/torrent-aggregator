import { SearchX } from "lucide-react";
import { TfEmptyState } from "@/components/tf/empty-state";
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
 * Shared results surface — one TMDB title card per work, best match first.
 * No torrent actions: click opens the title page.
 */
export function TitleResultsList({
  titles,
  loading,
  query,
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
      <div data-results-empty>
        <TfEmptyState
          icon={SearchX}
          title={`No titles found for "${query.trim()}"`}
          description="Try another spelling."
          className="py-12"
        />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-results-list>
      {titles.map((title, i) => (
        <TitleResultCard
          key={title.key}
          title={title}
          featured={i === 0}
        />
      ))}
    </div>
  );
}
