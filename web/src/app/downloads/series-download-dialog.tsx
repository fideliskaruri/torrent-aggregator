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
import { formatEta, formatSpeed } from "@/lib/format";
import {
  seasonBucketKey,
  type SeasonBucket,
  type SeriesGroup,
} from "./grouping";
import { releaseDisplayFacts } from "./release-display";
import type { ClientTorrent, TorrentRowAction } from "./types";
import { FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import type { OpenDownloadMode } from "@/lib/open-download";
import { DownloadGroupSummary } from "./download-group-summary";
import { DownloadTransferRow } from "./download-transfer-row";
import { IconMenuButton, groupMenuItems } from "./row-menu";
import { SeriesDownloadBulkBar } from "./series-download-bulk-bar";
import { SearchingBadge } from "./searching-badge";
import { WantedMenuActions } from "./wanted-menu-actions";
import { wantedRowLabel, type WantedGroup } from "./wanted-groups";
import type { useDownloads } from "./use-downloads";
import { formatEpisodeNumber, formatSeasonLabel } from "@/lib/library/cursor";
import type { WantedRow } from "@/components/wanted/wanted-actions";

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
  wantedGroups: readonly WantedGroup[];
  wantedState: WantedState;
}

/** The dialog's seasons as switcher options: label, mini bar and failed count. */
function seasonOptions(seasons: readonly SeasonBucket<ClientTorrent>[]): SeasonOption[] {
  return seasons.map((season) => {
    const pct = progressPercent(season.progress);
    const failed = season.counts.error;
    const label = season.label;
    const hasDownloads = season.entries.length > 0;
    const live = season.status === "downloading";
    const eta = live && season.eta != null ? formatEta(season.eta) : null;
    const speed = live ? formatSpeed(season.dlspeed) : null;
    return {
      value: season.key,
      label,
      detailText: hasDownloads ? [
        `${pct}%`,
        eta,
        speed,
        failed > 0 ? `${failed} failed` : null,
      ].filter(Boolean).join(" · ") : "Looking",
      detail: hasDownloads ? (
        <span className="flex w-36 flex-col items-start gap-0.5 text-[12px] tabular-nums">
          <span className="absolute top-1.5 right-3 font-medium text-primary">{pct}%</span>
          {live ? (
            <span className="flex w-full justify-between gap-2 text-muted-foreground">
              {eta ? <span className="max-w-1/2 min-w-0 truncate" title={eta}>{eta}</span> : <span />}
              <span className="shrink-0">{speed}</span>
            </span>
          ) : null}
          {failed > 0 ? (
            <span className="whitespace-nowrap text-destructive" data-season-tab-failed={failed}>
              {failed} failed
            </span>
          ) : null}
        </span>
      ) : <span className="w-36 text-[12px] text-muted-foreground">Looking</span>,
    };
  });
}

function episodeLabel(torrent: ClientTorrent) {
  return torrent.episode != null
    ? `E${formatEpisodeNumber(torrent.episode)}`
    : releaseDisplayFacts(torrent).title;
}

interface WantedEpisodeRow {
  key: string;
  season: number | null;
  episode: number | null;
  row: WantedRow;
  group: WantedGroup;
}

function wantedEpisodeRows(groups: readonly WantedGroup[]): WantedEpisodeRow[] {
  return groups.flatMap((group) => {
    const rows = group.season == null ? group.rows.slice(0, 1) : group.rows;
    return rows.map((row) => {
      const season = row.season ?? null;
      const episode = row.episode ?? null;
      const label = season == null ? null : wantedRowLabel(row);
      const rowGroup: WantedGroup = {
        ...group,
        key: `${group.key}|${episode ?? "season"}`,
        title: season == null ? group.title : group.name,
        season,
        episode,
        label,
        statusLabel: row.statusLabel,
        looking: row.looking,
        nextAttemptAt: row.nextAttemptAt ?? null,
        rows: [row],
      };
      return { key: rowGroup.key, season, episode, row, group: rowGroup };
    });
  });
}

function dialogSeasonBuckets(
  group: SeriesGroup<ClientTorrent>,
  wantedRows: readonly WantedEpisodeRow[],
): SeasonBucket<ClientTorrent>[] {
  const seasons = [...group.seasons];
  for (const season of new Set(wantedRows.map((item) => item.season).filter(
    (value): value is number => value != null,
  ))) {
    if (seasons.some((bucket) => bucket.season === season)) continue;
    seasons.push({
      season,
      key: seasonBucketKey(group.key, season),
      label: `Season ${formatSeasonLabel(season).slice(1)}`,
      entries: [],
      progress: 0,
      sizeBytes: 0,
      dlspeed: 0,
      upspeed: 0,
      eta: null,
      status: "waiting",
      statusLabel: "Looking",
      counts: { total: 0, downloading: 0, queued: 0, paused: 0, done: 0, error: 0 },
    });
  }
  return seasons.sort((a, b) =>
    a.season == null ? 1 : b.season == null ? -1 : a.season - b.season);
}

function WantedEpisodeRowCard({ item, wanted }: { item: WantedEpisodeRow; wanted: WantedState }) {
  const label = item.season == null ? item.group.title
    : item.episode != null ? `E${formatEpisodeNumber(item.episode)}` : wantedRowLabel(item.row);
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3"
      data-wanted-episode-row={item.key}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[13px] font-semibold tabular-nums text-foreground">
          {label}
        </span>
        <SearchingBadge groups={[item.group]} label="Looking" />
      </div>
      <div className="flex justify-end">
        <WantedMenuActions groups={[item.group]} onChanged={wanted.reload} setRows={wanted.setRows}
          label={`More actions for ${label}`} triggerProps={{ "data-wanted-episode-actions": "" }} />
      </div>
    </div>
  );
}

type EpisodeListItem =
  | { kind: "download"; key: string; episode: number | null; torrent: ClientTorrent }
  | { kind: "wanted"; key: string; episode: number | null; item: WantedEpisodeRow };

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
  wantedGroups,
  wantedState,
}: SeriesDownloadDialogProps) {
  const wantedRows = useMemo(() => wantedEpisodeRows(wantedGroups), [wantedGroups]);
  const seasons = useMemo(
    () => group ? dialogSeasonBuckets(group, wantedRows) : [],
    [group, wantedRows],
  );
  const selectedSeason = useMemo(
    () => seasons.find((season) => season.key === selectedSeasonKey) ?? null,
    [seasons, selectedSeasonKey],
  );
  const packHashes = [
    ...new Set(
      (selectedSeason?.entries ?? [])
        .filter((torrent) => torrent.packed && torrent.actions.findAnother)
        .map((torrent) => torrent.hash),
    ),
  ];
  const packHash = packHashes.length === 1 ? packHashes[0] : null;
  const seasonPack = packHash != null
    ? selectedSeason?.entries.find((torrent) => torrent.hash === packHash) ?? null
    : null;
  const selectAllId = useId();

  if (!group) return null;

  const seasonTabs = seasonOptions(seasons);
  const seasonIds = selectedSeason?.entries.map((torrent) => torrent.transferId) ?? [];
  const episodeItems: EpisodeListItem[] = [
    ...(selectedSeason?.entries ?? []).map((torrent) => ({
      kind: "download" as const,
      key: torrent.transferId,
      episode: torrent.episode ?? null,
      torrent,
    })),
    ...wantedRows
      .filter((item) => item.season == null || item.season === selectedSeason?.season)
      .map((item) => ({
        kind: "wanted" as const,
        key: item.key,
        episode: item.episode,
        item,
      })),
  ].sort((a, b) =>
    (a.episode ?? (a.kind === "wanted" ? -1 : Number.MAX_SAFE_INTEGER)) -
      (b.episode ?? (b.kind === "wanted" ? -1 : Number.MAX_SAFE_INTEGER)) ||
    a.key.localeCompare(b.key));
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
    .find((torrent) => torrent.status === "error" && torrent.actions.findAnother);
  const firstFailedLabel = firstFailed
    ? (firstFailed.episode != null
      ? `E${formatEpisodeNumber(firstFailed.episode)}`
      : releaseDisplayFacts(firstFailed).title)
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
              {firstFailed ? (
                <div className="flex pt-1">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onAction("find-another-release", firstFailed)}
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
            options={seasonTabs}
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
            options={seasonTabs}
            value={selectedSeasonKey}
            ariaLabel={`Seasons of ${group.title}`}
          />
        </div>
        <TabsContent
          value={selectedSeasonKey ?? ""}
          className="min-h-0 overflow-y-auto px-4 py-3 sm:px-5"
          data-season-panel
          aria-label={
            selectedSeason ? `${selectedSeason.label} downloads` : "Season downloads"
          }
        >
          {selectedSeason ? (
            <>
            <div
              className="sticky -top-3 z-10 -mx-4 -mt-5 mb-3 flex min-h-11 items-center gap-2.5 border-b border-border bg-card px-4 py-2 sm:-mx-5 sm:px-5"
              data-season-select-all-row
            >
              <Checkbox
                id={selectAllId}
                checked={seasonChecked}
                onCheckedChange={() => onToggleManySelect(seasonIds)}
                aria-label={`Select all episodes in ${selectedSeason.label}`}
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
              {seasonPack ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  data-season-find-release
                  aria-label={`Find another release for ${selectedSeason.label}`}
                  onClick={() => onAction("find-another-release", seasonPack)}
                >
                  <Search className="h-3.5 w-3.5" />
                  {FIND_ANOTHER_SOURCE_LABEL} release
                </Button>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {episodeItems.map((item) => item.kind === "wanted" ? (
                <WantedEpisodeRowCard key={item.key} item={item.item} wanted={wantedState} />
              ) : (
                <DownloadTransferRow
                  key={item.key}
                  torrent={seasonPack?.hash === item.torrent.hash
                    ? {
                      ...item.torrent,
                      actions: { ...item.torrent.actions, findAnother: false },
                    }
                    : item.torrent}
                  kind="episode"
                  title={episodeLabel(item.torrent)}
                  isSelected={selected.has(item.torrent.transferId)}
                  highlighted={item.torrent.transferId === highlightedTransferId}
                  openingHash={openingHash}
                  onToggleSelect={onToggleSelect}
                  onAction={onAction}
                  onOpenFolder={onOpenFolder}
                  onOpenFile={onOpenFile}
                  onCopyPath={onCopyPath}
                  onCopyMagnet={onCopyMagnet}
                  onDeleteRequest={onDeleteRequest}
                  wantedGroups={[]}
                  wantedState={wantedState}
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
