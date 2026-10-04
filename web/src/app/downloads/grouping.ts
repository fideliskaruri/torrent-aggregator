import { formatSeasonLabel } from "@/lib/library/cursor";
import type { ClientTorrent, DownloadStatus } from "./types";

export interface StatusCounts {
  total: number;
  downloading: number;
  queued: number;
  paused: number;
  done: number;
  error: number;
}

interface CombinedTotals {
  progress: number;
  sizeBytes: number;
  dlspeed: number;
  upspeed: number;
  status: DownloadStatus;
  statusLabel: string;
  counts: StatusCounts;
}

export interface SeasonBucket<T> extends CombinedTotals {
  season: number | null;
  key: string;
  label: string;
  entries: T[];
}

export interface SeriesGroup<T> extends CombinedTotals {
  kind: "series";
  key: string;
  title: string;
  seasons: SeasonBucket<T>[];
  torrents: T[];
  releaseCount: number;
  seasonCount: number;
}

interface SingleGroup<T> {
  kind: "single";
  key: string;
  title: string;
  torrent: T;
}

export type DownloadGroup<T> = SeriesGroup<T> | SingleGroup<T>;

function emptyStatusCounts(): StatusCounts {
  return { total: 0, downloading: 0, queued: 0, paused: 0, done: 0, error: 0 };
}

export function statusCounts(rows: readonly Pick<ClientTorrent, "status">[]): StatusCounts {
  const counts = emptyStatusCounts();
  for (const row of rows) {
    counts.total += 1;
    if (row.status === "error") counts.error += 1;
    else if (row.status === "ready") counts.done += 1;
    else if (row.status === "queued") counts.queued += 1;
    else if (row.status === "paused") counts.paused += 1;
    else counts.downloading += 1;
  }
  return counts;
}

const STATUS_RANK: Record<DownloadStatus, number> = {
  downloading: 7,
  finishing: 6,
  waiting: 5,
  error: 4,
  queued: 3,
  paused: 2,
  ready: 1,
};

function combinedStatus(rows: readonly ClientTorrent[]): ClientTorrent {
  return rows.reduce((best, row) => STATUS_RANK[row.status] > STATUS_RANK[best.status] ? row : best);
}

function totalsFor(rows: readonly ClientTorrent[]): CombinedTotals {
  const sizeBytes = rows.reduce((sum, row) => sum + Math.max(0, row.sizeBytes || 0), 0);
  const completedBytes = rows.reduce(
    (sum, row) => sum + Math.max(0, row.sizeBytes || 0) * Math.min(1, Math.max(0, row.progress || 0)),
    0,
  );
  const representative = combinedStatus(rows);
  return {
    progress: sizeBytes > 0 ? completedBytes / sizeBytes : 0,
    sizeBytes,
    dlspeed: rows.reduce((sum, row) => sum + (Number(row.dlspeed) || 0), 0),
    upspeed: rows.reduce((sum, row) => sum + (Number(row.upspeed) || 0), 0),
    status: representative.status,
    statusLabel: representative.statusLabel,
    counts: statusCounts(rows),
  };
}

function compareEntries(a: ClientTorrent, b: ClientTorrent): number {
  return (a.episode ?? Number.MAX_SAFE_INTEGER) - (b.episode ?? Number.MAX_SAFE_INTEGER)
    || a.name.localeCompare(b.name, undefined, { numeric: true })
    || a.transferId.localeCompare(b.transferId);
}

export function groupDownloads(rows: readonly ClientTorrent[]): DownloadGroup<ClientTorrent>[] {
  const byKey = new Map<string, ClientTorrent[]>();
  for (const row of rows) {
    const key = row.groupKey;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  const groups: DownloadGroup<ClientTorrent>[] = [];
  for (const [key, members] of byKey) {
    const title = members.find((row) => row.workTitle?.trim())?.workTitle?.trim() || members[0].name;
    if (!members[0].isSeries) {
      for (const torrent of members) {
        groups.push({ kind: "single", key: `single:${torrent.transferId}`, title, torrent });
      }
      continue;
    }

    const seasonMap = new Map<number | null, ClientTorrent[]>();
    for (const torrent of members) {
      const season = torrent.season ?? null;
      const bucket = seasonMap.get(season);
      if (bucket) bucket.push(torrent);
      else seasonMap.set(season, [torrent]);
    }

    const seasons = [...seasonMap.entries()]
      .map(([season, entries]) => {
        const sorted = [...entries].sort(compareEntries);
        const label = season == null ? "Other" : `Season ${formatSeasonLabel(season).slice(1)}`;
        return {
          season,
          key: `${key}::${label}`,
          label,
          entries: sorted,
          ...totalsFor(sorted),
        };
      })
      .sort((a, b) => a.season == null ? 1 : b.season == null ? -1 : a.season - b.season);

    groups.push({
      kind: "series",
      key,
      title,
      seasons,
      torrents: members,
      releaseCount: members.length,
      seasonCount: seasons.length,
      ...totalsFor(members),
    });
  }

  return groups.sort(
    (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) || a.key.localeCompare(b.key),
  );
}

export function seriesEpisodeTally(group: SeriesGroup<ClientTorrent>) {
  const statuses = new Map<string, DownloadStatus>();
  for (const row of group.torrents) {
    if (row.season == null || row.episode == null || row.packEpisodes) continue;
    const key = `${row.season}:${row.episode}`;
    const current = statuses.get(key);
    if (!current || STATUS_RANK[row.status] > STATUS_RANK[current]) statuses.set(key, row.status);
  }
  let downloaded = 0;
  let downloading = 0;
  let queued = 0;
  for (const status of statuses.values()) {
    if (status === "ready") downloaded += 1;
    else if (status === "downloading" || status === "finishing") downloading += 1;
    else if (status === "queued") queued += 1;
  }
  return { downloaded, downloading, queued };
}
