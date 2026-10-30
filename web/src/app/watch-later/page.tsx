import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Bookmark, ChevronDown, MoreHorizontal } from "lucide-react";
import { useApiQuery } from "@/hooks/use-api-query";
import { useCapabilities } from "@/lib/capabilities";
import { toast } from "@/lib/toast";
import {
  WATCH_LATER_GROUPS,
  WATCH_LATER_URL,
  follow,
  groupWatchLater,
  parseWatchLater,
  releaseLine,
  removeFromWatchlist,
  type WatchLaterGroupKey,
  type WatchLaterItem,
  type WatchLaterResponse,
} from "@/lib/api/watch-later";
import { DOWNLOADS_HREF } from "@/lib/navigation";
import { titlePath } from "@/components/title/work-key";
import { MediaPoster, MediaPosterCaption, MediaPosterSkeleton } from "@/components/browse/media-poster-card";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const GRID =
  "grid gap-x-4 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(132px,1fr))] sm:[grid-template-columns:repeat(auto-fill,minmax(152px,1fr))]";
const POSTER_SIZES = "(min-width: 640px) 200px, 45vw";
const ACTION_HEIGHT = "h-11 w-full sm:h-9";

function hrefFor(item: WatchLaterItem): string {
  return titlePath(item.workKey, {
    title: item.title,
    year: item.year,
    mediaType: item.mediaType,
    series: item.series,
  });
}

type Action =
  | { kind: "follow"; label: string; done: string }
  | { kind: "link"; label: string; to: string }
  | { kind: "none"; note: string };

function actionFor(item: WatchLaterItem, canDownload: boolean): Action {
  const open: Action = { kind: "link", label: "Open", to: hrefFor(item) };
  if (item.unavailable) return { kind: "none", note: "No longer in the catalog" };
  switch (item.state) {
    case "downloading":
      return canDownload ? { kind: "link", label: "See download", to: DOWNLOADS_HREF } : open;
    case "inLibrary":
      return open;
    case "coming":
    case "inCinemas":
      return canDownload
        ? { kind: "follow", label: "Get it when it's out", done: `${item.title} will download when it's out` }
        : open;
    default:
      if (!canDownload) return open;
      if (item.series) return { kind: "link", label: "Choose episodes", to: hrefFor(item) };
      return { kind: "follow", label: "Download", done: `Finding a download for ${item.title}` };
  }
}

function statusLine(item: WatchLaterItem): string {
  if (item.newEpisodes) return "New episodes";
  if (item.watched) return "Watched";
  switch (item.state) {
    case "downloading":
      return "Downloading";
    case "inLibrary":
      return "Ready to watch";
    case "coming":
    case "inCinemas":
      return releaseLine(item) ?? "Coming soon";
    default:
      return item.year ? String(item.year) : "Out now";
  }
}

function WatchLaterCard({
  item,
  canDownload,
  canManage,
  busy,
  onFollow,
  onRemove,
}: {
  item: WatchLaterItem;
  canDownload: boolean;
  canManage: boolean;
  busy: boolean;
  onFollow: (item: WatchLaterItem, done: string) => void;
  onRemove: (item: WatchLaterItem) => void;
}) {
  const action = actionFor(item, canDownload);
  const gated = item.state === "coming" || item.state === "inCinemas";
  return (
    <li data-watch-later-item={item.watchItemId} className="group/card flex min-w-0 flex-col">
      <div className="relative">
        <Link
          to={hrefFor(item)}
          className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MediaPoster
            variant="rail"
            src={item.posterUrl}
            title={item.title}
            gated={gated}
            sizes={POSTER_SIZES}
            className="transition-[border-color] duration-150 group-hover:border-input"
          />
          <MediaPosterCaption title={item.title} subtitle={statusLine(item)} />
        </Link>
        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label={`More for ${item.title}`}
                className="absolute right-1.5 top-1.5 size-11 bg-background/85 backdrop-blur-sm transition-opacity sm:size-9 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/card:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:data-[state=open]:opacity-100"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onRemove(item)}>Remove from watchlist</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className="mt-2">
        {action.kind === "follow" ? (
          <Button
            size="sm"
            variant="outline"
            className={ACTION_HEIGHT}
            disabled={busy}
            onClick={() => onFollow(item, action.done)}
          >
            {busy ? "Starting" : action.label}
          </Button>
        ) : action.kind === "link" ? (
          <Button asChild size="sm" variant="outline" className={ACTION_HEIGHT}>
            <Link to={action.to}>{action.label}</Link>
          </Button>
        ) : (
          <p className="flex h-11 items-center text-[12px] text-subtle-foreground sm:h-9">{action.note}</p>
        )}
      </div>
    </li>
  );
}

function WatchLaterSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading your watchlist" className={GRID}>
      {Array.from({ length: 10 }, (_, i) => (
        <li key={i}>
          <MediaPosterSkeleton variant="rail" />
        </li>
      ))}
    </ul>
  );
}

function GroupHeading({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <h2 id={id} className="text-[15px] font-semibold text-foreground">
      {title} <span className="font-normal tabular-nums text-subtle-foreground">{count}</span>
    </h2>
  );
}

export default function WatchLaterPage() {
  const { canDownload, canManage } = useCapabilities();
  const query = useApiQuery<WatchLaterResponse>(WATCH_LATER_URL, {
    refreshMs: 60_000,
    emptyOnUnauthorized: false,
    select: parseWatchLater,
  });
  const { refetch } = query;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const items = useMemo(
    () => (query.data?.items ?? []).filter((i) => !hidden.has(i.watchItemId)),
    [query.data, hidden],
  );
  const groups = useMemo(() => groupWatchLater(items), [items]);

  const setHiddenFlag = useCallback((id: string, on: boolean) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const onFollow = useCallback(
    async (item: WatchLaterItem, done: string) => {
      setBusy(item.watchItemId);
      try {
        await follow(item);
        setHiddenFlag(item.watchItemId, true);
        toast.success(done, { description: "Follow it in Downloads." });
        refetch();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Could not start ${item.title}. Try again.`);
      } finally {
        setBusy(null);
      }
    },
    [refetch, setHiddenFlag],
  );

  const onRemove = useCallback(
    async (item: WatchLaterItem) => {
      setHiddenFlag(item.watchItemId, true);
      try {
        const result = await removeFromWatchlist(item);
        if (result === "hasFiles") {
          setHiddenFlag(item.watchItemId, false);
          toast.error(`${item.title} has files on disk`, {
            description: "Remove it from Library if you want the files gone too.",
          });
          return;
        }
        toast.success(`Removed ${item.title} from your watchlist`);
        refetch();
      } catch (error) {
        setHiddenFlag(item.watchItemId, false);
        toast.error(error instanceof Error ? error.message : `Could not remove ${item.title}. Try again.`);
      }
    },
    [refetch, setHiddenFlag],
  );

  const renderGrid = (key: WatchLaterGroupKey) => (
    <ul className={GRID}>
      {groups[key].map((item) => (
        <WatchLaterCard
          key={item.watchItemId}
          item={item}
          canDownload={canDownload}
          canManage={canManage}
          busy={busy === item.watchItemId}
          onFollow={onFollow}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );

  let body: ReactNode;
  if (!query.data && (query.loading || !query.settled) && !query.error) {
    body = <WatchLaterSkeleton />;
  } else if (query.error && !query.data) {
    body = (
      <TfErrorState
        title="Could not load your watchlist"
        message="The server did not answer. Check it is running, then try again."
        onRetry={refetch}
      />
    );
  } else if (!items.length) {
    body = (
      <TfEmptyState
        icon={Bookmark}
        title="Nothing saved to watch later"
        description="Save a film or show from its page. It shows up here with what's out now and what's coming."
        actionLabel="Browse titles"
        actionHref="/"
      />
    );
  } else {
    const open = WATCH_LATER_GROUPS.filter((g) => g.key !== "watched" && groups[g.key].length);
    body = (
      <div className="space-y-10">
        {query.data?.jellyfinStale ? (
          <p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
            Jellyfin did not answer, so what you have watched may be out of date.
          </p>
        ) : null}
        {open.map((g) => (
          <section key={g.key} aria-labelledby={`wl-${g.key}`} className="space-y-4">
            <GroupHeading id={`wl-${g.key}`} title={g.title} count={groups[g.key].length} />
            {renderGrid(g.key)}
          </section>
        ))}
        {groups.watched.length ? (
          <Collapsible defaultOpen={!open.length} className="group/watched space-y-4">
            <h2>
              <CollapsibleTrigger className="-ml-1 flex min-h-11 items-center gap-2 rounded-md px-1 text-[15px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Watched
                <span className="font-normal tabular-nums text-subtle-foreground">{groups.watched.length}</span>
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]/watched:rotate-180" />
              </CollapsibleTrigger>
            </h2>
            <CollapsibleContent>{renderGrid("watched")}</CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    );
  }

  return (
    <div className="container-app min-w-0 space-y-6 py-6 sm:py-8" data-watch-later-page>
      <TfPageHeader title="Watchlist" />
      {body}
    </div>
  );
}
