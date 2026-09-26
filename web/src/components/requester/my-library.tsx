import { Library } from "lucide-react";
import { PosterImage } from "@/components/browse/poster-image";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { parseLibrary } from "./requests";

/** What the owner already has, read-only: no playback, no folders, no files. */
export function MyLibrary() {
  const list = useApiQuery("/api/requester/library", {
    select: parseLibrary,
    emptyOnUnauthorized: false,
    refreshMs: 120_000,
  });
  const titles = list.data ?? [];

  return (
    <div className="space-y-5" data-requester-library>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Library</h1>
        <p className="text-sm text-[var(--text-secondary)]">Titles that are already here. Ask the owner how to watch them.</p>
      </div>

      {list.loading ? (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6" aria-busy="true" aria-label="Loading library">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} aria-hidden>
              <div className="skeleton aspect-[2/3] w-full rounded-md" />
              <div className="skeleton mt-2 h-3 w-3/4 rounded" />
            </li>
          ))}
        </ul>
      ) : list.error && titles.length === 0 ? (
        <TfErrorState title="Couldn't load the library" message={list.error} onRetry={list.refetch} retrying={list.refreshing} />
      ) : titles.length === 0 ? (
        <TfEmptyState
          icon={Library}
          title="Nothing here yet"
          description="Search for a movie or show and request it."
          actionLabel="Search titles"
          actionHref="/"
        />
      ) : (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6" data-requester-library-list>
          {titles.map((title) => (
            <li key={title.key} className="min-w-0" data-requester-library-item={title.key}>
              <div className="relative aspect-[2/3] w-full overflow-hidden rounded-md bg-[var(--bg-muted)]">
                <PosterImage src={title.posterUrl} title={title.title} sizes="(min-width: 768px) 140px, 30vw" />
              </div>
              <p className="mt-1.5 line-clamp-2 text-xs font-medium text-[var(--text)]">{title.title}</p>
              {title.year ? <p className="text-[11px] tabular-nums text-[var(--text-tertiary)]">{title.year}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
