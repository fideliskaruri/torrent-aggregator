import type { DownloadStatus, ClientTorrent } from "./types";
import { isDownloaded, isDownloading, isError } from "./grouping";
import { summarizeStatus } from "./status-rollup";
import type { StatusCounts } from "./grouping";

export interface ReleaseDisplayFacts {
  title: string;
  year: number | null;
  episodeLabel: string | null;
  qualityChip: string | null;
}

export function releaseDisplayFacts(torrent: ClientTorrent): ReleaseDisplayFacts {
  const episodeLabel = torrent.season != null && torrent.episode != null
    ? `S${String(torrent.season).padStart(2, "0")}E${String(torrent.episode).padStart(2, "0")}`
    : null;
  return {
    title: torrent.workTitle?.trim() || torrent.name,
    year: torrent.workYear ?? null,
    episodeLabel,
    qualityChip: torrent.quality.label,
  };
}

export function titleWithYear(title: string, year: number | null | undefined): string {
  return typeof year === "number" && year > 0 ? `${title} (${year})` : title;
}

export function stateBadgeVariant(status: DownloadStatus): "accent" | "success" | "danger" | "default" {
  if (status === "error") return "danger";
  if (status === "ready") return "success";
  if (status === "downloading" || status === "finishing") return "accent";
  return "default";
}

export function rowStateBadge(torrent: Pick<ClientTorrent, "status" | "statusLabel" | "filesMissing">) {
  return {
    label: torrent.statusLabel,
    variant: torrent.filesMissing ? "danger" as const : stateBadgeVariant(torrent.status),
    filesMissing: torrent.filesMissing === true,
  };
}

export function transferErrorMessage(torrent: Pick<ClientTorrent, "status" | "statusLabel">): string | null {
  return torrent.status === "error" ? torrent.statusLabel : null;
}

export function rollupChip(set: {
  status: DownloadStatus;
  statusLabel: string;
  counts: StatusCounts;
}): { label: string; variant: "accent" | "success" | "danger" | "default"; failing: boolean } {
  const summary = summarizeStatus(set.counts);
  if (summary.label) return { label: summary.label, variant: summary.tone, failing: summary.tone === "danger" };
  return {
    label: set.statusLabel,
    variant: stateBadgeVariant(set.status),
    failing: isError(set.status),
  };
}

export function pauseResumeAction(
  torrent: Pick<ClientTorrent, "actions">,
): "pause" | "resume" | null {
  if (torrent.actions.resume) return "resume";
  if (torrent.actions.pause) return "pause";
  return null;
}

export function pauseResumeTargets<T extends Pick<ClientTorrent, "actions">>(
  torrents: readonly T[],
): { pause: T[]; resume: T[] } {
  const targets: { pause: T[]; resume: T[] } = { pause: [], resume: [] };
  for (const torrent of torrents) {
    const action = pauseResumeAction(torrent);
    if (action) targets[action].push(torrent);
  }
  return targets;
}

export function canDownloadNow(torrent: Pick<ClientTorrent, "actions">): boolean {
  return torrent.actions.downloadNow;
}

export function canOpenFinishedFile(torrent: Pick<ClientTorrent, "actions">): boolean {
  return torrent.actions.open;
}

export function showsProgressBar(torrent: Pick<ClientTorrent, "status" | "progress">): boolean {
  return !isDownloaded(torrent.status) && (isDownloading(torrent.status) || torrent.progress > 0);
}

export function sourceChip(torrent: Pick<ClientTorrent, "quality">): string | null {
  const labels = { web: "WEB-DL", bluray: "Blu-ray", hdtv: "HDTV", dvd: "DVD", cam: "CAM", ts: "TS" };
  const source = torrent.quality.source;
  return source ? labels[source] : null;
}

export function canFindAnotherSourceFor(
  torrent: Pick<ClientTorrent, "actions">,
): boolean {
  return torrent.actions.findAnother;
}

export function packLabel(torrent: Pick<ClientTorrent, "status" | "packEpisodes">): string | null {
  const count = torrent.packEpisodes ?? 0;
  if (!count) return null;
  return `${count} missing ${count === 1 ? "episode" : "episodes"} in season pack`;
}

export function transferLabel(torrent: ClientTorrent): string {
  const { title, episodeLabel } = releaseDisplayFacts(torrent);
  return episodeLabel ? `${title} ${episodeLabel}` : title;
}

export function transfersLabel(torrents: readonly ClientTorrent[]): string {
  return torrents.length === 1 ? transferLabel(torrents[0]) : `${torrents.length} downloads`;
}
