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
 * live in `page.tsx` — so a notification link can open it on the right season
 * and a snapshot that drops the series can close it.
 */
import { useId, useMemo } from "react";
import { Pause, Play, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SeasonSwitcher, type SeasonOption } from "@/components/tf/season-switcher";
import { progressPercent } from "@/components/tf/active-row-state";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import {
  isError,
  type GroupEntry,
  type SeasonBucket,
  type SeriesGroup,
} from "./grouping";
import { canFindAnotherSourceFor, pauseResumeTargets, releaseDisplayFacts, rollupChip } from "./release-display";
import type { Artwork } from "@/lib/metadata/artwork";
import type { ClientTorrent, TorrentRowAction } from "./types";
import { FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import type { OpenDownloadMode } from "@/lib/open-download";
import { DownloadGroupSummary, DownloadTransferRow } from "./download-transfer-row";
import { IconMenuButton, groupMenuItems } from "./row-menu";
import { TransferProgress, transferBarTone } from "./transfer-progress";
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
  /** Checks every one of these, or clears them when all are already checked. */
  onToggleManySelect: (transferIds: string[]) => void;
  /** The episode a notification's "View details" pointed at, if any. */
  highlightedTransferId?: string | null;
  openingHash: string | null;
  onAction: (act: TorrentRowAction, torrent: ClientTorrent) => void;
  onActionMany: (act: "pause" | "resume", torrents: ClientTorrent[]) => void;
  onOpenFolder: (torrent: ClientTorrent) => void;
  /** Open in the owner's own player, or Show in folder (docs/api-open-file.md). */
  onOpenFile: (torrent: ClientTorrent, mode: OpenDownloadMode) => void;
  /** The folder fallback when this computer can't open folders. */
  onCopyPath: (torrent: ClientTorrent) => void;
  onCopyMagnet: (torrent: ClientTorrent) => void;
  onDeleteRequest: (torrents: ClientTorrent[]) => void;
}

function seasonLabelFor(season: Pick<SeasonBucket<ClientTorrent>, "season" | "label">) {
  return season.season != null ? `Season ${season.season}` : season.label;
}

/** The dialog's seasons as switcher options: label, mini bar and failed count. */
function seasonOptions(group: SeriesGroup<ClientTorrent>): SeasonOption[] {
  return group.seasons.map((season) => {
    const pct = progressPercent(season.progress);
    const failed = season.counts.error;
    const label = seasonLabelFor(season);
    return {
      value: season.key,
      label,
      detailText: `${pct}%${failed > 0 ? ` · ${failed} failed` : ""}`,
      detail: (
        <span className="flex w-full items-center gap-1.5">
          <TransferProgress
            percent={pct}
            tone={transferBarTone(season.state, rollupChip(season).failing)}
            label={`${label} progress`}
            size="mini"
            className="w-auto"
          />
          {failed > 0 ? (
            <span
              className="shrink-0 whitespace-nowrap text-[12px] tabular-nums text-destructive"
              data-season-tab-failed={failed}
            >
              · {failed} failed
            </span>
          ) : null}
        </span>
      ),
    };
  });
}

function episodeLabel(entry: GroupEntry<ClientTorrent>, season: SeasonBucket<ClientTorrent>) {
  return entry.episode != null
    ? `E${String(entry.episode).padStart(2, "0")}`
    : entry.isSeasonPack
      ? `${seasonLabelFor(season)} pack`
      : (entry.episodeLabel ?? releaseDisplayFacts(entry.torrent).title);
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
  onToggleManySelect,
  highlightedTransferId = null,
  openingHash,
  onAction,
  onActionMany,
  onOpenFolder,
  onOpenFile,
  onCopyPath,
  onCopyMagnet,
  onDeleteRequest,
}: SeriesDownloadDialogProps) {
  const selectedSeason = useMemo(
    () => group?.seasons.find((season) => season.key === selectedSeasonKey) ?? null,
    [group, selectedSeasonKey],
  );
  const selectAllId = useId();

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

  const query = artworkQueryForRelease(group.torrents[0].name, group.torrents[0].category);
  const art = artwork[query.key];
  const seasons = seasonOptions(group);
  const seasonIds = selectedSeason?.entries.map((entry) => entry.torrent.transferId) ?? [];
  const seasonCheckedCount = seasonIds.filter((transferId) => selected.has(transferId)).length;
  const seasonChecked =
    seasonIds.length > 0 && seasonCheckedCount === seasonIds.length
      ? true
      : seasonCheckedCount > 0
        ? ("indeterminate" as const)
        : false;
  // No bulk swap endpoint exists yet (see docs/todo-list.md), so the header
  // links to the per-episode action on the first failed episode instead.
  const firstFailed = group.seasons
    .flatMap((season) => season.entries)
    .find((entry) => isError(entry.torrent.state) && canFindAnotherSourceFor(entry.torrent));
  const firstFailedLabel = firstFailed
    ? (firstFailed.episodeLabel ?? releaseDisplayFacts(firstFailed.torrent).title)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // The frame is *fixed*, not content-driven: `sm:h-[...]` (not the
        // primitive's `sm:h-auto` + `max-h`) so a season holding one episode
        // renders the same rectangle as a season holding forty, and the
        // season rail never moves under the pointer. Mobile keeps the
        // primitive's full-height sheet.
        mobileFullscreen
        className="max-h-[100dvh] p-0 sm:h-[min(88dvh,54rem)] sm:max-h-[88dvh] sm:w-[min(100%-2rem,68rem)] sm:max-w-[68rem]"
        data-series-dialog
      >
        <DialogTitle className="sr-only">{group.title}</DialogTitle>
        <DialogDescription className="sr-only">
          Every season and episode of this show that is downloading or
          downloaded. Choose a season, then open, pause or remove individual
          episodes.
        </DialogDescription>

        {/* The same summary as the series' row on the page. */}
        <DialogHeader className="shrink-0 border-b border-border px-4 pb-3 pr-14 pt-3 sm:px-5 sm:pr-14 sm:pt-4">
          <div className="flex items-start gap-2">
            <DownloadGroupSummary group={group} titleHref={titleHref} posterUrl={art?.posterUrl} heading>
              {firstFailed ? (
                <div className="flex pt-1">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onAction("swap", firstFailed.torrent)}
                    data-group-find-release
                  >
                    <Search className="h-3.5 w-3.5" />
                    {FIND_ANOTHER_SOURCE_LABEL} for {firstFailedLabel}
                  </Button>
                </div>
              ) : null}
            </DownloadGroupSummary>
            <IconMenuButton label={`More actions for ${group.title}`} triggerProps={{ "data-group-more": "" }}>
              {groupMenuItems({ torrents: group.torrents, onActionMany, onDeleteRequest })}
            </IconMenuButton>
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
          <SeasonSwitcher
            variant="select"
            options={seasons}
            value={selectedSeasonKey}
            onValueChange={onSelectSeason}
            placeholder="Choose a season"
            triggerClassName="h-11 w-full bg-muted text-[13px] font-medium"
            triggerAttrs={{ "data-mobile-season-select": "" }}
            itemClassName="min-h-11"
          />
        </div>

        <div className="hidden shrink-0 sm:block">
          <SeasonSwitcher
            variant="tabs"
            options={seasons}
            value={selectedSeasonKey}
            ariaLabel={`Seasons of ${group.title}`}
          />
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
            <>
            {/*
              In the panel, not on the tab: a checkbox inside role="tab" breaks
              the rail's arrow keys, and phones pick seasons from a Select.
              -top-3 matches the panel's py-3: sticky offsets count from the
              padded edge, so top-0 would sit 12px low over the first cards.
            */}
            <div
              className="sticky -top-3 z-10 -mx-4 -mt-3 mb-3 flex min-h-11 items-center gap-2.5 border-b border-border bg-card px-4 sm:-mx-5 sm:px-5"
              data-season-select-all-row
            >
              <Checkbox
                id={selectAllId}
                checked={seasonChecked}
                onCheckedChange={() => onToggleManySelect(seasonIds)}
                aria-label={`Select all episodes in ${seasonLabelFor(selectedSeason)}`}
                data-season-select-all={
                  seasonChecked === "indeterminate" ? "some" : seasonChecked ? "all" : "none"
                }
              />
              <label
                htmlFor={selectAllId}
                className="cursor-pointer select-none text-[13px] text-muted-foreground"
              >
                Select all ({seasonIds.length})
              </label>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {selectedSeason.entries.map((entry) => (
                <DownloadTransferRow
                  key={entry.torrent.transferId}
                  torrent={entry.torrent}
                  kind="episode"
                  title={episodeLabel(entry, selectedSeason)}
                  isSeasonPack={entry.isSeasonPack}
                  isSelected={selected.has(entry.torrent.transferId)}
                  highlighted={entry.torrent.transferId === highlightedTransferId}
                  openingHash={openingHash}
                  onToggleSelect={onToggleSelect}
                  onAction={onAction}
                  onOpenFolder={onOpenFolder}
                  onOpenFile={onOpenFile}
                  onCopyPath={onCopyPath}
                  onCopyMagnet={onCopyMagnet}
                  onDeleteRequest={onDeleteRequest}
                />
              ))}
            </div>
            </>
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
