/**
 * Display facts derived from a raw release name — shared by the compact
 * Downloads row and the series download dialog.
 *
 * Both surfaces have to agree about what a release *is called* (the parsed
 * title, not the scene name) and what one quality chip is worth showing, so
 * this is the one place that decides, rather than the page and the dialog each
 * carrying a copy that drifts the first time either changes.
 */
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import { parseEpisode } from "@/lib/torrents/episodes";
import { parseResolution, parseSourceTier, SOURCE_TIER } from "@/lib/torrents/quality";
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
};

export function stateLabel(state: string) {
  return STATE_LABELS[state] ?? state;
}

const CONTAINER_EXT = /\.(mkv|mp4|avi|m4v|mov|ts|webm|wmv|flv|mpg|mpeg)$/i;
const BRACKET_GROUP = /^\s*(?:\[[^\]]{2,40}\]\s*)+/;

function resolutionChip(raw: string): string | null {
  const resolution = parseResolution(raw);
  return resolution ? `${resolution}p` : null;
}

export function sourceTierChip(raw: string): string | null {
  const tier = parseSourceTier(raw);
  if (tier === SOURCE_TIER.WEBDL) return "WEB-DL";
  if (tier === SOURCE_TIER.HDTV) return "HDTV";
  if (tier === SOURCE_TIER.BLURAY) return "Blu-ray";
  return null;
}

export interface ReleaseDisplayFacts {
  /** The work's display title (show or film name), never a raw release string. */
  title: string;
  /** `S09E01`, `S01 pack`, … or null when the name states no episode. */
  episodeLabel: string | null;
  /**
   * The one quality tag worth showing in the row — resolution only.
   *
   * Source/scene tags (WEB-DL, HDTV) are torrent mechanics the product rule
   * hides; they are kept out of the row and surfaced only in the overflow's
   * Details, via `sourceTierChip`.
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
  const title = query.title || fallback || torrent.name;
  return {
    title,
    episodeLabel: parseEpisode(torrent.name).label,
    qualityChip: resolutionChip(torrent.name),
  };
}
