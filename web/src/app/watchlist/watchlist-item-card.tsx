import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Ellipsis, Play, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { PlaybackUncheckedNote } from "@/components/tf/playback-unchecked-note";
import { PlaybackUncheckedError } from "@/lib/api/delete-refusal";
import { MediaPoster, MediaPosterCaption } from "@/components/browse/media-poster-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { QualityOptions } from "@/components/settings/quality-options";
import type { WatchlistItem } from "@/lib/api/watchlist-types";
import { SEARCH_HREF } from "@/lib/navigation";
import { isSeriesMediaType, searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { titlePath } from "@/components/title/work-key";
import { toast } from "@/lib/toast";
import { itemLibraryStatus, libraryStatusLine, libraryStorageWait } from "@/components/library/library-state";
import { audioCheckSummary } from "@/lib/library/audio-check";
import { followLine } from "./card-state";
import { removeFromLibraryCopy } from "@/lib/library/remove-copy";
import { WatchlistDeleteFiles } from "./watchlist-delete-files";

type WatchlistUpdate = {
  id: string;
  status?: string;
  monitored?: boolean;
  fromSeason?: number;
  fromEpisode?: number;
  preferredResolution?: number | null;
};

type UpdateWatchlistItem = (body: WatchlistUpdate) => Promise<WatchlistItem | null>;

export function WatchlistItemCard({
  item,
  readOnly,
  onUpdate,
  onRemove,
  onRefresh,
}: {
  item: WatchlistItem;
  readOnly: boolean;
  onUpdate: UpdateWatchlistItem;
  onRemove: (id: string, deleteAnyway?: boolean) => Promise<void>;
  onRefresh: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [deleteFilesOpen, setDeleteFilesOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [unchecked, setUnchecked] = useState<string | null>(null);
  const titleHref = item.workKey?.trim()
    ? titlePath(item.workKey, {
        title: item.title,
        mediaType: item.mediaType,
        season: item.cursorSeason ?? item.fromSeason,
      })
    : null;
  const category = searchCategoryForMediaType(item.mediaType) ?? "tv";
  const searchHref = `${SEARCH_HREF}?q=${encodeURIComponent(item.title)}&category=${category}`;
  const status = libraryStatusLine(item);
  const state = itemLibraryStatus(item);
  const mediaType = item.mediaType.trim().toLowerCase();
  const mediaTypeLabel =
    mediaType === "movie" ? "Movie" :
      mediaType === "tv" || mediaType === "series" ? "Series" :
        mediaType === "anime" ? "Anime" :
          item.mediaType;
  const removeCopy = removeFromLibraryCopy(item.title);
  const hasFiles = Boolean(item.hasFiles || item.ready);
  const audio = audioCheckSummary(item, isSeriesMediaType(item.mediaType));

  async function remove() {
    setRemoving(true);
    try {
      await onRemove(item.id, unchecked != null);
      setConfirmRemove(false);
      setUnchecked(null);
      toast.success("Removed from library");
    } catch (error) {
      if (error instanceof PlaybackUncheckedError) setUnchecked(error.message);
      else toast.error(error instanceof Error ? error.message : "Could not remove this title. Try again.");
    } finally {
      setRemoving(false);
    }
  }

  const comingUpFilm = state === "coming_up" && !isSeriesMediaType(item.mediaType);
  const subtitle = `${mediaTypeLabel} · ${status.text}`;
  const cardVisual = (
    <>
      <MediaPoster
        variant="rail"
        src={item.posterUrl}
        title={item.title}
        sizes="(min-width: 1024px) 200px, (min-width: 640px) 180px, 120px"
        gated={comingUpFilm}
        className={cn(
          "transition-[transform,border-color,box-shadow] duration-150 ease-out",
          "group-hover:border-input group-hover:shadow-md",
          "motion-safe:group-hover:-translate-y-1 motion-safe:group-focus-within:-translate-y-1",
        )}
      />
      <MediaPosterCaption
        title={item.title}
        subtitle={
          <span title={status.title ?? `${subtitle} · ${followLine(item)}`}>
            {mediaTypeLabel}
            <span aria-hidden> · </span>
            <span data-card-state>{status.text}</span>
            {audio.label ? (
              <span
                data-card-audio={audio.kind}
                className={cn("block whitespace-normal break-words font-medium", audio.kind === "wrong-audio" || audio.kind === "failed" ? "text-destructive" : "text-info")}
              >
                {audio.label}
              </span>
            ) : null}
          </span>
        }
      />
    </>
  );
  const badgeClass = "pointer-events-auto min-w-0 justify-start py-1 leading-none";
  const storage = libraryStorageWait(item);
  const stateBadge =
    storage ? (
      <Link
        to={storage.state === "no_space" ? "/downloads" : "/settings?tab=folders"}
        aria-label={`${storage.label}: ${item.title}`}
        className="flex min-h-11 min-w-0 items-end rounded-md lg:min-h-0"
      >
        <Badge variant="solid" className={badgeClass}>
          <span className="truncate">{storage.short}</span>
        </Badge>
      </Link>
    ) : state === "looking" ? (
      <Link to={searchHref} aria-label={`Pick a copy of ${item.title}`} className="flex min-h-11 min-w-0 items-end rounded-md lg:min-h-0">
        <Badge variant="solid" className={badgeClass}>
          <Search aria-hidden className="size-3 shrink-0" />
          <span className="truncate">Pick a copy</span>
        </Badge>
      </Link>
    ) : state === "downloading" ? (
      <Link to="/downloads" aria-label={`View download of ${item.title}`} className="flex min-h-11 min-w-0 items-end rounded-md lg:min-h-0">
        <Badge variant="solid" className={badgeClass}>
          <span className="truncate">Downloading</span>
        </Badge>
      </Link>
    ) : item.jellyfin?.playUrl ? (
      <a href={item.jellyfin.playUrl} target="_blank" rel="noopener noreferrer" data-library-play
        aria-label={`Play ${item.title} in Jellyfin (opens in a new tab)`}
        className="flex min-h-11 min-w-0 items-end rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-0">
        <Badge variant="solid" className={badgeClass}>
          <Play aria-hidden className="size-3 shrink-0" />
          <span className="truncate">Play</span>
        </Badge>
      </a>
    ) : state === "coming_up" ? (
      <Badge aria-hidden className={cn(badgeClass, "pointer-events-none bg-card text-subtle-foreground")}>
        <span className="truncate">Coming up</span>
      </Badge>
    ) : null;

  return (
    <article
      className="group relative min-w-0"
      data-library-card
      data-library-state={state}
    >
      {titleHref ? (
        <Link
          to={titleHref}
          data-library-card-link
          aria-label={`${item.title}, ${subtitle}`}
          className="block w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {cardVisual}
        </Link>
      ) : (
        <div>{cardVisual}</div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-[3] aspect-[2/3] transition-transform duration-150 ease-out motion-safe:group-hover:-translate-y-1 motion-safe:group-focus-within:-translate-y-1">
        {stateBadge ? (
          <div className="absolute inset-x-0 bottom-0 flex min-w-0 px-1.5 pb-1.5">{stateBadge}</div>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`More actions for ${item.title}`}
              data-library-more
              className={cn(
                "pointer-events-auto absolute right-0 top-0 flex size-11 items-start justify-end p-1.5 outline-none transition-opacity duration-150",
                "[@media(hover:hover)_and_(pointer:fine)]:md:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                "[&:focus-visible>span]:ring-2 [&:focus-visible>span]:ring-ring",
              )}
            >
              <span className="flex size-7 items-center justify-center rounded-md border border-border bg-card/90 text-foreground shadow-sm hover:bg-card">
                <Ellipsis aria-hidden className="size-4" />
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!readOnly ? (
              <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>Settings</DropdownMenuItem>
            ) : null}
            <DropdownMenuItem asChild>
              <Link to={searchHref}>Search manually</Link>
            </DropdownMenuItem>
            {!readOnly && hasFiles ? (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteFilesOpen(true)}
                data-delete-files
              >
                Delete files
              </DropdownMenuItem>
            ) : null}
            {!readOnly ? (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setConfirmRemove(true)}
                data-remove-from-library
              >
                Remove from library
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!readOnly ? (
        <WatchlistSettingsDialog
          item={item}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onUpdate={onUpdate}
        />
      ) : null}
      {!readOnly && hasFiles ? (
        <WatchlistDeleteFiles
          item={item}
          onDeleted={onRefresh}
          open={deleteFilesOpen}
          onOpenChange={setDeleteFilesOpen}
        />
      ) : null}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={(open) => {
          setConfirmRemove(open);
          if (!open) setUnchecked(null);
        }}
        contentData={{ "data-remove-from-library": true }}
        title={removeCopy.title}
        description={removeCopy.body}
        variant="destructive"
        busy={removing}
        confirmLabel={unchecked != null ? "Delete anyway" : removeCopy.confirmLabel}
        onConfirm={() => void remove()}
      >
        {unchecked != null ? <PlaybackUncheckedNote message={unchecked} /> : null}
      </ConfirmDialog>
    </article>
  );
}

function WatchlistSettingsDialog({
  item,
  open,
  onOpenChange,
  onUpdate,
}: {
  item: WatchlistItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: UpdateWatchlistItem;
}) {
  const [monitored, setMonitored] = useState(Boolean(item.monitored));
  const [status, setStatus] = useState(item.status);
  const [startSeason, setStartSeason] = useState(
    String(item.fromSeason ?? item.cursorSeason ?? ""),
  );
  const [preferredResolution, setPreferredResolution] = useState<number | null>(
    item.preferredResolution ?? null,
  );
  const [saving, setSaving] = useState(false);
  const series = isSeriesMediaType(item.mediaType);
  const seasonNumber = startSeason ? Number(startSeason) : null;
  const validSeason =
    seasonNumber == null ||
    (Number.isInteger(seasonNumber) && seasonNumber >= 1 && seasonNumber <= 99);

  useEffect(() => {
    if (!open) return;
    setMonitored(Boolean(item.monitored));
    setStatus(item.status);
    setStartSeason(String(item.fromSeason ?? item.cursorSeason ?? ""));
    setPreferredResolution(item.preferredResolution ?? null);
  }, [item, open]);

  async function save() {
    if (!validSeason) return;
    setSaving(true);
    const body: WatchlistUpdate = { id: item.id, monitored, status };
    if (series && seasonNumber != null && seasonNumber !== item.fromSeason) {
      body.fromSeason = seasonNumber;
      body.fromEpisode = 1;
    }
    if (preferredResolution !== (item.preferredResolution ?? null)) {
      body.preferredResolution = preferredResolution;
    }
    try {
      const updatedItem = await onUpdate(body);
      if (updatedItem) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        data-library-settings
      >
        <DialogHeader>
          <DialogTitle>Library settings</DialogTitle>
          <DialogDescription>{item.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Label className="flex min-h-11 items-center justify-between gap-3">
            <span className="text-sm text-foreground">Auto-download</span>
            <Switch
              checked={monitored}
              onCheckedChange={setMonitored}
              aria-label={`Auto-download ${item.title}`}
              data-library-monitored
            />
          </Label>
          {series ? (
            <Label className="block space-y-1.5">
              <span className="text-sm text-foreground">Start season</span>
              <Input
                type="number"
                min={1}
                max={99}
                value={startSeason}
                onChange={(event) => setStartSeason(event.currentTarget.value)}
                aria-label={`Start season for ${item.title}`}
                aria-invalid={!validSeason}
                data-library-start-season
              />
            </Label>
          ) : null}
          <div className="space-y-2">
            <Label className="text-sm text-foreground">Quality minimum</Label>
            <QualityOptions
              name={`library-quality-${item.id}`}
              value={preferredResolution}
              onChange={setPreferredResolution}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 px-2"
              onClick={() => setPreferredResolution(null)}
              disabled={preferredResolution == null}
            >
              No minimum
            </Button>
          </div>
          <Label className="block space-y-1.5">
            <span className="text-sm text-foreground">Watch status</span>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger
                aria-label={`Watch status for ${item.title}`}
                className="min-h-11"
                data-library-status
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  [
                    ["planned", "Planned"],
                    ["watching", "Watching"],
                    ["completed", "Completed"],
                    ["dropped", "Dropped"],
                  ] as const
                ).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={saving || !validSeason}
            onClick={() => void save()}
            data-library-settings-save
          >
            {saving ? "Saving" : "Save settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
