/**
 * Season and episode details for one series download.
 */
import { useId, useMemo } from "react";
import { Search } from "lucide-react";
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
import {
  isError,
  type GroupEntry,
  type SeasonBucket,
  type SeriesGroup,
} from "./grouping";
import { canFindAnotherSourceFor, releaseDisplayFacts, rollupChip } from "./release-display";
import type { ClientTorrent, TorrentRowAction } from "./types";
import { FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import type { OpenDownloadMode } from "@/lib/open-download";
import { DownloadGroupSummary } from "./download-group-summary";
import { DownloadTransferRow } from "./download-transfer-row";
import { IconMenuButton, groupMenuItems } from "./row-menu";
import { TransferProgress, transferBarTone } from "./transfer-progress";
import { SeriesDownloadBulkBar } from "./series-download-bulk-bar";
import { WantedDetails } from "./wanted-details";
import type { WantedGroup } from "./wanted-groups";
import type { useDownloads } from "./use-downloads";

type WantedState = ReturnType<typeof useDownloads>["wanted"];
export interface SeriesDownloadDialogProps {
  /** `null` while closed, or once the group the dialog was opened for is gone. */
  group: SeriesGroup<ClientTorrent> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleHref: string | null;
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
  wantedGroups?: readonly WantedGroup[];
  wantedState?: WantedState;
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
            tone={transferBarTone(season.status, rollupChip(season).failing)}
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
  wantedGroups = [],
  wantedState,
}: SeriesDownloadDialogProps) {
  const selectedSeason = useMemo(
    () => group?.seasons.find((season) => season.key === selectedSeasonKey) ?? null,
    [group, selectedSeasonKey],
  );
  const selectAllId = useId();

  if (!group) return null;

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
    .find((entry) => isError(entry.torrent.status) && canFindAnotherSourceFor(entry.torrent));
  const firstFailedLabel = firstFailed
    ? (firstFailed.episodeLabel ?? releaseDisplayFacts(firstFailed.torrent).title)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // A fixed frame keeps the season rail stable; mobile remains full-height.
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
            <DownloadGroupSummary group={group} titleHref={titleHref} posterUrl={group.torrents[0].posterUrl}
              heading wantedGroups={wantedGroups}>
              {wantedGroups.length > 0 && wantedState ? (
                <WantedDetails groups={wantedGroups} wanted={wantedState} />
              ) : null}
              {firstFailed ? (
                <div className="flex pt-1">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onAction("find-another-release", firstFailed.torrent)}
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

        <SeriesDownloadBulkBar
          torrents={group.torrents.filter((torrent) => selected.has(torrent.transferId))}
          onActionMany={onActionMany}
          onDeleteRequest={onDeleteRequest}
        />
      </DialogContent>
    </Dialog>
  );
}
