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
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFeatures } from "@/lib/features";
import { Link } from "react-router";
import {
  Check,
  ChevronDown,
  Copy,
  Magnet,
  FolderOpen,
  MoreHorizontal,
  Pause,
  Play,
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
import { TfWorkThumb } from "@/components/tf/work-thumb";
import { LoadingGlyph } from "@/components/ui/loading";
import { progressPercent, speedLabel } from "@/components/tf/active-row-state";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import {
  canStreamTransfer,
  isDownloaded,
  isDownloading,
  isPaused,
  isQueued,
  leadQueuePosition,
  type GroupEntry,
  type SeasonBucket,
  type SeriesGroup,
} from "./grouping";
import {
  releaseDisplayFacts,
  sourceTierChip,
  stateLabel,
  waitReasonLabel,
} from "./release-display";
import type { Artwork } from "@/lib/metadata/artwork";
import type { ClientTorrent, TorrentRowAction } from "./types";

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
  onDeleteRequest: (torrents: ClientTorrent[], opener?: EventTarget | null) => void;
}

function barTone(state: string): string {
  return isDownloaded(state)
    ? "bg-[var(--success)]"
    : isPaused(state) || isQueued(state)
      ? "bg-[var(--text-tertiary)]"
      : "bg-[var(--primary)]";
}

function seasonLabelFor(season: Pick<SeasonBucket<ClientTorrent>, "season" | "label">) {
  return season.season != null ? `Season ${season.season}` : season.label;
}

/**
 * The season chapter rail — the signature of this redesign. It is an
 * arrow-key button group with roving focus: the rail can hold twenty seasons
 * and a mouse should never be required to move through it.
 */
function SeasonRail({
  group,
  selectedSeasonKey,
  onSelectSeason,
  panelId,
}: {
  group: SeriesGroup<ClientTorrent>;
  selectedSeasonKey: string | null;
  onSelectSeason: (key: string) => void;
  panelId: string;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedSeasonKeyRef = useRef(selectedSeasonKey);

  const ensureSelectedSeasonVisible = useCallback(() => {
    const rail = railRef.current;
    const selectedKey = selectedSeasonKeyRef.current;
    if (!rail || !selectedKey || rail.clientWidth === 0) return;

    const activeTab = [...rail.querySelectorAll<HTMLElement>("[data-season-tab-key]")].find(
      (tab) => tab.dataset.seasonTabKey === selectedKey,
    );
    if (!activeTab) return;

    const railRect = rail.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    if (tabRect.left < railRect.left) {
      rail.scrollLeft -= railRect.left - tabRect.left;
    } else if (tabRect.right > railRect.right) {
      rail.scrollLeft += tabRect.right - railRect.right;
    }
  }, []);

  useEffect(() => {
    selectedSeasonKeyRef.current = selectedSeasonKey;
    ensureSelectedSeasonVisible();
  }, [ensureSelectedSeasonVisible, group.key, selectedSeasonKey]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(ensureSelectedSeasonVisible);
    const observeRailAndTabs = () => {
      observer.disconnect();
      observer.observe(rail);
      rail
        .querySelectorAll<HTMLElement>("[data-season-tab-key]")
        .forEach((tab) => observer.observe(tab));
      ensureSelectedSeasonVisible();
    };
    observeRailAndTabs();

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(observeRailAndTabs);
    mutationObserver?.observe(rail, { childList: true });

    return () => {
      mutationObserver?.disconnect();
      observer.disconnect();
    };
  }, [ensureSelectedSeasonVisible]);

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const seasons = group.seasons;
    if (!seasons.length) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % seasons.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + seasons.length) % seasons.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = seasons.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    const next = seasons[nextIndex];
    onSelectSeason(next.key);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <div
      ref={railRef}
      role="group"
      aria-label={`Seasons of ${group.title}`}
      data-season-rail
      className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-[var(--border)] px-4 py-2 sm:px-5"
    >
      {group.seasons.map((season, index) => {
        const active = season.key === selectedSeasonKey;
        const pct = progressPercent(season.progress);
        const label = seasonLabelFor(season);
        return (
          <button
            key={season.key}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            aria-pressed={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelectSeason(season.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
            data-season-tab
            data-season-tab-key={season.key}
            data-season-tab-active={active ? "true" : "false"}
            className={cn(
              "flex min-h-[44px] shrink-0 flex-col items-start justify-center gap-1 rounded-md px-3 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] lg:min-h-0",
              active
                ? "bg-[var(--bg-muted)] text-[var(--text)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
            )}
          >
            <span className="whitespace-nowrap text-[12px] font-medium">{label}</span>
            <span className="flex w-full items-center gap-1.5">
              <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-[var(--border)]">
                <span
                  className={cn("block h-full", barTone(season.state))}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-tertiary)]">
                {pct}%
              </span>
            </span>
          </button>
        );
      })}
    </div>
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
        <DropdownMenuItem
          onClick={() => onActionMany("pause", group.torrents)}
          className="min-h-[44px] lg:min-h-0"
        >
          <Pause />
          Pause all
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onActionMany("resume", group.torrents)}
          className="min-h-[44px] lg:min-h-0"
        >
          <Play />
          Resume all
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="min-h-[44px] text-[var(--danger)] focus:text-[var(--danger)] lg:min-h-0"
          onClick={(event) => onDeleteRequest([...group.torrents], event.currentTarget)}
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
  const source = sourceTierChip(t.name);
  const epLabel =
    entry.episode != null
      ? `E${String(entry.episode).padStart(2, "0")}`
      : entry.isSeasonPack
        ? `${seasonLabelFor(season)} pack`
        : (entry.episodeLabel ?? display.title);
  const isBuiltin = t.ownerClientType === "builtin";
  const { streaming } = useFeatures();
  const canPlay = streaming && isBuiltin && canStreamTransfer(t);
  const speed = speedLabel(t.dlspeed);
  const showEta = isDownloading(t.state) && t.eta != null && t.eta > 0;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--border)] p-3 transition-colors",
        isSelected ? "bg-[var(--accent-dim)]" : "bg-[var(--bg-muted)]/40",
      )}
      data-episode-card
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
            <span className="text-[13px] font-semibold tabular-nums text-[var(--text)]">
              {epLabel}
            </span>
            {display.qualityChip ? (
              <Badge variant="outline">{display.qualityChip}</Badge>
            ) : null}
            {source ? (
              <span className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
                {source}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant={
                done ? "success" : isPaused(t.state) || isQueued(t.state) ? "default" : "accent"
              }
              data-episode-state
            >
              {done ? <Check className="h-3 w-3" aria-hidden /> : null}
              {stateLabel(t.state, t.queuePosition)}
            </Badge>
            {t.imported && <Badge variant="outline">Imported</Badge>}
            {waitReasonLabel(t.state, t.waitReason) ? (
              <span
                className="text-[11px] text-[var(--text-tertiary)]"
                data-wait-reason={t.waitReason ?? undefined}
              >
                {waitReasonLabel(t.state, t.waitReason)}
              </span>
            ) : null}
            <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">
              {formatBytes(t.sizeBytes)}
              {t.peers != null ? ` · ${t.peers} ${t.peers === 1 ? "peer" : "peers"}` : ""}
              {showEta ? ` · ETA ${formatDuration(t.eta as number)}` : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Progress
          value={pct}
          aria-label={`${epLabel} progress`}
          className="h-1.5 flex-1"
          indicatorClassName={barTone(t.state)}
        />
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">
          {pct}%
        </span>
        {speed ? (
          <span className="shrink-0 text-[11px] tabular-nums font-mono text-[var(--accent-text)]">
            ↓ {speed}
          </span>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 pt-0.5">
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
            aria-label={canPlay ? `Play ${epLabel}` : `Play ${epLabel} — nothing to play yet`}
            title={canPlay ? "Play" : "Nothing to play yet"}
            data-episode-play
          >
            <Play className="h-3.5 w-3.5" />
            Play
          </Button>
        ) : (
          <span />
        )}
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
              className="px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]"
              data-torrent-details
            >
              <p className="font-medium text-[var(--text-secondary)]">Details</p>
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
              {t.savePath ? <p className="break-all font-mono">{t.savePath}</p> : null}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onCopyMagnet(t)}
              disabled={t.imported}
              data-copy-magnet
              className="min-h-[44px] lg:min-h-0"
            >
              <Magnet />
              Copy magnet link
            </DropdownMenuItem>
            {streaming && isBuiltin ? (
              <DropdownMenuItem
                onClick={() => onCopyStreamUrl(t)}
                className="min-h-[44px] lg:min-h-0"
              >
                <Copy />
                Copy stream URL
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onOpenFolder(t)}
              disabled={openingHash === t.transferId}
              className="min-h-[44px] lg:min-h-0"
            >
              {openingHash === t.transferId ? <LoadingGlyph className="h-4 w-4" /> : <FolderOpen />}
              Open folder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {isQueued(t.state) ? (
              <DropdownMenuItem
                onClick={() => onAction("force", t)}
                className="min-h-[44px] lg:min-h-0"
                data-episode-force
              >
                <Zap />
                Download now
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() => onAction("pause", t)}
              className="min-h-[44px] lg:min-h-0"
            >
              <Pause />
              Pause
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onAction("resume", t)}
              className="min-h-[44px] lg:min-h-0"
            >
              <Play />
              Resume
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="min-h-[44px] text-[var(--danger)] focus:text-[var(--danger)] lg:min-h-0"
              onClick={(event) => onDeleteRequest([t], event.currentTarget)}
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

  if (!group) return null;

  const pct = progressPercent(group.progress);
  const seasonPanelId = `series-season-panel-${group.key}`;
  const query = artworkQueryForRelease(group.torrents[0].name, group.torrents[0].category);
  const art = artwork[query.key];
  const speed = speedLabel(group.dlspeed);

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
          className="shrink-0 gap-2 border-b border-[var(--border)] px-4 pb-3 pr-14 pt-3 sm:hidden"
          data-mobile-series-header
        >
          <h2 className="truncate pr-1 text-[15px] font-semibold text-[var(--text)]">
            {titleHref ? (
              <Link
                to={titleHref}
                className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
              variant={
                isDownloading(group.state)
                  ? "accent"
                  : isDownloaded(group.state)
                    ? "success"
                    : "default"
              }
              data-mobile-group-state
            >
              {stateLabel(group.state, leadQueuePosition(group.torrents))}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-[var(--text-tertiary)]">
              {group.seasonCount} {group.seasonCount === 1 ? "season" : "seasons"} ·{" "}
              {formatBytes(group.sizeBytes)} · {pct}%
            </span>
            {isDownloading(group.state) && speed ? (
              <span className="shrink-0 text-[11px] tabular-nums font-mono text-[var(--accent-text)]">
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
            indicatorClassName={barTone(group.state)}
          />
        </DialogHeader>

        <DialogHeader className="hidden shrink-0 gap-3 border-b border-[var(--border)] px-5 pb-3 pr-14 pt-4 sm:flex">
          <div className="flex items-start gap-3">
            {titleHref ? (
              <Link to={titleHref} tabIndex={-1} aria-hidden data-dense-ui className="shrink-0">
                {poster}
              </Link>
            ) : (
              poster
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <h2 className="line-clamp-2 pr-1 text-base font-semibold text-[var(--text)]">
                {titleHref ? (
                  // The poster above is decorative (aria-hidden, not
                  // focusable) so the same destination is not announced twice;
                  // this is the real, keyboard-reachable way to the title page.
                  <Link
                    to={titleHref}
                    className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
                  variant={
                    isDownloading(group.state)
                      ? "accent"
                      : isDownloaded(group.state)
                        ? "success"
                        : "default"
                  }
                  data-group-state
                >
                  {stateLabel(group.state, leadQueuePosition(group.torrents))}
                </Badge>
                <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">
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
                  indicatorClassName={barTone(group.state)}
                />
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">
                  {pct}%
                </span>
                {isDownloading(group.state) && speed ? (
                  <span className="shrink-0 text-[11px] tabular-nums font-mono text-[var(--accent-text)]">
                    ↓ {speed}
                  </span>
                ) : null}
              </div>
            </div>
            <SeriesActionsMenu
              group={group}
              onActionMany={onActionMany}
              onDeleteRequest={onDeleteRequest}
            />
          </div>
        </DialogHeader>

        <div
          className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2 sm:hidden"
          data-mobile-season-picker
        >
          <label className="relative flex min-w-0 items-center">
            <span className="sr-only">Season</span>
            <select
              data-mobile-season-select
              value={selectedSeasonKey ?? ""}
              onChange={(event) => onSelectSeason(event.target.value)}
              aria-controls={seasonPanelId}
              className="h-11 min-h-[44px] w-full cursor-pointer appearance-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)] py-1.5 pl-3 pr-9 text-[13px] font-medium text-[var(--text)] shadow-sm transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {group.seasons.map((season) => (
                <option key={season.key} value={season.key}>
                  {seasonLabelFor(season)} · {progressPercent(season.progress)}%
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-3 h-4 w-4 text-[var(--text-tertiary)]"
              aria-hidden
            />
          </label>
        </div>

        <div className="hidden shrink-0 sm:block">
          <SeasonRail
            group={group}
            selectedSeasonKey={selectedSeasonKey}
            onSelectSeason={onSelectSeason}
            panelId={seasonPanelId}
          />
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5"
          data-season-panel
          role="region"
          id={seasonPanelId}
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
            <p className="px-1 py-8 text-center text-[13px] text-[var(--text-tertiary)]">
              No seasons to show.
            </p>
          )}
        </div>

        {selectedTransferIdsInGroup.length > 0 ? (
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--bg-elevated)] px-4 pb-[calc(0.5rem+var(--safe-bottom))] pt-2 shadow-[var(--shadow-md)] sm:px-5 sm:pb-2 sm:shadow-none"
            data-dialog-bulk-bar
          >
            <span className="mr-1 text-[12px] text-[var(--text-secondary)]">
              {selectedTransferIdsInGroup.length} selected
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                onActionMany(
                  "pause",
                  group.torrents.filter((torrent) =>
                    selectedTransferIdsInGroup.includes(torrent.transferId),
                  ),
                )
              }
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                onActionMany(
                  "resume",
                  group.torrents.filter((torrent) =>
                    selectedTransferIdsInGroup.includes(torrent.transferId),
                  ),
                )
              }
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={(event) =>
                onDeleteRequest(
                  group.torrents.filter((torrent) =>
                    selectedTransferIdsInGroup.includes(torrent.transferId),
                  ),
                  event.currentTarget,
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
