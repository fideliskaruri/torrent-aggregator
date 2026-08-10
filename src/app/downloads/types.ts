/**
 * The Downloads page's own row shape, and the small predicate that decides
 * what belongs on the page at all.
 *
 * Split out of `page.tsx` so `page.tsx`, `series-download-dialog.tsx` and
 * `release-display.ts` share one definition rather than three copies quietly
 * drifting apart.
 */

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
  ownerClientType: "qbittorrent" | "transmission" | "builtin";
  ownerClientLabel: string;
  transferId: string;
}

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
  season?: number | null;
  episode?: number | null;
}

export interface StreamManifestFile {
  path: string;
  length: number;
}
