import { isSupportedVideoFileName } from "@/lib/torrents/filters";

export const DOWNLOAD_COMPLETE_PROGRESS = 0.9999;

export type PersistedTorrentLifecycleRow = {
  progress: number;
  status: string;
  magnet?: string | null;
  torrentUrl?: string | null;
  verifiedBitfield?: string | null;
  verifiedFilesJson?: string | null;
};

function parsedVerifiedFilePaths(
  row: Pick<
    PersistedTorrentLifecycleRow,
    "verifiedFilesJson"
  >,
): string[] {
  try {
    const parsed = JSON.parse(row.verifiedFilesJson ?? "null") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string"
          ? (entry as { path: string }).path
          : "",
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hasVerifiedCompletionEvidence(
  row: Pick<
    PersistedTorrentLifecycleRow,
    "progress" | "verifiedBitfield" | "verifiedFilesJson"
  >,
): boolean {
  return (
    Number(row.progress) >= DOWNLOAD_COMPLETE_PROGRESS &&
    Boolean(row.verifiedBitfield?.trim()) &&
    parsedVerifiedFilePaths(row).length > 0
  );
}

export function persistedTorrentHasSupportedVideo(
  row: Pick<PersistedTorrentLifecycleRow, "verifiedFilesJson">,
): boolean {
  return parsedVerifiedFilePaths(row).some(isSupportedVideoFileName);
}

export function persistedTorrentHasInvalidMedia(
  row: Pick<
    PersistedTorrentLifecycleRow,
    "progress" | "verifiedBitfield" | "verifiedFilesJson"
  >,
): boolean {
  return hasVerifiedCompletionEvidence(row) && !persistedTorrentHasSupportedVideo(row);
}

export function persistedTorrentIsDownloaded(
  row: Pick<
    PersistedTorrentLifecycleRow,
    "progress" | "status" | "verifiedBitfield" | "verifiedFilesJson"
  >,
): boolean {
  return hasVerifiedCompletionEvidence(row) && persistedTorrentHasSupportedVideo(row);
}

export function shouldRehydrateTorrent(
  row: PersistedTorrentLifecycleRow,
): boolean {
  const status = String(row.status).toLowerCase();
  if (status === "removed" || status === "error") return false;
  if (status === "parked") return false;
  if (persistedTorrentHasInvalidMedia(row)) return false;
  if (persistedTorrentIsDownloaded(row)) return false;
  return Boolean(row.torrentUrl?.trim() || row.magnet?.trim());
}

export function persistedTorrentDisplayState(
  row: Pick<
    PersistedTorrentLifecycleRow,
    "progress" | "status" | "verifiedBitfield" | "verifiedFilesJson"
  >,
): string {
  const status = String(row.status);
  if (status === "error") return "error";
  if (persistedTorrentHasInvalidMedia(row)) return "error";
  if (persistedTorrentIsDownloaded(row)) return "downloaded";
  if (status === "paused") return "paused";
  if (status.toLowerCase() === "parked") return "paused";
  if (Number(row.progress) > 0) return "downloading";
  return "metaDL";
}
