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
  languageNote?: string | null;
  /**
   * While `state` is "held": why the promotion gate wants the owner to decide
   * (docs/english-gates-plan.md). The files wait outside the library; Keep moves
   * them in, Find another deletes them and picks another release.
   */
  heldReason?: string | null;
  /** Who chose the release: the finder ("automatic") or the owner ("hand"). */
  provenance?: "automatic" | "hand" | null;

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
  /** The matched work's poster, resolved by the server; absent when it has none yet. */
  posterUrl?: string | null;
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
  /**
   * A failed release the app already replaced: its film or episode has another
   * release, is Ready, or is being looked for again. History, not an error.
   */
  replaced?: boolean;
  /** Refused for a program file or no video; retrying would fetch the same files. */
  refused?: boolean;
}

/**
 * A one-row action on a transfer. `force` is "Download now": it starts a row
 * waiting in the built-in engine's queue past the active-download cap.
 * `swap` opens "Find another source"; it sends nothing by itself.
 * `keep` and `find-another` answer a held row: move its files into the
 * library, or drop them and pick another release.
 */
export type TorrentRowAction = "pause" | "resume" | "force" | "swap" | "keep" | "find-another";

/**
 * Whether a row belongs on the Downloads page: every transfer the server marks
 * as kept, or does not mark at all. A server older than this build may still
 * report a short-lived cache transfer, and that was never a download the user
 * chose to keep. A failed release the app already replaced is history and
 * leaves the list, so it never counts as needing attention.
 */
export function isDownloadRow(t: ClientTorrent): boolean {
  if (t.replaced === true) return false;
  return (
    t.retentionState == null ||
    t.retentionState === "kept" ||
    t.retentionState === "unknown"
  );
}