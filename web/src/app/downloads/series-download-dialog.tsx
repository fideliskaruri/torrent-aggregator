/**
 * The series download dialog — Season 1 chapter rail, one column of episode
 * cards below it.
 *
 * `page.tsx` used to answer "what is Season 3 of this show doing" by growing a
 * disclosure triangle three levels deep (show → season → episode), and BUG-004
 * is the owner naming that for what it was: rearranged divs, not a considered
 * answer to the question. This is the redesign. The main page stays a single
 * compact row per work; this dialog is where the seasons and episodes of one
 * series actually live, opened explicitly rather than accumulated in place.
 *
 * The dialog does not own its selected season or its open/closed state — both
 * live in `page.tsx` — because Play has to unmount this component entirely
 * while `PlayOverlay` is up (never two focus traps at once) and reopen the
 * same series on the same season afterward. State that lived inside this
 * component would be lost the moment it unmounted; state the parent holds
 * survives the round trip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFeatures, useDisplayPath } from "@/lib/features";
import { Link } from "react-router";
import {
  Check,
  Copy,
  Magnet,
  FolderOpen,
  MoreHorizontal,
  Pause,
  Play,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { cn, formatBytes, formatDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TfWorkThumb } from "@/components/tf/work-thumb";
import { LoadingGlyph } from "@/components/ui/loading";
import { progressPercent, speedLabel } from "@/components/tf/active-row-state";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import {
  canStreamTransfer,
  isDownloaded,
  isDownloading,
  isError,
  isPaused,
  isQueued,
  type GroupEntry,
  type SeasonBucket,
  type SeriesGroup,
} from "./grouping";
import {
  canDownloadNow,
  forcedStartLabel,
  isVerifiedDownload,
  pauseResumeAction,
  pauseResumeTargets,
  releaseDisplayFacts,
  sourceChip,
  stateBadgeVariant,
  stateLabel,
  rollupChip,
  transferErrorMessage,
  waitReasonLabel,
} from "./release-display";
import type { Artwork } from "@/lib/metadata/artwork";
import type { ClientTorrent, TorrentRowAction } from "./types";
import { canFindAnotherRelease } from "./release-swap-dialog";

export interface SeriesDownloadDialogProps {
  /** `null` while closed, or once the group the dialog was opened for is gone. */
  group: SeriesGroup<ClientTorrent> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleHref: string | null;
  artwork: Record<string, Artwork>;
  selectedSeasonKey: string | null;
  onSelectSeason: (key: string) => void;
  /** The page's own multi-select set — shared, not a second selection model. */
  selected: Set<string>;
  onToggleSelect: (hash: string, additive: boolean) => void;
  /** The episode a notification's "View details" pointed at, if any. */
  highlightedTransferId?: string | null;
  openingHash: string | null;
  onPlay: (payload: {
    hash: string;
    title: string;
    workKey: string | null;
    mediaType: string | null;
    year: number | null;
    season: number | null;
    episode: number | null;
  }) => void;
  onAction: (act: TorrentRowAction, torrent: ClientTorrent) => void;
  onActionMany: (act: "pause" | "resume", torrents: ClientTorrent[]) => void;
  onOpenFolder: (torrent: ClientTorrent) => void;
  onCopyStreamUrl: (torrent: ClientTorrent) => void;
  onCopyMagnet: (torrent: ClientTorrent) => void;
  onDeleteRequest: (torrents: ClientTorrent[]) => void;
}

function barTone(state: string): string {
  return isDownloaded(state)
    ? "bg-success"
    : isError(state)
      ? "bg-destructive"
      : isPaused(state) || isQueued(state)
        ? "bg-subtle-foreground"
        : "bg-primary";
}

function seasonLabelFor(season: Pick<SeasonBucket<ClientTorrent>, "season" | "label">) {
  return season.season != null ? `Season ${season.season}` : season.label;
}

/**
 * The season chapter rail, the signature of this redesign. It is the
 * `TabsList` of the dialog's `Tabs`, so arrow keys, Home and End move through
 * the seasons (and select them) and a mouse is never required.
 */
function SeasonRail({
  group,
  selectedSeasonKey,
}: {
  group: SeriesGroup<ClientTorrent>;
  selectedSeasonKey: string | null;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);

  // Keeps the selected season in view inside the scroll viewport as seasons
  // arrive, the dialog resizes, or the season changes from the phone picker.
  const ensureSelectedSeasonVisible = useCallback(() => {
    const viewport = railRef.current?.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    );
    if (!viewport || viewport.clientWidth === 0) return;
    const activeTab = viewport.querySelector<HTMLElement>(
      '[data-season-tab-active="true"]',
    );
    if (!activeTab) return;
    const viewportRect = viewport.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    if (tabRect.left < viewportRect.left) {
      viewport.scrollLeft -= viewportRect.left - tabRect.left;
    } else if (tabRect.right > viewportRect.right) {
      viewport.scrollLeft += tabRect.right - viewportRect.right;
    }
  }, []);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(ensureSelectedSeasonVisible);
    observer.observe(rail);
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(ensureSelectedSeasonVisible);
    mutationObserver?.observe(rail, {
      subtree: true,
      childList: true,
      attributeFilter: ["data-season-tab-active"],
    });
    ensureSelectedSeasonVisible();
    return () => {
      mutationObserver?.disconnect();
      observer.disconnect();
    };
  }, [ensureSelectedSeasonVisible]);

  return (
    <div ref={railRef} className="shrink-0 border-b border-border" data-season-rail>
      <ScrollArea className="w-full">
        <TabsList
          aria-label={`Seasons of ${group.title}`}
          className="mx-4 my-2 group-data-horizontal/tabs:h-auto sm:mx-5"
        >
          {group.seasons.map((season) => {
            const pct = progressPercent(season.progress);
            const chip = rollupChip(season);
            const failed = season.counts.error;
            return (
              <SeasonTab
                key={season.key}
                seasonKey={season.key}
                active={season.key === selectedSeasonKey}
                label={seasonLabelFor(season)}
                pct={pct}
                failed={failed}
                tone={chip.failing ? "bg-destructive" : barTone(season.state)}
              />
            );
          })}
        </TabsList>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}

function SeasonTab({
  seasonKey,
  active,
  label,
  pct,
  failed,
  tone,
}: {
  seasonKey: string;
  active: boolean;
  label: string;
  pct: number;
  failed: number;
  tone: string;
}) {
  return (
    <TabsTrigger
      value={seasonKey}
      data-season-tab
      data-season-tab-key={seasonKey}
      data-season-tab-active={active ? "true" : "false"}
      className="group/season h-auto flex-none flex-col items-start gap-1 px-3 py-1.5 text-left max-md:min-h-11 pointer-coarse:min-h-11"
    >
      <span className="whitespace-nowrap text-[12px] font-medium">{label}</span>
      <span className="flex w-full items-center gap-1.5">
        <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-border">
          <span className={cn("block h-full", tone)} style={{ width: `${pct}%` }} />
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-subtle-foreground">{pct}%</span>
        {failed > 0 ? (
          <span
            className="shrink-0 whitespace-nowrap text-[12px] tabular-nums text-destructive"
            data-season-tab-failed={failed}
          >
            · {failed} failed
          </span>
        ) : null}
      </span>
    </TabsTrigger>
  );
}

function SeriesActionsMenu({
  group,
  onActionMany,
  onDeleteRequest,
  mobile = false,
}: {
  group: SeriesGroup<ClientTorrent>;
  onActionMany: SeriesDownloadDialogProps["onActionMany"];
  onDeleteRequest: SeriesDownloadDialogProps["onDeleteRequest"];
  mobile?: boolean;
}) {
  const targets = pauseResumeTargets(group.torrents);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`More actions for ${group.title}`}
          data-group-more={mobile ? undefined : ""}
          data-mobile-group-more={mobile ? "" : undefined}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {targets.pause.length ? (
          <DropdownMenuItem
            onClick={() => onActionMany("pause", targets.pause)}
          >
            <Pause />
            Pause all
          </DropdownMenuItem>
        ) : null}
        {targets.resume.length ? (
          <DropdownMenuItem
            onClick={() => onActionMany("resume", targets.resume)}
          >
            <Play />
            Resume all
          </DropdownMenuItem>
        ) : null}
        {targets.pause.length || targets.resume.length ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onDeleteRequest([...group.torrents])}
          data-group-delete
        >
          <Trash2 />
          Delete all…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EpisodeCard({
  entry,
  season,
  isSelected,
  highlighted,
  openingHash,
  onToggleSelect,
  onPlay,
  onAction,
  onOpenFolder,
  onCopyStreamUrl,
  onCopyMagnet,
  onDeleteRequest,
}: {
  entry: GroupEntry<ClientTorrent>;
  season: SeasonBucket<ClientTorrent>;
  isSelected: boolean;
  highlighted: boolean;
  openingHash: string | null;
  onToggleSelect: (hash: string, additive: boolean) => void;
  onPlay: SeriesDownloadDialogProps["onPlay"];
  onAction: SeriesDownloadDialogProps["onAction"];
  onOpenFolder: SeriesDownloadDialogProps["onOpenFolder"];
  onCopyStreamUrl: SeriesDownloadDialogProps["onCopyStreamUrl"];
  onCopyMagnet: SeriesDownloadDialogProps["onCopyMagnet"];
  onDeleteRequest: SeriesDownloadDialogProps["onDeleteRequest"];
}) {
  const t = entry.torrent;
  const pct = progressPercent(t.progress);
  const done = isDownloaded(t.state);
  const query = artworkQueryForRelease(t.name, t.category);
  const display = releaseDisplayFacts(t, query);
  const source = sourceChip(t.name);
  const epLabel =
    entry.episode != null
      ? `E${String(entry.episode).padStart(2, "0")}`
      : entry.isSeasonPack
        ? `${seasonLabelFor(season)} pack`
        : (entry.episodeLabel ?? display.title);
  const isBuiltin = t.ownerClientType === "builtin";
  const pauseResume = pauseResumeAction(t);
  const { streaming, openFolder } = useFeatures();
  const displayPath = useDisplayPath();
  const canPlay = streaming && isBuiltin && canStreamTransfer(t);
  const speed = speedLabel(t.dlspeed);
  const showEta = isDownloading(t.state) && t.eta != null && t.eta > 0;
  const errorMessage = transferErrorMessage(t);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const offerSwap = isError(t.state) && canFindAnotherRelease(t);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) cardRef.current?.scrollIntoView({ block: "center" });
  }, [highlighted]);

  return (
    <div
      ref={cardRef}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3 transition-colors",
        isSelected ? "bg-brand-dim" : "bg-muted/40",
        highlighted && "ring-2 ring-brand",
      )}
      data-episode-card
      data-highlighted={highlighted || undefined}
      data-hash={t.hash}
      data-owner-client={t.ownerClientType}
      title={t.name}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect(t.transferId, true)}
          aria-label={`Select ${epLabel}`}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold tabular-nums text-foreground">
              {epLabel}
            </span>
            {display.qualityChip ? (
              <Badge variant="outline">{display.qualityChip}</Badge>
            ) : null}
            {source ? (
              <span className="text-[12px] uppercase tracking-wide text-subtle-foreground">
                {source}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant={done ? "success" : stateBadgeVariant(t.state)}
              data-episode-state
            >
              {done ? <Check className="h-3 w-3" aria-hidden /> : null}
              {stateLabel(t.state, t.queuePosition)}
            </Badge>
            {isVerifiedDownload(t) ? (
              <Badge variant="outline" title="Checked on disk" data-episode-verified>
                Verified
              </Badge>
            ) : null}
            {t.imported && <Badge variant="outline">Imported</Badge>}
            {forcedStartLabel(t) ? (
              <span className="text-[12px] text-muted-foreground" data-episode-forced>
                {forcedStartLabel(t)}
              </span>
            ) : waitReasonLabel(t.state, t.waitReason) ? (
              <span
                className="text-[12px] text-subtle-foreground"
                data-wait-reason={t.waitReason ?? undefined}
              >
                {waitReasonLabel(t.state, t.waitReason)}
              </span>
            ) : null}
            <span className="text-[12px] tabular-nums text-subtle-foreground">
              {formatBytes(t.sizeBytes)}
              {t.peers != null ? ` · ${t.peers} ${t.peers === 1 ? "peer" : "peers"}` : ""}
              {showEta ? ` · ETA ${formatDuration(t.eta as number)}` : ""}
            </span>
          </div>
          {errorMessage ? (
            // One line keeps a grid of failed cards scannable; the full text
            // is on hover and one tap away.
            <Collapsible open={errorExpanded} onOpenChange={setErrorExpanded}>
              <CollapsibleTrigger
                title={errorMessage}
                className="block w-full truncate rounded-sm text-left text-[12px] leading-snug text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:whitespace-normal max-md:min-h-11 pointer-coarse:min-h-11"
                data-episode-error-message
              >
                {errorMessage}
              </CollapsibleTrigger>
            </Collapsible>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Progress
          value={pct}
          aria-label={`${epLabel} progress`}
          className="h-1.5 flex-1"
          indicatorClassName={barTone(t.state)}
        />
        <span className="shrink-0 text-[12px] tabular-nums text-subtle-foreground">
          {pct}%
        </span>
        {speed ? (
          <span className="shrink-0 text-[12px] tabular-nums font-mono text-brand-foreground">
            ↓ {speed}
          </span>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {offerSwap ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onAction("swap", t)}
              aria-label={`Find another release for ${epLabel}`}
              data-episode-find-release
            >
              <Search className="h-3.5 w-3.5" />
              Find another release
            </Button>
          ) : null}
          {canDownloadNow(t) && isBuiltin ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onAction("force", t)}
              aria-label={`Download ${epLabel} now`}
              data-episode-force-now
            >
              <Zap className="h-3.5 w-3.5" />
              Download now
            </Button>
          ) : null}
          {streaming && isBuiltin ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canPlay}
              onClick={() =>
                onPlay({
                  hash: t.hash,
                  title: t.workTitle?.trim() || display.title,
                  workKey: t.workKey ?? null,
                  mediaType: t.workMediaType ?? t.category ?? null,
                  year: t.workYear ?? null,
                  season: entry.season ?? season.season,
                  episode: entry.episode,
                })
              }
              aria-label={canPlay ? `Play ${epLabel}` : `Play ${epLabel}, nothing to play yet`}
              title={canPlay ? "Play" : "Nothing to play yet"}
              data-episode-play
            >
              <Play className="h-3.5 w-3.5" />
              Play
            </Button>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`More actions for ${epLabel}`}
              data-episode-more
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/*
              The raw release name, the source tag and the folder path are
              torrent mechanics, kept out of the card itself and one keystroke
              away here — the same rule the compact page row already follows.
            */}
            <div
              className="px-2 py-1.5 text-[12px] leading-relaxed text-subtle-foreground"
              data-torrent-details
            >
              <p className="font-medium text-muted-foreground">Details</p>
              {(() => {
                const facts = [
                  source,
                  t.ownerClientLabel,
                  t.category,
                  t.peers != null ? `${t.peers} ${t.peers === 1 ? "peer" : "peers"}` : null,
                ].filter(Boolean);
                return facts.length ? <p className="tabular-nums">{facts.join(" · ")}</p> : null;
              })()}
              <p className="break-all font-mono">{t.name}</p>
              {t.savePath ? <p className="break-all font-mono">{displayPath(t.savePath)}</p> : null}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onCopyMagnet(t)}
              disabled={t.imported}
              data-copy-magnet
            >
              <Magnet />
              Copy magnet link
            </DropdownMenuItem>
            {streaming && isBuiltin ? (
              <DropdownMenuItem
                onClick={() => onCopyStreamUrl(t)}
              >
                <Copy />
                Copy stream URL
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onOpenFolder(t)}
              disabled={!openFolder || openingHash === t.transferId}
            >
              {openingHash === t.transferId ? <LoadingGlyph className="h-4 w-4" /> : <FolderOpen />}
              Open folder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {canDownloadNow(t) ? (
              <DropdownMenuItem
                onClick={() => onAction("force", t)}
                data-episode-force
              >
                <Zap />
                Download now
              </DropdownMenuItem>
            ) : null}
            {canFindAnotherRelease(t) ? (
              <DropdownMenuItem
                onClick={() => onAction("swap", t)}
                data-find-release
              >
                <Search />
                Find another release
              </DropdownMenuItem>
            ) : null}
            {pauseResume === "pause" ? (
              <DropdownMenuItem
                onClick={() => onAction("pause", t)}
              >
                <Pause />
                Pause
              </DropdownMenuItem>
            ) : pauseResume === "resume" ? (
              <DropdownMenuItem
                onClick={() => onAction("resume", t)}
                data-episode-retry={isError(t.state) ? "true" : undefined}
              >
                <Play />
                {isError(t.state) ? "Retry" : "Resume"}
              </DropdownMenuItem>
            ) : null}
            {canDownloadNow(t) || canFindAnotherRelease(t) || pauseResume !== null ? (
              <DropdownMenuSeparator />
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onDeleteRequest([t])}
              data-episode-delete
            >
              <Trash2 />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function SeriesDownloadDialog({
  group,
  open,
  onOpenChange,
  titleHref,
  artwork,
  selectedSeasonKey,
  onSelectSeason,
  selected,
  onToggleSelect,
  highlightedTransferId = null,
  openingHash,
  onPlay,
  onAction,
  onActionMany,
  onOpenFolder,
  onCopyStreamUrl,
  onCopyMagnet,
  onDeleteRequest,
}: SeriesDownloadDialogProps) {
  const selectedSeason = useMemo(
    () => group?.seasons.find((season) => season.key === selectedSeasonKey) ?? null,
    [group, selectedSeasonKey],
  );

  // Scoped to this series so Pause/Resume/Delete act only on what is checked
  // under this show, even though the checkboxes write into the page's one
  // shared `selected` set.
  const selectedTransferIdsInGroup = useMemo(() => {
    if (!group) return [];
    const members = new Set(group.torrents.map((t) => t.transferId));
    return [...selected].filter((transferId) => members.has(transferId));
  }, [group, selected]);
  // What the selection bar's Pause and Resume would act on: only the checked episodes each one applies to.
  const selectedTargets = useMemo(
    () =>
      pauseResumeTargets(
        group ? group.torrents.filter((torrent) => selected.has(torrent.transferId)) : [],
      ),
    [group, selected],
  );

  if (!group) return null;

  const pct = progressPercent(group.progress);
  const query = artworkQueryForRelease(group.torrents[0].name, group.torrents[0].category);
  const art = artwork[query.key];
  const speed = speedLabel(group.dlspeed);
  const chip = rollupChip(group);
  const headerBarTone = chip.failing ? "bg-destructive" : barTone(group.state);
  // No bulk swap endpoint exists yet (see docs/todo-list.md), so the header
  // links to the per-episode action on the first failed episode instead.
  const firstFailed = group.seasons
    .flatMap((season) => season.entries)
    .find((entry) => isError(entry.torrent.state) && canFindAnotherRelease(entry.torrent));
  const firstFailedLabel = firstFailed
    ? (firstFailed.episodeLabel ?? releaseDisplayFacts(firstFailed.torrent).title)
    : null;
  const attention = firstFailed ? (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => onAction("swap", firstFailed.torrent)}
      data-group-find-release
    >
      <Search className="h-3.5 w-3.5" />
      Find another release for {firstFailedLabel}
    </Button>
  ) : null;

  const poster = (
    <TfWorkThumb title={group.title} posterUrl={art?.posterUrl} sizePx={52} />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // The frame is *fixed*, not content-driven: `sm:h-[...]` (not the
        // primitive's `sm:h-auto` + `max-h`) so a season holding one episode
        // renders the same rectangle as a season holding forty. Content-driven
        // height made the dialog jump from near-viewport-tall to a stub the
        // moment you switched to a sparse season, and the season rail moved
        // under the pointer. Viewport-relative with a sensible cap
        // (min(88dvh, 54rem) tall, min(100%-2rem, 68rem) wide) keeps it big on
        // a desktop monitor without becoming an unreadable full-bleed wall.
        // Mobile keeps the primitive's full-height sheet.
        mobileFullscreen
        className="max-h-[100dvh] p-0 sm:h-[min(88dvh,54rem)] sm:max-h-[88dvh] sm:w-[min(100%-2rem,68rem)] sm:max-w-[68rem]"
        data-series-dialog
      >
        <DialogTitle className="sr-only">{group.title}</DialogTitle>
        <DialogDescription className="sr-only">
          Every season and episode of this show that is downloading or
          downloaded. Choose a season, then play, pause or remove individual
          episodes.
        </DialogDescription>

        <DialogHeader
          className="shrink-0 gap-2 border-b border-border px-4 pb-3 pr-14 pt-3 sm:hidden"
          data-mobile-series-header
        >
          <h2 className="truncate pr-1 text-[15px] font-semibold text-foreground">
            {titleHref ? (
              <Link
                to={titleHref}
                className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-mobile-dialog-title-link
              >
                {group.title}
              </Link>
            ) : (
              group.title
            )}
          </h2>
          <div className="flex min-w-0 items-center gap-2">
            <Badge
              variant={chip.variant}
              data-mobile-group-state
              className="min-w-0 max-w-[65%] truncate"
            >
              {chip.label}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-[12px] tabular-nums text-subtle-foreground">
              {group.seasonCount} {group.seasonCount === 1 ? "season" : "seasons"} ·{" "}
              {formatBytes(group.sizeBytes)} · {pct}%
            </span>
            {isDownloading(group.state) && speed ? (
              <span className="shrink-0 text-[12px] tabular-nums font-mono text-brand-foreground">
                ↓ {speed}
              </span>
            ) : null}
            <SeriesActionsMenu
              group={group}
              onActionMany={onActionMany}
              onDeleteRequest={onDeleteRequest}
              mobile
            />
          </div>
          <Progress
            value={pct}
            aria-label={`${group.title} combined download progress`}
            className="h-1"
            indicatorClassName={headerBarTone}
          />
          {attention ? <div className="flex">{attention}</div> : null}
        </DialogHeader>

        <DialogHeader className="hidden shrink-0 gap-3 border-b border-border px-5 pb-3 pr-14 pt-4 sm:flex">
          <div className="flex items-start gap-3">
            {titleHref ? (
              <Link to={titleHref} tabIndex={-1} aria-hidden data-dense-ui className="shrink-0">
                {poster}
              </Link>
            ) : (
              poster
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <h2 className="line-clamp-2 pr-1 text-base font-semibold text-foreground">
                {titleHref ? (
                  // The poster above is decorative (aria-hidden, not
                  // focusable) so the same destination is not announced twice;
                  // this is the real, keyboard-reachable way to the title page.
                  <Link
                    to={titleHref}
                    className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-dialog-title-link
                  >
                    {group.title}
                  </Link>
                ) : (
                  group.title
                )}
              </h2>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant={chip.variant}
                  data-group-state
                >
                  {chip.label}
                </Badge>
                <span className="text-[12px] tabular-nums text-subtle-foreground">
                  {group.releaseCount} {group.releaseCount === 1 ? "release" : "releases"} ·{" "}
                  {group.seasonCount} {group.seasonCount === 1 ? "season" : "seasons"} ·{" "}
                  {formatBytes(group.sizeBytes)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Progress
                  value={pct}
                  aria-label={`${group.title} combined download progress`}
                  className="h-1.5 flex-1 max-w-[16rem]"
                  indicatorClassName={headerBarTone}
                />
                <span className="shrink-0 text-[12px] tabular-nums text-subtle-foreground">
                  {pct}%
                </span>
                {isDownloading(group.state) && speed ? (
                  <span className="shrink-0 text-[12px] tabular-nums font-mono text-brand-foreground">
                    ↓ {speed}
                  </span>
                ) : null}
              </div>
              {attention}
            </div>
            <SeriesActionsMenu
              group={group}
              onActionMany={onActionMany}
              onDeleteRequest={onDeleteRequest}
            />
          </div>
        </DialogHeader>

        <Tabs
          value={selectedSeasonKey ?? ""}
          onValueChange={onSelectSeason}
          className="min-h-0 flex-1 gap-0"
        >
        <div
          className="shrink-0 border-b border-border bg-card px-4 py-2 sm:hidden"
          data-mobile-season-picker
        >
          <Select value={selectedSeasonKey ?? undefined} onValueChange={onSelectSeason}>
            <SelectTrigger
              aria-label="Season"
              className="h-11 w-full bg-muted text-[13px] font-medium"
              data-mobile-season-select
            >
              <SelectValue placeholder="Choose a season" />
            </SelectTrigger>
            <SelectContent position="popper">
              {group.seasons.map((season) => (
                <SelectItem key={season.key} value={season.key} className="min-h-11">
                  {`${seasonLabelFor(season)} · ${progressPercent(season.progress)}%${
                    season.counts.error > 0 ? ` · ${season.counts.error} failed` : ""
                  }`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="hidden shrink-0 sm:block">
          <SeasonRail group={group} selectedSeasonKey={selectedSeasonKey} />
        </div>

        <TabsContent
          value={selectedSeasonKey ?? ""}
          className="min-h-0 overflow-y-auto px-4 py-3 sm:px-5"
          data-season-panel
          aria-label={
            selectedSeason ? `${seasonLabelFor(selectedSeason)} downloads` : "Season downloads"
          }
        >
          {selectedSeason ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {selectedSeason.entries.map((entry) => (
                <EpisodeCard
                  key={entry.torrent.transferId}
                  entry={entry}
                  season={selectedSeason}
                  isSelected={selected.has(entry.torrent.transferId)}
                  highlighted={entry.torrent.transferId === highlightedTransferId}
                  openingHash={openingHash}
                  onToggleSelect={onToggleSelect}
                  onPlay={onPlay}
                  onAction={onAction}
                  onOpenFolder={onOpenFolder}
                  onCopyStreamUrl={onCopyStreamUrl}
                  onCopyMagnet={onCopyMagnet}
                  onDeleteRequest={onDeleteRequest}
                />
              ))}
            </div>
          ) : (
            <p className="px-1 py-8 text-center text-[13px] text-subtle-foreground">
              No seasons to show.
            </p>
          )}
        </TabsContent>
        </Tabs>

        {selectedTransferIdsInGroup.length > 0 ? (
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-card px-4 pb-[calc(0.5rem+var(--safe-bottom))] pt-2 shadow-[var(--shadow-md)] sm:px-5 sm:pb-2 sm:shadow-none"
            data-dialog-bulk-bar
          >
            <span className="mr-1 text-[12px] text-muted-foreground">
              {selectedTransferIdsInGroup.length} selected
            </span>
            {/*
              aria-disabled, not disabled, when nothing checked applies: Pause
              stops applying the moment it has worked, while it still has
              focus, and a disabled button drops focus to <body>.
            */}
            <Button
              size="sm"
              variant="secondary"
              aria-disabled={!selectedTargets.pause.length || undefined}
              onClick={() => {
                if (selectedTargets.pause.length) onActionMany("pause", selectedTargets.pause);
              }}
              data-dialog-bulk-pause
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-disabled={!selectedTargets.resume.length || undefined}
              onClick={() => {
                if (selectedTargets.resume.length) onActionMany("resume", selectedTargets.resume);
              }}
              data-dialog-bulk-resume
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() =>
                onDeleteRequest(
                  group.torrents.filter((torrent) =>
                    selectedTransferIdsInGroup.includes(torrent.transferId),
                  ),
                )
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
