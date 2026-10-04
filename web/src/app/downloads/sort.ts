/**
 * How the main Downloads list is ordered. The choice is remembered in this
 * browser (`tf-downloads-sort`). Films sort as rows and a series as one unit,
 * using its members' combined figures; the series dialog keeps its own season
 * and episode order whatever is picked here.
 */
import type { DownloadGroup } from "./grouping";
import type { ClientTorrent } from "./types";

export const DOWNLOAD_SORTS = ["recent", "name", "quality", "size", "progress"] as const;
export type DownloadSort = (typeof DOWNLOAD_SORTS)[number];
export const DEFAULT_DOWNLOAD_SORT: DownloadSort = "recent";

/** The menu's wording; the closed select shows the first word only. */
export const DOWNLOAD_SORT_LABELS: Record<DownloadSort, string> = {
  recent: "Recent",
  name: "Name",
  quality: "Quality",
  size: "Size",
  progress: "Progress (least done)",
};

export function downloadSortShortLabel(sort: DownloadSort): string {
  return DOWNLOAD_SORT_LABELS[sort].split(" ")[0];
}

type Group = DownloadGroup<ClientTorrent>;

function members(group: Group): readonly ClientTorrent[] {
  return group.kind === "series" ? group.torrents : [group.torrent];
}

/** The newest member's add time; a series counts as new when anything in it is. */
function addedAtMs(group: Group): number | null {
  let latest: number | null = null;
  for (const torrent of members(group)) {
    const ms = torrent.addedAt ? Date.parse(torrent.addedAt) : Number.NaN;
    if (Number.isFinite(ms) && (latest == null || ms > latest)) latest = ms;
  }
  return latest;
}

/** The best resolution among the members, from the server-resolved quality. */
function bestResolution(group: Group): number | null {
  let best: number | null = null;
  for (const torrent of members(group)) {
    const resolution = torrent.quality.resolution
      ? Number.parseInt(torrent.quality.resolution, 10)
      : null;
    if (resolution != null && (best == null || resolution > best)) best = resolution;
  }
  return best;
}

function sizeOf(group: Group): number {
  const size = group.kind === "series" ? group.sizeBytes : Number(group.torrent.sizeBytes);
  return Number.isFinite(size) ? size : 0;
}

function progressOf(group: Group): number {
  const progress = group.kind === "series" ? group.progress : Number(group.torrent.progress);
  return Number.isFinite(progress) ? progress : 0;
}

/** Larger first, or smaller first when `ascending`; unknowns always go last. */
function compareKnown(a: number | null, b: number | null, ascending = false): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return ascending ? a - b : b - a;
}

/**
 * The list in the chosen order. `groups` arrive in name order (see
 * `groupDownloads`) and the sort is stable, so rows a key can't tell apart,
 * including rows from a client that doesn't say when they were added, keep
 * that order.
 */
export function sortDownloadGroups(groups: readonly Group[], sort: DownloadSort): Group[] {
  if (sort === "name") return [...groups];
  const keyed = groups.map((group) => ({
    group,
    key:
      sort === "recent"
        ? addedAtMs(group)
        : sort === "quality"
          ? bestResolution(group)
          : sort === "size"
            ? sizeOf(group)
            : progressOf(group),
  }));
  keyed.sort((a, b) => compareKnown(a.key, b.key, sort === "progress"));
  return keyed.map((entry) => entry.group);
}
