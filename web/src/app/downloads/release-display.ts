import type { DownloadStatus, ClientTorrent } from "./types";
import { summarizeStatus } from "./status-rollup";
import type { StatusCounts } from "./grouping";
import { formatEpisodeLabel } from "@/lib/library/cursor";

export interface ReleaseDisplayFacts {
  title: string;
  year: number | null;
  episodeLabel: string | null;
}

export function releaseDisplayFacts(torrent: ClientTorrent): ReleaseDisplayFacts {
  const episodeLabel = torrent.season != null && torrent.episode != null
    ? formatEpisodeLabel(torrent.season, torrent.episode)
    : null;
  return {
    title: torrent.workTitle?.trim() || torrent.name,
    year: torrent.workYear ?? null,
    episodeLabel,
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
  };
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
    failing: set.status === "error",
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

export function showsProgressBar(torrent: Pick<ClientTorrent, "status" | "progress">): boolean {
  return torrent.status !== "ready" && (
    torrent.status === "downloading" || torrent.status === "finishing" ||
    torrent.status === "waiting" || torrent.progress > 0
  );
}

export function packLabel(torrent: Pick<ClientTorrent, "packEpisodes">): string | null {
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
