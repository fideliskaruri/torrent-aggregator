import { useState } from "react";
import { Link } from "react-router";
import { ArrowDownToLine, Radar, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { MediaPoster } from "@/components/browse/media-poster-card";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { WatchStateChip } from "@/components/title/watch-state";
import { useApiMutation } from "@/hooks/use-api-mutation";
import type { OnDemandResponse, WatchlistItem } from "@/lib/api/watchlist-types";
import { SEARCH_HREF } from "@/lib/navigation";
import { isSeriesMediaType, searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { titlePath } from "@/components/title/work-key";
import { toast } from "@/lib/toast";
import { libraryItemState } from "@/components/library/library-state";
import { activityLine, positionLine } from "./card-state";
import { removeFromLibraryCopy } from "@/lib/library/remove-copy";
import { formatEpisodeLabel } from "@/lib/library/cursor";
import { WatchlistDeleteFiles } from "./watchlist-delete-files";
import { toastDownloadOutcome } from "@/components/releases/download-outcome-toast";

export function WatchlistItemCard({
  item,
  readOnly,
  onUpdate,
  onRemove,
  onRefresh,
}: {
  item: WatchlistItem;
  readOnly: boolean;
  onUpdate: (body: { id: string; status?: string; monitored?: boolean; fromSeason?: number; fromEpisode?: number }) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRefresh: () => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { ensureDownloadSetup } = useDownloadSetup();
  const onDemand = useApiMutation<{
    watchListItemId: string;
    season: number;
    episode: number;
  }, OnDemandResponse>("/api/library/ondemand");
  const series = isSeriesMediaType(item.mediaType);
  const titleHref = item.workKey?.trim()
    ? titlePath(item.workKey, { title: item.title, mediaType: item.mediaType, season: item.cursorSeason ?? item.fromSeason })
    : null;
  const category = searchCategoryForMediaType(item.mediaType) ?? "tv";
  const state = libraryItemState(item);
  const activity = activityLine(item);
  const position = positionLine(item);
  const cursor = item.cursorSeason != null && item.cursorEpisode != null
    ? { season: item.cursorSeason, episode: item.cursorEpisode }
    : null;
  const label = cursor ? formatEpisodeLabel(cursor.season, cursor.episode) : null;
  const removeCopy = removeFromLibraryCopy(item.title);

  async function downloadNext() {
    if (!cursor || !(await ensureDownloadSetup())) return;
    try {
      const result = await onDemand.run({
        watchListItemId: item.id,
        season: cursor.season,
        episode: cursor.episode,
      });
      if (result?.ok) {
        toast.success(result.message ?? `Queued ${label}`);
        onRefresh();
      } else {
        toastDownloadOutcome({
          ok: false,
          message: result?.message ?? "On-demand grab failed",
          pick: result?.workKey ? {
            workKey: result.workKey,
            title: item.title,
            season: cursor.season,
            episode: cursor.episode,
            query: result.noReleaseFound?.manualSearchQuery ?? null,
            onPicked: onRefresh,
          } : null,
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not queue this episode. Try again.");
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await onRemove(item.id);
      setConfirmRemove(false);
      toast.success("Removed from library");
    } catch {
      toast.error("Could not remove this title. Try again.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <article className="surface flex min-w-0 items-start gap-3 overflow-hidden p-3.5" data-library-card>
      <MediaPoster variant="library" src={item.posterUrl} title={item.title}>
        {titleHref ? <Link to={titleHref} data-library-card-link aria-label={`Open ${item.title}`} className="absolute inset-0 z-[1] rounded-sm" /> : null}
      </MediaPoster>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {titleHref ? <Link to={titleHref} data-library-card-link className="block min-h-11 rounded-sm focus-visible:ring-2 focus-visible:ring-ring lg:min-h-0">
              <h2 className="line-clamp-2 text-[15px] font-medium leading-snug text-foreground hover:text-brand-foreground">{item.title}</h2>
            </Link> : <h2 className="line-clamp-2 text-[15px] font-medium leading-snug text-foreground">{item.title}</h2>}
            <p className="mt-0.5 text-xs capitalize text-subtle-foreground">{item.mediaType}{readOnly ? "" : item.ready ? " · ready" : item.monitored ? " · watching" : " · paused"}</p>
            <WatchStateChip state={item.watchState} nextUp={item.jellyfinNextUp} className="mt-1.5" />
          </div>
          {readOnly ? null : item.ready ? <WatchlistDeleteFiles item={item} onDeleted={onRefresh} /> : <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove from library" onClick={() => setConfirmRemove(true)} className="shrink-0 text-subtle-foreground hover:text-destructive"><Trash2 className="size-4" /></Button>}
        </div>
        {readOnly ? null : (
          <>
            <div className="space-y-1 rounded-md border border-border bg-muted/50 px-3 py-2.5">
              <p className="text-[13px] font-medium text-foreground">{state.label}</p>
              <p className="text-xs leading-relaxed text-subtle-foreground">{state.detail}</p>
            </div>
            {series && (position || activity) ? <p data-card-state className="flex flex-wrap items-center gap-x-1.5 text-xs">
              {position ? <span className="tabular-nums text-muted-foreground">{position}</span> : null}
              {position && activity ? <span aria-hidden className="text-subtle-foreground">·</span> : null}
              {activity ? <span className="text-subtle-foreground">{activity.text}</span> : null}
            </p> : null}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
              {series && label ? <Button type="button" size="sm" disabled={onDemand.pending} onClick={() => void downloadNext()}>
                <ArrowDownToLine className="size-3.5" /> Download {label}
              </Button> : null}
              <Button type="button" size="sm" variant={item.monitored ? "secondary" : "ghost"} aria-pressed={Boolean(item.monitored)} aria-label={item.monitored ? `Stop watching ${item.title}` : `Start watching ${item.title}`} onClick={() => void onUpdate({ id: item.id, monitored: !item.monitored })}>
                <Radar className="size-3.5" /> {item.monitored ? "Watching" : "Follow"}
              </Button>
              <Button asChild type="button" size="sm" variant="ghost">
                <Link to={`${SEARCH_HREF}?q=${encodeURIComponent(item.title)}&category=${category}`}><Search className="size-3.5" /> Search</Link>
              </Button>
              <Label className="flex items-center gap-1.5 text-xs font-normal text-subtle-foreground">
                Status
                <Select value={item.status} onValueChange={(status) => void onUpdate({ id: item.id, status })}>
                  <SelectTrigger size="sm" aria-label={`Status for ${item.title}`} data-library-status><SelectValue /></SelectTrigger>
                  <SelectContent>{["watching", "planned", "completed", "dropped"].map((status) => <SelectItem key={status} value={status} className="capitalize">{status}</SelectItem>)}</SelectContent>
                </Select>
              </Label>
              {series ? <Label className="flex items-center gap-1.5 text-xs font-normal text-subtle-foreground">
                Start at season
                <Input type="number" min={1} max={99} className="h-8 w-16 text-xs" defaultValue={item.fromSeason ?? item.cursorSeason ?? ""} onBlur={(event) => {
                  const season = Number.parseInt(event.currentTarget.value, 10);
                  if (Number.isInteger(season) && season >= 1 && season !== item.fromSeason) void onUpdate({ id: item.id, fromSeason: season, fromEpisode: 1 });
                }} />
              </Label> : null}
            </div>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        contentData={{ "data-remove-from-library": true }}
        title={removeCopy.title}
        description={removeCopy.body}
        variant="destructive"
        busy={removing}
        confirmLabel={removeCopy.confirmLabel}
        onConfirm={() => void remove()}
      />
    </article>
  );
}
