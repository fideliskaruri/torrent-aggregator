import { useCallback, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { DataList } from "@/components/tf/data-list";
import { FilterBar, type FilterField } from "@/components/tf/filter-bar";
import { BulkBar } from "@/components/tf/bulk-bar";
import { useSelection } from "@/components/tf/use-selection";
import { TfEmptyState } from "@/components/tf/empty-state";
import { Button } from "@/components/ui/button";
import type { WatchlistItem } from "@/lib/api/watchlist-types";
import { SEARCH_HREF } from "@/lib/navigation";
import { openSearchOverlay } from "@/components/search/search-overlay";
import { LIBRARY_TAB_LABELS, DEFAULT_LIBRARY_TAB, filterByTab, tabCounts, visibleTabs, type LibraryTab } from "./library-tabs";
import { WatchlistItemCard } from "./watchlist-item-card";
import { toast } from "@/lib/toast";

const KEY = (item: WatchlistItem) => item.id;
const FILTER_FIELDS: readonly FilterField<WatchlistItem>[] = [
  { key: "title", label: "Search titles", kind: "search" },
  { key: "mediaType", label: "Type", kind: "select", options: [
    { value: "movie", label: "Movie" },
    { value: "tv", label: "Series" },
    { value: "anime", label: "Anime" },
  ] },
];

export function WatchlistList({
  items,
  readOnly,
  onUpdate,
  onRemove,
  onRefresh,
  automationEnabled,
}: {
  items: WatchlistItem[];
  readOnly: boolean;
  onUpdate: (body: { id: string; status?: string; monitored?: boolean; fromSeason?: number; fromEpisode?: number }) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRefresh: () => void;
  automationEnabled: boolean;
}) {
  const [tab, setTab] = useState<LibraryTab>(DEFAULT_LIBRARY_TAB);
  const [predicate, setPredicate] = useState<(item: WatchlistItem) => boolean>(() => () => true);
  const tabs = visibleTabs(items);
  const activeTab = tabs.includes(tab) ? tab : DEFAULT_LIBRARY_TAB;
  const counts = tabCounts(items);
  const tabItems = useMemo(() => filterByTab(items, activeTab), [items, activeTab]);
  const filtered = useMemo(() => tabItems.filter(predicate), [tabItems, predicate]);
  const selection = useSelection(filtered, KEY);
  const filterChange = useCallback((next: (item: WatchlistItem) => boolean) => setPredicate(() => next), []);
  const clearFilters = useCallback(() => setPredicate(() => () => true), []);
  const bulkRemove = async () => {
    try {
      await Promise.all(selection.selected.map((item) => onRemove(item.id)));
      selection.clear();
    } catch {
      toast.error("Some titles could not be removed. Check the list and try again.");
    }
  };
  const empty = items.length ? (
    <TfEmptyState icon={Search} title={`Nothing in ${LIBRARY_TAB_LABELS[activeTab]}`} description="Choose All or adjust the filters to see other titles." />
  ) : (
    <TfEmptyState icon={Search} title={readOnly ? "Nothing in the library yet" : "Nothing in your library yet"} description={readOnly ? "Browse or search for something, then request it." : "Search for a show or film, then add it from its title page."} actionLabel={readOnly ? "Go to Browse" : "Search"} actionHref={readOnly ? "/" : SEARCH_HREF} onAction={readOnly ? undefined : (event) => {
      event.preventDefault();
      openSearchOverlay();
    }} />
  );

  return (
    <div className="space-y-5" data-library-list>
      <Tabs value={activeTab} onValueChange={(value) => setTab(value as LibraryTab)} className="min-w-0 gap-4">
        <ScrollArea className="min-w-0">
          <TabsList aria-label="Library" className="h-auto" data-library-tabs>
            {tabs.map((id) => <TabsTrigger key={id} value={id} data-library-tab={id} className="h-11 flex-none gap-1.5 px-3 text-[13px]">
              {LIBRARY_TAB_LABELS[id]} <span className="tabular-nums text-subtle-foreground">{counts[id]}</span>
            </TabsTrigger>)}
          </TabsList>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
        <TabsContent value={activeTab} className="min-w-0">
          <FilterBar fields={FILTER_FIELDS} onPredicateChange={filterChange}>
            {({ activeCount }) => (
              <div className="space-y-4">
                <DataList
                  items={filtered}
                  getKey={KEY}
                  selection={readOnly ? undefined : selection}
                  noResults={Boolean(items.length && (activeCount || tabItems.length))}
                  onClearFilters={clearFilters}
                  empty={empty}
                  className="grid gap-3 sm:grid-cols-2"
                  renderRow={(item) => <WatchlistItemCard item={item} readOnly={readOnly} onUpdate={onUpdate} onRemove={onRemove} onRefresh={onRefresh} automationEnabled={automationEnabled} />}
                />
                {!readOnly ? <BulkBar
                  count={selection.selected.length}
                  onClear={selection.clear}
                  actions={<Button type="button" variant="destructive" size="sm" disabled={selection.selected.some((item) => item.ready)} onClick={() => void bulkRemove()}>Remove selected</Button>}
                /> : null}
              </div>
            )}
          </FilterBar>
        </TabsContent>
      </Tabs>
    </div>
  );
}
