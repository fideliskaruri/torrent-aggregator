/**
 * The Downloads page's own row shape, and the small predicate that decides
 * what belongs on the page at all.
 *
 * Split out of `page.tsx` so `page.tsx`, `series-download-dialog.tsx` and
 * `release-display.ts` share one definition rather than three copies quietly
 * drifting apart.
 */

export type QueueWaitReason = "outside-window" | "queue-full" | "lower-lane";

export interface ClientTorrent {
  hash: string;
  name: string;
  progress: number;
  sizeBytes: number;
  dlspeed: number;
  upspeed: number;
  state: string;
  playable?: boolean;
  eta?: number;
  peers?: number;
  category?: string;
  savePath?: string | null;
  retentionState?: "kept" | "stream" | "prewarm" | "unknown";
  /** 1-based place in the built-in download queue; set only while `state` is "queued". */
  queuePosition?: number;
  /** Why a queued built-in row is waiting (server-computed); absent otherwise. */
  waitReason?: QueueWaitReason | null;
  /** Queue priority of a kept built-in download: owner > request > automation. */
  lane?: "owner" | "request" | "automation" | null;
  workId?: string | null;
  workKey?: string | null;
  workTitle?: string | null;
  workYear?: number | null;
  workMediaType?: string | null;
  targetScope?: string | null;
  season?: number | null;
  episode?: number | null;
  ownerClientType: "qbittorrent" | "transmission" | "builtin";
  ownerClientLabel: string;
  transferId: string;
  /** Shareable magnet built by the server (own trackers + public list); absent for external-client rows. */
  magnet?: string | null;
  imported?: boolean;
}

/**
 * A one-row action on a transfer. `force` is "Download now": it starts a row
 * waiting in the built-in engine's queue past the active-download cap.
 */
export type TorrentRowAction = "pause" | "resume" | "force";

/**
 * A stream (or prewarm) torrent is an ephemeral playback cache — the engine
 * only ever holds the pieces needed to watch, and it is evicted like a cache.
 * It is not a download the user chose to keep, so it must never appear in the
 * downloads list, be counted in its stats, or be visible in the series dialog.
 * `retentionState` is annotated by /api/client/torrents from
 * EngineTorrent.origin.
 */
export function isDownloadRow(t: ClientTorrent): boolean {
  return t.retentionState !== "stream" && t.retentionState !== "prewarm";
}

export interface NowPlaying {
  infoHash: string;
  title: string;
  episodeTitle?: string | null;
  episodeTitles?: Readonly<Record<string, string>>;
  season?: number | null;
  episode?: number | null;
}

export interface StreamManifestFile {
  path: string;
  length: number;
}
