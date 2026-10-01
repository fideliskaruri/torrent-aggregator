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
  eta?: number;
  peers?: number;
  category?: string;
  savePath?: string | null;
  retentionState?: "kept" | "unknown";
  /** 1-based place in the built-in download queue; set only while `state` is "queued". */
  queuePosition?: number;
  /** Why a queued built-in row is waiting (server-computed); absent otherwise. */
  waitReason?: QueueWaitReason | null;
  /** Queue priority of a kept built-in download: owner > request > automation. */
  lane?: "owner" | "request" | "automation" | null;
  /** Plain failure text when `state` is `error` (docs/dotnet-port.md, Downloads list JSON). */
  error?: string | null;
  /** The owner pressed Download now on this row. */
  forced?: boolean;
  /** Checked on disk after completion; survives a restart with no live client. */
  verified?: boolean;
  /** When the transfer was added, ISO 8601 UTC; null when the client does not say. */
  addedAt?: string | null;
  /** A finished built-in download whose kept files are gone from disk. */
  filesMissing?: boolean;
  workId?: string | null;
  workKey?: string | null;
  workTitle?: string | null;
  workYear?: number | null;
  workMediaType?: string | null;
  targetScope?: string | null;
  season?: number | null;
  episode?: number | null;
  /** Missing episodes this one season pack transfer is filling (selected files only); absent for normal rows. */
  packEpisodes?: number | null;
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
 * `swap` opens "Find another source"; it sends nothing by itself.
 */
export type TorrentRowAction = "pause" | "resume" | "force" | "swap";

/**
 * Whether a row belongs on the Downloads page: every transfer the server marks
 * as kept, or does not mark at all. A server older than this build may still
 * report a short-lived cache transfer, and that was never a download the user
 * chose to keep.
 */
export function isDownloadRow(t: ClientTorrent): boolean {
  return (
    t.retentionState == null ||
    t.retentionState === "kept" ||
    t.retentionState === "unknown"
  );
}