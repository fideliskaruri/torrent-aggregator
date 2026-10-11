import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { DataList } from "@/components/tf/data-list";
import { BulkBar } from "@/components/tf/bulk-bar";
import { useSelection } from "@/components/tf/use-selection";
import { TfEmptyState } from "@/components/tf/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WatchlistItem } from "@/lib/api/watchlist-types";
import { SEARCH_HREF } from "@/lib/navigation";
import { openSearchOverlay } from "@/components/search/search-overlay";
import {
  itemMatchesLibraryStatus,
  libraryStatusCounts,
  LIBRARY_STATUSES,
  LIBRARY_STATUS_LABELS,
  sortLibraryItems,
  type LibraryStatus,
} from "@/components/library/library-state";
import { normalizeMediaType } from "@/lib/metadata/media-type";
import { GRID } from "@/components/browse/rail-layout";
import { cn } from "@/lib/utils";
import { WatchlistItemCard } from "./watchlist-item-card";
import { toast } from "@/lib/toast";

const KEY = (item: WatchlistItem) => item.id;
const TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "movie", label: "Movies" },
  { value: "tv", label: "Series" },
  { value: "anime", label: "Anime" },
] as const;

export function WatchlistList({
  items,
  readOnly,
  onUpdate,
  onRemove,
  onRemoveMany,
  onRefresh,
}: {
  items: WatchlistItem[];
  readOnly: boolean;
  onUpdate: (body: {
    id: string;
    status?: string;
    monitored?: boolean;
    fromSeason?: number;
    fromEpisode?: number;
    preferredResolution?: number | null;
  }) => Promise<WatchlistItem | null>;
  onRemove: (id: string) => Promise<void>;
  onRemoveMany: (ids: string[]) => Promise<void>;
  onRefresh: () => void;
}) {
  const [status, setStatus] = useState<LibraryStatus>("all");
  const [mediaType, setMediaType] = useState("all");
  const [query, setQuery] = useState("");
  const counts = libraryStatusCounts(items);
  const activeStatus = status === "all" || counts[status] > 0 ? status : "all";
  const visibleStatuses = LIBRARY_STATUSES.filter(
    (value) => value === "all" || counts[value] > 0,
  );
  const selectedItems = useMemo(
    () => sortLibraryItems(items.filter((item) => itemMatchesLibraryStatus(item, activeStatus))),
    [items, activeStatus],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return selectedItems.filter((item) => {
      const matchesTitle = !needle || item.title.toLocaleLowerCase().includes(needle);
      const matchesType =
        mediaType === "all" || normalizeMediaType(item.mediaType) === mediaType;
      return matchesTitle && matchesType;
    });
  }, [mediaType, query, selectedItems]);
  const selection = useSelection(filtered, KEY);
  const clearFilters = () => {
    setQuery("");
    setMediaType("all");
    setStatus("all");
  };
  const bulkRemove = async () => {
    try {
      await onRemoveMany(selection.selected.map((item) => item.id));
      selection.clear();
    } catch {
      toast.error("Some titles could not be removed. Check the list and try again.");
    }
  };
  const emptyTitle =
    activeStatus === "all"
      ? "Nothing in your library yet"
      : activeStatus === "downloaded"
        ? "Nothing downloaded yet"
        : `Nothing ${LIBRARY_STATUS_LABELS[activeStatus].toLocaleLowerCase()} yet`;
  const empty = (
    <TfEmptyState
      icon={Search}
      title={readOnly && activeStatus === "all" ? "Nothing in the library yet" : emptyTitle}
      description={readOnly ? "Browse or search for something, then request it." : "Search for a show or film, then add it from its title page."}
      actionLabel={readOnly ? "Go to Browse" : "Search"}
      actionHref={readOnly ? "/" : SEARCH_HREF}
      onAction={readOnly ? undefined : (event) => {
        event.preventDefault();
        openSearchOverlay();
      }}
    />
  );
  const noResults = Boolean(
    items.length &&
      !filtered.length &&
      (query.trim() || mediaType !== "all" || selectedItems.length),
  );

  return (
    <div className="space-y-4" data-library-list>
      <div className="space-y-3" data-library-filter-bar>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
            <span>Search titles</span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              className="min-h-11"
              aria-label="Search titles"
              type="search"
            />
          </label>
          <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
            <span>Type</span>
            <select
              value={mediaType}
              onChange={(event) => setMediaType(event.currentTarget.value)}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Filter by type"
              data-library-type
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status" data-library-status-chips>
          {visibleStatuses.map((value) => (
            <Button
              key={value}
              type="button"
              variant={activeStatus === value ? "secondary" : "ghost"}
              aria-pressed={activeStatus === value}
              onClick={() => setStatus(value)}
              className="min-h-11 px-3 text-xs"
              data-library-status-chip={value}
            >
              {LIBRARY_STATUS_LABELS[value]}
              <span className="tabular-nums text-subtle-foreground">{counts[value]}</span>
            </Button>
          ))}
        </div>
      </div>

      <DataList
        items={filtered}
        getKey={KEY}
        selection={readOnly ? undefined : selection}
        selectionLayout="overlay"
        noResults={noResults}
        onClearFilters={clearFilters}
        empty={empty}
        className={cn(GRID, "space-y-0")}
        renderRow={(item) => (
          <WatchlistItemCard
            item={item}
            readOnly={readOnly}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onRefresh={onRefresh}
          />
        )}
      />
      {!readOnly ? (
        <BulkBar
          count={selection.selected.length}
          onClear={selection.clear}
          actions={
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={selection.selected.some((item) => item.hasFiles || item.ready)}
              onClick={() => void bulkRemove()}
            >
              Remove selected
            </Button>
          }
        />
      ) : null}
    </div>
  );
}
