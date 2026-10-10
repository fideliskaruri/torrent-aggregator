import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Ellipsis, Search } from "lucide-react";
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
import { MediaPoster } from "@/components/browse/media-poster-card";
import { QualityOptions } from "@/components/settings/quality-options";
import type { WatchlistItem } from "@/lib/api/watchlist-types";
import { SEARCH_HREF } from "@/lib/navigation";
import { isSeriesMediaType, searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { titlePath } from "@/components/title/work-key";
import { toast } from "@/lib/toast";
import { itemLibraryStatus, libraryStatusLine } from "@/components/library/library-state";
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
  onRemove: (id: string) => Promise<void>;
  onRefresh: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
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
    <article
      className="surface grid min-w-0 grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-2.5 p-2"
      data-library-card
      data-library-state={state}
    >
      <MediaPoster variant="row" src={item.posterUrl} title={item.title}>
        {titleHref ? (
          <Link
            to={titleHref}
            data-library-card-link
            aria-label={`Open ${item.title}`}
            className="absolute inset-0 z-[1] rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : null}
      </MediaPoster>

      <div className="min-w-0 space-y-0.5">
        {titleHref ? (
          <Link
            to={titleHref}
            data-library-card-link
            className="block min-h-6 truncate rounded-sm text-[14px] font-medium leading-5 text-foreground hover:text-brand-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {item.title}
          </Link>
        ) : (
          <h2 className="truncate text-[14px] font-medium leading-5 text-foreground">{item.title}</h2>
        )}
        <p className="truncate text-xs text-subtle-foreground">
          <span>{mediaTypeLabel}</span>
          <span aria-hidden> · </span>
          <span>{followLine(item)}</span>
        </p>
        <p
          data-card-state
          title={status.title}
          className="truncate text-xs font-medium text-foreground"
        >
          {status.text}
        </p>
      </div>

      <div className="flex items-center gap-1">
        {state === "looking" ? (
          <Button
            asChild
            type="button"
            variant="outline"
            className="min-h-11 px-2.5 text-xs md:min-h-8"
          >
            <Link to={searchHref}><Search aria-hidden className="size-3.5" /> Pick a copy</Link>
          </Button>
        ) : state === "downloading" ? (
          <Button
            asChild
            type="button"
            variant="outline"
            className="min-h-11 px-2.5 text-xs md:min-h-8"
          >
            <Link to="/downloads">View</Link>
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 md:size-8"
              aria-label={`More actions for ${item.title}`}
              data-library-more
            >
              <Ellipsis aria-hidden className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!readOnly ? (
              <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>Settings</DropdownMenuItem>
            ) : null}
            <DropdownMenuItem asChild>
              <Link to={searchHref}>Search manually</Link>
            </DropdownMenuItem>
            {!readOnly && hasFiles ? (
              <WatchlistDeleteFiles
                item={item}
                onDeleted={onRefresh}
                renderTrigger={(open) => (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => open()}
                    data-delete-files
                  >
                    Delete files
                  </DropdownMenuItem>
                )}
              />
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
