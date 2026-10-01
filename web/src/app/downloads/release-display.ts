/**
 * Display facts derived from a raw release name — shared by the compact
 * Downloads row and the series download dialog.
 *
 * Both surfaces have to agree about what a release *is called* (the parsed
 * title, not the scene name) and what one quality chip is worth showing, so
 * this is the one place that decides, rather than the page and the dialog each
 * carrying a copy that drifts the first time either changes.
 */
import { canFindAnotherSource } from "@/components/releases/find-another-source";
import type { ReleaseSwapSubject } from "@/components/releases/release-swap-dialog";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import { parseEpisode } from "@/lib/torrents/episodes";
import { parseSource, qualityChipLabel, type ReleaseSource } from "@/lib/torrents/quality";
import {
  isDownloaded,
  isDownloading,
  isError,
  isPaused,
  isQueued,
  leadQueuePosition,
} from "./grouping";
import { summarizeStatus, type StatusCounts } from "./status-rollup";
import type { ClientTorrent } from "./types";

/**
 * Both engines report qBittorrent's state vocabulary, which is precise but not
 * English. "stalledDL" in particular reads like an error when it only means
 * "connected to nobody yet", so say that instead.
 */
const STATE_LABELS: Record<string, string> = {
  metaDL: "Finding files",
  checkingDL: "Verifying",
  checkingUP: "Verifying",
  checkingResumeData: "Verifying",
  downloading: "Downloading",
  forcedDL: "Downloading",
  stalledDL: "Looking for peers",
  queuedDL: "Queued",
  allocating: "Allocating",
  uploading: "Ready",
  forcedUP: "Ready",
  stalledUP: "Ready",
  queuedUP: "Queued",
  seeding: "Ready",
  complete: "Ready",
  downloaded: "Ready",
  paused: "Paused",
  pausedDL: "Paused",
  pausedUP: "Paused",
  stoppedDL: "Stopped",
  stoppedUP: "Stopped",
  error: "Error",
  missingFiles: "Files missing",
  // The built-in engine's own download queue: admitted and ordered, but not
  // transferring yet because the active-download cap is full.
  queued: "Queued",
};

/**
 * The row's state in English. A built-in queued row also carries its 1-based
 * `queuePosition`, which is the one thing worth knowing about it ("Queued · #2").
 */
export function stateLabel(state: string, queuePosition?: number | null) {
  const raw = state.trim();
  const label =
    STATE_LABELS[raw] ??
    STATE_LABELS[Object.keys(STATE_LABELS).find((k) => k.toLowerCase() === raw.toLowerCase()) ?? ""] ??
    raw;
  if (
    raw.toLowerCase() === "queued" &&
    typeof queuePosition === "number" &&
    Number.isFinite(queuePosition) &&
    queuePosition > 0
  ) {
    return `${label} · #${Math.floor(queuePosition)}`;
  }
  return label;
}

/** Badge colour for a transfer/group state — errors use the destructive token. */
export function stateBadgeVariant(
  state: string,
): "accent" | "success" | "danger" | "default" {
  if (isError(state)) return "danger";
  if (isDownloaded(state)) return "success";
  if (isDownloading(state)) return "accent";
  if (isPaused(state) || isQueued(state)) return "default";
  return "default";
}

/**
 * A row's one state badge. A finished download whose files are gone from disk
 * says "Files missing" instead of Ready.
 */
export function rowStateBadge(
  torrent: Pick<ClientTorrent, "state" | "queuePosition" | "filesMissing">,
): { label: string; variant: "accent" | "success" | "danger" | "default"; filesMissing: boolean } {
  if (torrent.filesMissing === true) {
    return { label: "Files missing", variant: "danger", filesMissing: true };
  }
  return {
    label: stateLabel(torrent.state, torrent.queuePosition),
    variant: stateBadgeVariant(torrent.state),
    filesMissing: false,
  };
}

/** The server's plain failure text for an `error` row, or null. */
export function transferErrorMessage(
  torrent: Pick<ClientTorrent, "error" | "state">,
): string | null {
  if (!isError(torrent.state)) return null;
  return torrent.error?.trim() || null;
}

/**
 * The status chip for a series or season. Once any member has failed it reads
 * as counts ("1 downloading · 30 need attention") rather than one member's
 * state, and turns error-toned when most members failed.
 */
export function rollupChip(
  set: { state: string; counts: StatusCounts; torrents?: readonly ClientTorrent[] },
): { label: string; variant: "accent" | "success" | "danger" | "default"; failing: boolean } {
  const summary = summarizeStatus(set.counts);
  if (summary.label) {
    return { label: summary.label, variant: summary.tone, failing: summary.tone === "danger" };
  }
  return {
    label: stateLabel(set.state, set.torrents ? leadQueuePosition(set.torrents) : null),
    variant: stateBadgeVariant(set.state),
    failing: isError(set.state),
  };
}

/** Offer Download now only on a queued row the owner hasn't already pushed. */
export function canDownloadNow(torrent: Pick<ClientTorrent, "state" | "forced">): boolean {
  return isQueued(torrent.state) && torrent.forced !== true;
}

/**
 * The one of Pause and Resume that applies to a row, or null when neither does.
 *
 * A paused or failed row resumes (a failed one's "Retry"); anything still
 * downloading or waiting pauses. A finished built-in download offers neither:
 * the engine refuses to pause downloaded files, and resuming one does nothing.
 * An external client can still stop and restart sharing a finished torrent, so
 * those keep the one that matches their state.
 */
export function pauseResumeAction(
  torrent: Pick<ClientTorrent, "state" | "ownerClientType" | "refused">,
): "pause" | "resume" | null {
  // A release refused for a program file or no video would only fetch the same files again.
  if (torrent.refused === true) return null;
  if (isError(torrent.state) || isPaused(torrent.state)) return "resume";
  if (isDownloaded(torrent.state)) return torrent.ownerClientType === "builtin" ? null : "pause";
  return "pause";
}

/** A set's members split by the one of Pause and Resume each admits: what "Pause all" and "Resume all" act on. */
export function pauseResumeTargets<T extends Pick<ClientTorrent, "state" | "ownerClientType" | "refused">>(
  torrents: readonly T[],
): { pause: T[]; resume: T[] } {
  const targets: { pause: T[]; resume: T[] } = { pause: [], resume: [] };
  for (const torrent of torrents) {
    const act = pauseResumeAction(torrent);
    if (act) targets[act].push(torrent);
  }
  return targets;
}

/** A queued row that already got Download now is starting; say so instead of offering it again. */
export function forcedStartLabel(torrent: Pick<ClientTorrent, "state" | "forced">): string | null {
  return isQueued(torrent.state) && torrent.forced === true ? "Starting now" : null;
}

/**
 * The progress bar is for a download still on its way. A finished row says
 * Ready and nothing more, and a row that hasn't started has no bar to fill.
 */
export function showsProgressBar(torrent: Pick<ClientTorrent, "state" | "progress">): boolean {
  const progress = Number(torrent.progress);
  if (isDownloaded(torrent.state) || progress >= 1) return false;
  return isDownloading(torrent.state) || progress > 0;
}

/**
 * Whether Open and Show in folder apply: a finished built-in download whose
 * files are still on disk (docs/api-open-file.md). The server checks again.
 */
export function canOpenFinishedFile(
  torrent: Pick<ClientTorrent, "ownerClientType" | "state" | "filesMissing">,
): boolean {
  return torrent.ownerClientType === "builtin" && torrent.state === "downloaded" && torrent.filesMissing !== true;
}

const WAIT_REASON_LABELS: Record<string, string> = {
  "outside-window": "Waiting for download hours",
  "queue-full": "Waiting for a free slot",
  "lower-lane": "Waiting behind higher-priority downloads",
};

/** Why a queued built-in row has not started, in English; null when there is nothing to say. */
export function waitReasonLabel(state: string, waitReason?: string | null): string | null {
  if (state !== "queued" || !waitReason) return null;
  return WAIT_REASON_LABELS[waitReason] ?? null;
}

const CONTAINER_EXT = /\.(mkv|mp4|avi|m4v|mov|ts|webm|wmv|flv|mpg|mpeg)$/i;
const BRACKET_GROUP = /^\s*(?:\[[^\]]{2,40}\]\s*)+/;

const SOURCE_CHIPS: Record<ReleaseSource, string | null> = {
  BLURAY: "Blu-ray",
  WEBDL: "WEB-DL",
  WEBRIP: "WEBRip",
  HDTV: "HDTV",
  UNKNOWN: null,
};

/** The source a release name states (Blu-ray, WEB-DL, …), or null when it names none. */
export function sourceChip(raw: string): string | null {
  return SOURCE_CHIPS[parseSource(raw)];
}

export interface ReleaseDisplayFacts {
  /** The work's display title (show or film name), never a raw release string. */
  title: string;
  /** The work's year, so remakes (Dune 1984, Dune 2021) read apart; null when unknown. */
  year: number | null;
  /** `S09E01`, `S01 pack`, … or null when the name states no episode. */
  episodeLabel: string | null;
  /**
   * The one quality tag worth showing in the row — resolution only.
   *
   * Source/scene tags (WEB-DL, HDTV) are torrent mechanics the product rule
   * hides; they are kept out of the row and surfaced only in the overflow's
   * Details, via `sourceChip`.
   */
  qualityChip: string | null;
}

export function releaseDisplayFacts(
  torrent: ClientTorrent,
  query = artworkQueryForRelease(torrent.name, torrent.category),
): ReleaseDisplayFacts {
  const fallback = torrent.name
    .replace(CONTAINER_EXT, "")
    .replace(BRACKET_GROUP, "")
    .replace(/\s+/g, " ")
    .trim();
  // The catalog title wins; the release name only stands in for a download no work claims.
  const title = torrent.workTitle?.trim() || query.title || fallback || torrent.name;
  return {
    title,
    year: torrent.workTitle?.trim() && typeof torrent.workYear === "number" ? torrent.workYear : null,
    episodeLabel: parseEpisode(torrent.name).label,
    qualityChip: qualityChipLabel(torrent.name),
  };
}

/** A film's headline: "Dune (1984)", or the title alone when the year is unknown. */
export function titleWithYear(title: string, year: number | null | undefined): string {
  return typeof year === "number" && year > 0 ? `${title} (${year})` : title;
}

/** Finished the way the server counts it: downloaded, or every byte is in. */
export function isFinishedTransfer(torrent: Pick<ClientTorrent, "state" | "progress">): boolean {
  return isDownloaded(torrent.state) || Number(torrent.progress) >= 0.9999;
}

/** Plain status for a season pack transfer that fills only the missing episodes; null for normal rows. */
export function packLabel(torrent: Pick<ClientTorrent, "state" | "packEpisodes" | "progress">): string | null {
  const count = torrent.packEpisodes ?? 0;
  if (count <= 0) return null;
  const episodes = `${count} missing ${count === 1 ? "episode" : "episodes"}`;
  return isFinishedTransfer(torrent)
    ? `Got ${episodes} from a season pack`
    : `Downloading ${episodes} from a season pack`;
}

/**
 * Whether a Downloads row offers Find another source. A season pack row fills
 * several episodes at once, so it offers none for now.
 */
export function canFindAnotherSourceFor(
  torrent: Pick<ClientTorrent, "hash" | "ownerClientType" | "packEpisodes" | "state" | "progress">,
): boolean {
  return canFindAnotherSource({
    builtin: torrent.ownerClientType === "builtin",
    hash: torrent.hash,
    pack: Boolean(torrent.packEpisodes),
    finished: isFinishedTransfer(torrent),
  });
}

/** What the Find another source dialog is told about a Downloads row. */
export function swapSubjectFor(torrent: ClientTorrent): ReleaseSwapSubject {
  return {
    hash: torrent.hash,
    workTitle: torrent.workTitle,
    label: transferLabel(torrent),
    live: {
      state: torrent.state,
      queuePosition: torrent.queuePosition,
      peers: torrent.peers,
      dlspeed: torrent.dlspeed,
    },
  };
}

/** How a toast or announcement names one download: its title, plus its episode when it has one. */
export function transferLabel(torrent: ClientTorrent): string {
  const { title, episodeLabel } = releaseDisplayFacts(torrent);
  return episodeLabel ? `${title} ${episodeLabel}` : title;
}

/** How a message names a set of downloads: a lone one by its label, more than one as "N downloads". */
export function transfersLabel(torrents: readonly ClientTorrent[]): string {
  return torrents.length === 1 ? transferLabel(torrents[0]) : `${torrents.length} downloads`;
}
