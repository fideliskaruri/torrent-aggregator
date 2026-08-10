"use client";

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
import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { Check, Copy, FolderOpen, MoreHorizontal, Pause, Play, Trash2 } from "lucide-react";
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
  type GroupEntry,
  type SeasonBucket,
  type SeriesGroup,
} from "./grouping";
import {
  releaseDisplayFacts,
  sourceTierChip,
  stateLabel,
} from "./release-display";
import type { Artwork } from "@/lib/metadata/artwork";
import type { ClientTorrent } from "./types";

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
    season: number | null;
    episode: number | null;
  }) => void;
  onAction: (act: "pause" | "resume", torrent: ClientTorrent) => void;
  onActionMany: (act: "pause" | "resume", torrents: ClientTorrent[]) => void;
  onOpenFolder: (torrent: ClientTorrent) => void;
  onCopyStreamUrl: (torrent: ClientTorrent) => void;
  onDeleteRequest: (torrents: ClientTorrent[], opener?: EventTarget | null) => void;
}

function barTone(state: string): string {
  return isDownloaded(state)
    ? "bg-[var(--success)]"
    : isPaused(state)
      ? "bg-[var(--text-tertiary)]"
      : "bg-[var(--primary)]";
}

function seasonLabelFor(season: Pick<SeasonBucket<ClientTorrent>, "season" | "label">) {
  return season.season != null ? `Season ${season.season}` : season.label;
}

/**
 * The season chapter rail — the signature of this redesign. Role `tablist`
 * with arrow-key roving focus, per the ARIA tabs pattern: the rail can hold
 * twenty seasons and a mouse should never be required to move through it.
 */
function SeasonRail({
  group,
  selectedSeasonKey,
  onSelectSeason,
}: {
  group: SeriesGroup<ClientTorrent>;
  selectedSeasonKey: string | null;
  onSelectSeason: (key: string) => void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!selectedSeasonKey) return;

    const targetIndex = group.seasons.findIndex((season) => season.key === selectedSeasonKey);
    if (targetIndex < 0) return;

    const tab = tabRefs.current[targetIndex];
    if (!tab) return;

    const rafId = window.requestAnimationFrame(() => {
      const latestTab = tabRefs.current[targetIndex];
      if (!latestTab || latestTab !== tab) return;
      latestTab.scrollIntoView({
        inline: "nearest",
        block: "nearest",
        behavior: "auto",
      });
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [group.key, selectedSeasonKey]);

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
      role="tablist"
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
            role="tab"
            id={`season-tab-${season.key}`}
            aria-selected={active}
            aria-controls={`season-panel-${season.key}`}
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
  const canPlay = isBuiltin && canStreamTransfer(t);
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
              variant={done ? "success" : isPaused(t.state) ? "default" : "accent"}
              data-episode-state
            >
              {done ? <Check className="h-3 w-3" aria-hidden /> : null}
              {stateLabel(t.state)}
            </Badge>
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
        {isBuiltin ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!canPlay}
            onClick={() =>
              onPlay({
                hash: t.hash,
                title: display.title,
                season: season.season,
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
            {isBuiltin ? (
              <>
                <DropdownMenuItem
                  onClick={() => onCopyStreamUrl(t)}
                  className="min-h-[44px] lg:min-h-0"
                >
                  <Copy />
                  Copy stream URL
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              onClick={() => onOpenFolder(t)}
              disabled={openingHash === t.transferId}
              className="min-h-[44px] lg:min-h-0"
            >
              {openingHash === t.transferId ? <LoadingGlyph className="h-4 w-4" /> : <FolderOpen />}
              Open folder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
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
        <DialogHeader className="shrink-0 gap-3 border-b border-[var(--border)] px-4 pb-3 pr-14 pt-4 sm:px-5">
          <div className="flex items-start gap-3">
            {titleHref ? (
              <Link href={titleHref} tabIndex={-1} aria-hidden data-dense-ui className="shrink-0">
                {poster}
              </Link>
            ) : (
              poster
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <DialogTitle className="line-clamp-2 pr-1">
                {titleHref ? (
                  // The poster above is decorative (aria-hidden, not
                  // focusable) so the same destination is not announced twice;
                  // this is the real, keyboard-reachable way to the title page.
                  <Link
                    href={titleHref}
                    className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    data-dialog-title-link
                  >
                    {group.title}
                  </Link>
                ) : (
                  group.title
                )}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Every season and episode of this show that is downloading or
                downloaded. Choose a season, then play, pause or remove
                individual episodes. The header above shows the combined
                progress, size and speed.
              </DialogDescription>
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
                  {stateLabel(group.state)}
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for ${group.title}`}
                  data-group-more
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
          </div>
        </DialogHeader>

        <SeasonRail
          group={group}
          selectedSeasonKey={selectedSeasonKey}
          onSelectSeason={onSelectSeason}
        />

        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5"
          data-season-panel
          role="tabpanel"
          id={selectedSeason ? `season-panel-${selectedSeason.key}` : undefined}
          aria-labelledby={selectedSeason ? `season-tab-${selectedSeason.key}` : undefined}
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
            className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--border)] px-4 pb-[calc(0.5rem+var(--safe-bottom))] pt-2 sm:px-5 sm:pb-2"
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
