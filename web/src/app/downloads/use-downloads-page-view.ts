import { useEffect, useMemo } from "react";
import { isValidTorrentSourceInput, TORRENT_SOURCE_INPUT_HINT } from "@/lib/torrents/magnet-input";
import { toast } from "@/lib/toast";
import {
  groupDownloads,
  statusCounts,
  isDownloading,
  isError,
  isPaused,
  isQueued,
  isDownloaded,
  type SeriesGroup,
} from "./grouping";
import { releaseDisplayFacts, pauseResumeTargets, transferLabel } from "./release-display";
import { filterDownloadsByTab } from "./media-filter";
import { sortDownloadGroups } from "./sort";
import { resolveSelectedSeasonKey, seriesGroupByKey } from "./season-selection";
import { shouldCloseMissingGroup } from "./snapshot-sync";
import {
  downloadLinkKey,
  findLinkedDownload,
  withoutDownloadLink,
} from "./download-link";
import { isDownloadRow, type ClientTorrent } from "./types";
import { useStableLoading } from "@/components/ui/use-stable-loading";
import { groupWantedRows, groupWantedTitles, wantedSubtitle, wantedTitleKeyForDownload } from "./wanted-groups";
import type { WantedGroup } from "./wanted-groups";
import type { useDownloads } from "./use-downloads";
import type { useDownloadsPageState } from "./use-downloads-page-state";

type Ui = ReturnType<typeof useDownloadsPageState>;
type Data = ReturnType<typeof useDownloads>;

export function useDownloadsPageView(ui: Ui, data: Data) {
  const { torrents, error, authoritative } = data;
  const downloadable = useMemo(() => torrents.filter(isDownloadRow), [torrents]);
  const filtered = useMemo(() => {
    const q = ui.filter.trim().toLowerCase();
    const byStatus = downloadable.filter((torrent) => {
      const display = releaseDisplayFacts(torrent);
      if (
        q &&
        !torrent.name.toLowerCase().includes(q) &&
        !display.title.toLowerCase().includes(q) &&
        !(display.episodeLabel?.toLowerCase().includes(q) ?? false)
      ) return false;
      if (ui.statusFilter === "downloading") return torrent.status === "downloading" || torrent.status === "finishing" || torrent.status === "waiting";
      if (ui.statusFilter === "queued") return isQueued(torrent.status);
      if (ui.statusFilter === "ready") return isDownloaded(torrent.status);
      if (ui.statusFilter === "paused") return isPaused(torrent.status);
      if (ui.statusFilter === "attention") return isError(torrent.status);
      if (ui.statusFilter === "active") return isDownloading(torrent.status) || isQueued(torrent.status);
      return true;
    });
    return filterDownloadsByTab(byStatus, ui.mediaTab);
  }, [downloadable, ui.filter, ui.statusFilter, ui.mediaTab]);

  const grouped = useMemo(() => groupDownloads(filtered), [filtered]);
  const sortedGroups = useMemo(() => sortDownloadGroups(grouped, ui.sort), [grouped, ui.sort]);
  const allVisibleSelected = useMemo(
    () => filtered.length > 0 && filtered.every((row) => ui.selected.has(row.transferId)),
    [filtered, ui.selected],
  );
  const allGroups = useMemo(() => groupDownloads(downloadable), [downloadable]);
  const wantedGroups = useMemo(() => groupWantedRows(data.wanted.rows), [data.wanted.rows]);
  const wantedByWorkKey = useMemo(() => {
    const byWork = new Map<string, WantedGroup[]>();
    for (const group of wantedGroups) {
      const items = byWork.get(group.workKey);
      if (items) items.push(group);
      else byWork.set(group.workKey, [group]);
    }
    return byWork;
  }, [wantedGroups]);
  const wantedTitles = useMemo(() => groupWantedTitles(wantedGroups), [wantedGroups]);
  const downloadedWorkKeys = useMemo(() => new Set(allGroups.map((group) =>
    group.kind === "series"
      ? group.key
      : wantedTitleKeyForDownload(group.torrent.groupKey, group.torrent.workKey))), [allGroups]);
  const wantedOnly = useMemo(() => {
    if (ui.statusFilter !== "all") return [];
    const q = ui.filter.trim().toLowerCase();
    return filterDownloadsByTab(
      wantedTitles.filter((title) =>
        !downloadedWorkKeys.has(title.workKey)
        && (!q || title.title.toLowerCase().includes(q)
          || wantedSubtitle(title).toLowerCase().includes(q))),
      ui.mediaTab,
    );
  }, [wantedTitles, downloadedWorkKeys, ui.statusFilter, ui.filter, ui.mediaTab]);
  const openGroup = useMemo(
    () => ui.openSeriesKey ? seriesGroupByKey(allGroups, ui.openSeriesKey) : null,
    [allGroups, ui.openSeriesKey],
  );

  if (openGroup && openGroup.title !== ui.openGroupTitle) ui.setOpenGroupTitle(openGroup.title);
  if (shouldCloseMissingGroup({
    openKey: ui.openSeriesKey,
    groupFound: Boolean(openGroup),
    authoritative,
  })) {
    ui.setOpenSeriesKey(null);
    ui.setSelectedSeasonKey(null);
    ui.setAnnouncement(`${ui.openGroupTitle || "This show"}’s downloads are gone. Closed details.`);
  }
  if (openGroup) {
    const resolved = resolveSelectedSeasonKey(openGroup.seasons, ui.selectedSeasonKey);
    if (resolved !== ui.selectedSeasonKey) ui.setSelectedSeasonKey(resolved);
  }

  useEffect(() => {
    if (!ui.downloadLink) {
      ui.resolvedLinkRef.current = null;
      return;
    }
    if (!authoritative) return;
    const key = downloadLinkKey(ui.downloadLink);
    if (ui.resolvedLinkRef.current === key) return;
    ui.resolvedLinkRef.current = key;
    ui.setSearchParams(withoutDownloadLink, { replace: true, preventScrollReset: true });
    const target = findLinkedDownload(downloadable, ui.downloadLink);
    if (!target) {
      toast.info("That download was removed");
      ui.setAnnouncement("That download was removed.");
      return;
    }
    if (!filtered.includes(target)) {
      ui.setFilter("");
      ui.setStatusFilter("all");
      ui.setMediaTab("all");
    }
    ui.setLinkedTransferId(target.transferId);
    ui.setAnnouncement(`Showing ${transferLabel(target)}.`);
    const series = allGroups.find(
      (group): group is SeriesGroup<ClientTorrent> =>
        group.kind === "series" && group.torrents.includes(target),
    );
    if (series) {
      ui.seriesDialogOpenerRef.current = null;
      ui.setOpenSeriesKey(series.key);
      ui.setSelectedSeasonKey(
        series.seasons.find((season) => season.entries.some((entry) => entry.torrent === target))?.key ?? null,
      );
    }
  }, [
    ui.downloadLink, ui.resolvedLinkRef, ui.setSearchParams, ui.setAnnouncement,
    ui.setFilter, ui.setStatusFilter, ui.setMediaTab, ui.setLinkedTransferId,
    ui.seriesDialogOpenerRef, ui.setOpenSeriesKey, ui.setSelectedSeasonKey,
    authoritative, downloadable, filtered, allGroups,
  ]);

  useEffect(() => {
    if (!ui.linkedTransferId) return;
    const clear = () => ui.setLinkedTransferId(null);
    const options = { capture: true, once: true } as const;
    window.addEventListener("pointerdown", clear, options);
    window.addEventListener("keydown", clear, options);
    return () => {
      window.removeEventListener("pointerdown", clear, options);
      window.removeEventListener("keydown", clear, options);
    };
  }, [ui.linkedTransferId, ui.setLinkedTransferId]);

  let dlspeed = 0;
  let upspeed = 0;
  for (const torrent of downloadable) {
    dlspeed += torrent.dlspeed || 0;
    upspeed += torrent.upspeed || 0;
  }
  const stats = { ...statusCounts(downloadable), dlspeed, upspeed };
  const selectedTargets = useMemo(
    () => pauseResumeTargets(torrents.filter((torrent) => ui.selected.has(torrent.transferId))),
    [torrents, ui.selected],
  );
  const rawSendTrimmed = ui.rawSendValue.trim();
  const rawSendInvalid = rawSendTrimmed.length > 0 && !isValidTorrentSourceInput(ui.rawSendValue);
  const rawSendClientError = rawSendInvalid
    ? TORRENT_SOURCE_INPUT_HINT
    : ui.rawSendError?.field === "source" ? ui.rawSendError.message : null;
  const showLoading = useStableLoading(data.loading && !torrents.length && !error);
  return {
    downloadable, filtered, grouped, sortedGroups, allVisibleSelected, allGroups, openGroup,
    wantedGroups, wantedByWorkKey, wantedOnly, wantedTitleCount: wantedTitles.length,
    stats, selectedTargets, rawSendTrimmed, rawSendInvalid,
    rawSendAnyError: rawSendClientError || ui.rawSendError?.message || null,
    showLoading,
  };
}
