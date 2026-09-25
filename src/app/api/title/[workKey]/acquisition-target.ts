export type AcquisitionScope = "title" | "season" | "episode";
export type AcquisitionStatus =
  | "queued"
  | "downloading"
  | "downloaded"
  | "failed";

export interface AcquisitionTransfer {
  status: AcquisitionStatus;
  progress: number;
  infoHash: string | null;
  filePath: string | null;
  error: string | null;
}

export type AcquisitionFilePresence = "present" | "absent" | "unknown";

export type ValidatedAcquisitionScope =
  | { ok: true; scope: "title"; season: null; episode: null }
  | { ok: true; scope: "season"; season: number; episode: null }
  | { ok: true; scope: "episode"; season: number; episode: number }
  | { ok: false; message: string };

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : null;
}

export function validateAcquisitionScope(input: {
  scope?: unknown;
  season?: unknown;
  episode?: unknown;
  episodes?: unknown;
  infoHash?: unknown;
}): ValidatedAcquisitionScope {
  if (
    typeof input.infoHash === "string" &&
    input.infoHash.trim().length > 0
  ) {
    return {
      ok: false,
      message: "Acquisition intent cannot pin or promote a torrent hash.",
    };
  }

  if (input.scope === "episode") {
    const season = positiveInteger(input.season);
    const episode = positiveInteger(input.episode);
    if (
      season == null ||
      episode == null ||
      (Array.isArray(input.episodes) && input.episodes.length > 0)
    ) {
      return {
        ok: false,
        message: "Episode scope requires exactly one season and episode.",
      };
    }
    return { ok: true, scope: "episode", season, episode };
  }

  if (input.scope === "season") {
    const season = positiveInteger(input.season);
    if (
      season == null ||
      input.episode != null ||
      !Array.isArray(input.episodes) ||
      input.episodes.length === 0
    ) {
      return {
        ok: false,
        message: "Season scope requires a season and its episode list.",
      };
    }
    return { ok: true, scope: "season", season, episode: null };
  }

  if (input.scope === "title") {
    if (
      input.season != null ||
      input.episode != null ||
      (Array.isArray(input.episodes) && input.episodes.length > 0)
    ) {
      return {
        ok: false,
        message: "Title scope cannot include season or episode coordinates.",
      };
    }
    return { ok: true, scope: "title", season: null, episode: null };
  }

  return {
    ok: false,
    message: "An explicit acquisition scope is required.",
  };
}

export function acquisitionTargetKey(
  workKey: string,
  scope: AcquisitionScope,
  season: number | null,
  episode: number | null,
): string {
  return [workKey, scope, season ?? "-", episode ?? "-"].join(":");
}

function clampProgress(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

export function resolveAcquisitionTransfer(
  target: AcquisitionTransfer,
  torrent: {
    hash: string;
    status: string;
    progress: number;
  } | null,
  filePresence: AcquisitionFilePresence = "unknown",
): AcquisitionTransfer {
  if (target.infoHash == null) {
    return { ...target, progress: clampProgress(target.progress) };
  }
  if (
    torrent != null &&
    torrent.hash.toLowerCase() !== target.infoHash.toLowerCase()
  ) {
    return { ...target, progress: clampProgress(target.progress) };
  }
  if (torrent == null || filePresence === "absent") {
    return {
      ...target,
      status: "failed",
      progress: 0,
      infoHash: null,
      filePath: null,
      error: "The requested file is no longer available.",
    };
  }

  const torrentStatus = torrent.status.toLowerCase();
  if (torrentStatus === "error" || torrentStatus === "missingfiles") {
    return {
      ...target,
      status: "failed",
      progress: 0,
      infoHash: null,
      filePath: null,
      error: target.error || "The downloaded release could not be used. TorrentFlow will choose another release.",
    };
  }

  const progress = clampProgress(torrent.progress);
  const downloaded =
    progress >= 1 || torrentStatus === "seeding";
  const status: AcquisitionStatus = downloaded
    ? "downloaded"
    : target.status === "failed"
      ? "failed"
      : torrentStatus === "queued"
        ? // Waiting in the built-in engine's download queue: admitted, not moving.
          "queued"
        : "downloading";
  return {
    ...target,
    status,
    progress: downloaded ? 1 : progress,
  };
}

export function acquisitionTransferFromRow(row: {
  status: string;
  progress: number;
  infoHash: string | null;
  filePath: string | null;
  error: string | null;
}): AcquisitionTransfer {
  const status: AcquisitionStatus =
    row.status === "queued" ||
    row.status === "downloading" ||
    row.status === "downloaded" ||
    row.status === "failed"
      ? row.status
      : "queued";
  return {
    status,
    progress: clampProgress(row.progress),
    infoHash: row.infoHash,
    filePath: row.filePath,
    error: row.error,
  };
}
