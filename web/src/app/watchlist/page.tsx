import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { TfPageHeader } from "@/components/tf/page-header";
import { RecommendationRailSection } from "@/components/tf/recommendation-rail";
import { useCapabilities } from "@/lib/capabilities";
import { SEARCH_HREF } from "@/lib/navigation";
import { libraryPageSummary } from "@/components/library/library-state";
import { useWatchlist } from "./use-watchlist";
import { WatchlistList } from "./watchlist-list";
import { LibrarySkeleton } from "./watchlist-skeleton";
import { WatchlistAutomation } from "./watchlist-automation";

export default function WatchlistPage() {
  const capabilities = useCapabilities();
  const readOnly = !capabilities.canManage;
  const watchlist = useWatchlist(capabilities.ownerSession, readOnly);

  return (
    <PageQueryBoundary
      query={watchlist.query}
      skeleton={(visible) => <LibrarySkeleton visible={visible} />}
      errorTitle="Could not load your library"
      frame={(node) => <div className="container-app py-6 sm:py-8">{node}</div>}
    >
      {() => (
        <div className="container-app min-w-0 space-y-6 py-6 pb-[calc(var(--mobile-nav-h)+var(--safe-bottom)+1.5rem)] sm:py-8 sm:pb-8" data-library-page={readOnly ? "read-only" : "manage"}>
          <TfPageHeader
            title="Library"
            description={libraryPageSummary(watchlist.items)}
            actions={<div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={watchlist.refresh}>Refresh</Button>
              {!readOnly ? <Button asChild variant="outline" size="sm"><Link to={SEARCH_HREF}>Add titles</Link></Button> : null}
            </div>}
          />
          {!readOnly ? <WatchlistAutomation count={watchlist.items.length} /> : null}
          <WatchlistList
            items={watchlist.items}
            readOnly={readOnly}
            onUpdate={watchlist.update}
            onRemove={watchlist.remove}
            onRemoveMany={watchlist.removeMany}
            onRefresh={watchlist.refresh}
          />
          {!readOnly ? <RecommendationRailSection onAdded={watchlist.refresh} refreshKey={watchlist.items.length} /> : null}
        </div>
      )}
    </PageQueryBoundary>
  );
}
