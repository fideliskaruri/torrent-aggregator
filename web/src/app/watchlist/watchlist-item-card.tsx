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
import { useStorageCapOverride } from "@/components/storage/use-storage-cap-override";
import { StorageCapDialog } from "@/components/storage/storage-cap-dialog";
import { parseStorageOverrideFacts, StorageLimitError } from "@/lib/library/storage-override";
import { sendErrorFromBody } from "@/lib/api-json";
import { WatchStateChip } from "@/components/title/watch-state";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { send } from "@/lib/api";
import type { OnDemandResponse, WatchlistItem } from "@/lib/api/watchlist-types";
import { SEARCH_HREF } from "@/lib/navigation";
import { isSeriesMediaType, searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { titleHrefForName, titlePath } from "@/components/title/work-key";
import { useSession } from "@/components/providers/session-provider";
import { toast } from "@/lib/toast";
import { libraryItemState } from "@/components/library/library-state";
import { activityLine, needsAttention, positionLine } from "./card-state";
import { removeFromLibraryCopy } from "@/lib/library/remove-copy";
import { CheckSchedule } from "@/components/library/check-schedule";
import { WatchlistDeleteFiles } from "./watchlist-delete-files";
import { toastDownloadOutcome } from "@/components/releases/download-outcome-toast";

export function WatchlistItemCard({
  item,
  readOnly,
  art,
  onUpdate,
  onRemove,
  onRefresh,
  automationEnabled,
}: {
  item: WatchlistItem;
  readOnly: boolean;
  art: string | null;
  onUpdate: (body: { id: string; status?: string; monitored?: boolean; fromSeason?: number; fromEpisode?: number }) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRefresh: () => void;
  automationEnabled: boolean;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [sending, setSending] = useState(false);
  const { data: session } = useSession();
  const { ensureDownloadSetup } = useDownloadSetup();
  const capOverride = useStorageCapOverride();
  const onDemand = useApiMutation<{
    watchListItemId: string;
    season: number;
    episode: number;
  }, OnDemandResponse>("/api/library/ondemand");
  const series = isSeriesMediaType(item.mediaType);
  const titleHref = item.workKey
    ? titlePath(item.workKey, { title: item.title, mediaType: item.mediaType, season: item.cursorSeason ?? item.fromSeason })
    : titleHrefForName(item.title, { mediaType: item.mediaType, season: item.cursorSeason ?? item.fromSeason });
  const category = searchCategoryForMediaType(item.mediaType) ?? "tv";
  const state = libraryItemState(item, { sending });
  const activity = activityLine(item);
  const position = positionLine(item);
  const label = item.cursorSeason != null && item.cursorEpisode != null
    ? `S${String(item.cursorSeason).padStart(2, "0")}E${String(item.cursorEpisode).padStart(2, "0")}`
    : null;

  async function downloadNext() {
    if (!label || !(await ensureDownloadSetup())) return;
    try {
      const result = await onDemand.run({
        watchListItemId: item.id,
        season: item.cursorSeason ?? 1,
        episode: item.cursorEpisode ?? 1,
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
            season: item.cursorSeason ?? 1,
            episode: item.cursorEpisode ?? 1,
            query: result.noReleaseFound?.manualSearchQuery ?? null,
            onPicked: onRefresh,
          } : null,
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not queue this episode. Try again.");
    }
  }

  async function sendLatest() {
    if (!item.latestReleaseMagnet) return;
    if (!session) {
      toast.error("Sign in to send to your client");
      return;
    }
    setSending(true);
    try {
      const outcome = await capOverride.run(async ({ overrideStorageCap }) => {
        const response = await send<{ ok?: boolean; message?: string; error?: string; storage?: unknown }>(
          "/api/torrent/send",
          {
            method: "POST",
            body: {
              magnet: item.latestReleaseMagnet,
              name: item.latestReleaseTitle || item.title,
              source: "watchlist",
              watchListItemId: item.id,
              ...(overrideStorageCap ? { overrideStorageCap: true } : {}),
            },
          },
        );
        if (!response.ok || response.data?.ok === false) {
          const storage = parseStorageOverrideFacts(response.data?.storage);
          if (storage?.overridable) {
            throw new StorageLimitError(response.data?.message ?? "Storage limit", storage);
          }
        }
        return { response, body: response.data };
      });
      if (outcome.status === "cancelled") return;
      const { response, body } = outcome.value;
      if (response.ok && body?.ok !== false) toast.success(body?.message ?? "Sent to client");
      else toast.error(sendErrorFromBody(body, response.status).message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send this release. Try again.");
    } finally {
      setSending(false);
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
      <MediaPoster variant="library" src={item.posterUrl ?? art} title={item.title}>
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
          {readOnly ? null : item.ready ? <WatchlistDeleteFiles item={item} onDeleted={onRefresh} iconOnly /> : <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove from library" onClick={() => setConfirmRemove(true)} className="shrink-0 text-subtle-foreground hover:text-destructive"><Trash2 className="size-4" /></Button>}
        </div>
        {readOnly ? null : (
          <>
            <div className="space-y-1 rounded-md border border-border bg-muted/50 px-3 py-2.5">
              <p className="text-[13px] font-medium text-foreground">{state.label}</p>
              <p className="text-xs leading-relaxed text-subtle-foreground">{state.detail}</p>
              {item.lastEpisode ? <p className="text-xs text-subtle-foreground">Previous: <span className="tabular-nums text-muted-foreground">{item.lastEpisode}</span></p> : null}
            </div>
            <CheckSchedule {...item} automationEnabled={automationEnabled} />
            {series && (position || activity) ? <p data-card-state data-card-attention={needsAttention(item) ? "true" : undefined} className="flex flex-wrap items-center gap-x-1.5 text-xs">
              {position ? <span className="tabular-nums text-muted-foreground">{position}</span> : null}
              {position && activity ? <span aria-hidden className="text-subtle-foreground">·</span> : null}
              {activity ? <span className={activity.kind === "update" ? "font-medium text-brand-foreground" : "text-subtle-foreground"}>{activity.text}</span> : null}
            </p> : null}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
              {series && label ? <Button type="button" size="sm" disabled={onDemand.pending} onClick={() => void downloadNext()}>
                <ArrowDownToLine className="size-3.5" /> Download {label}
              </Button> : null}
              <Button type="button" size="sm" variant={item.monitored ? "secondary" : "ghost"} aria-pressed={Boolean(item.monitored)} aria-label={item.monitored ? `Stop watching ${item.title}` : `Start watching ${item.title}`} onClick={() => void onUpdate({ id: item.id, monitored: !item.monitored })}>
                <Radar className="size-3.5" /> {item.monitored ? "Watching" : "Follow"}
              </Button>
              <Button asChild type="button" size="sm" variant="ghost">
                <Link to={`${SEARCH_HREF}?q=${encodeURIComponent(item.nextEpisodeHint || item.title)}&category=${category}`}><Search className="size-3.5" /> Search</Link>
              </Button>
              {item.latestReleaseMagnet ? <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={() => void sendLatest()}>Send latest</Button> : null}
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
        title={removeFromLibraryCopy(item.title).title}
        description={removeFromLibraryCopy(item.title).body}
        variant="destructive"
        busy={removing}
        confirmLabel={removeFromLibraryCopy(item.title).confirmLabel}
        onConfirm={() => void remove()}
      />
      <StorageCapDialog {...capOverride.dialogProps} />
    </article>
  );
}
