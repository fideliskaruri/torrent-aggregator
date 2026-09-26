import { sessionAwareFetch } from "@/lib/session-expiry";

export type DownloadState = "idle" | "downloading" | "installing" | "done" | "failed";

export interface DownloadProgress {
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number | null;
  error: string | null;
}

export interface DesktopStatus {
  supported: boolean;
  platform: "windows" | "macos" | "linux" | "other";
  version: string;
  editable: boolean;
  autostart: { available: boolean; enabled: boolean; pointsElsewhere: boolean };
  updates: {
    available: boolean;
    enabled: boolean;
    checking: boolean;
    lastCheckedAt: string | null;
    lastError: string | null;
    updateAvailable: boolean;
    latest: { version: string; tag: string; pageUrl: string | null; hasInstaller: boolean } | null;
    install: DownloadProgress;
  };
  ffmpeg: {
    ffmpeg: string | null;
    ffprobe: string | null;
    managed: boolean;
    canDownload: boolean;
    toolsDirectory: string;
    packageLabel: string | null;
    packageSize: number | null;
    download: DownloadProgress;
  };
}

export const DESKTOP_URL = "/api/desktop";
export const UPDATE_DISMISS_KEY = "tf_update_dismissed";

/** A transfer in flight: the UI polls quickly until it settles. */
export function isBusy(progress: DownloadProgress | null | undefined): boolean {
  return progress?.state === "downloading" || progress?.state === "installing";
}

/** Whole-number percent, or null while the size is unknown. */
export function progressPercent(progress: DownloadProgress): number | null {
  if (!progress.totalBytes || progress.totalBytes <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100)));
}

export function formatMegabytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** The banner shows only when an update is offered, the owner is local, and they have not dismissed this version. */
export function shouldShowUpdateBanner(status: DesktopStatus | null, dismissedVersion: string | null): boolean {
  if (!status?.supported || !status.editable) return false;
  const updates = status.updates;
  if (isBusy(updates.install)) return true;
  if (!updates.updateAvailable || !updates.latest) return false;
  return dismissedVersion !== updates.latest.version;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return fallback;
}

export async function saveDesktopSettings(
  change: { startWithWindows?: boolean; checkForUpdates?: boolean },
): Promise<DesktopStatus> {
  const res = await sessionAwareFetch("/api/desktop/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!res.ok) throw new Error(await readError(res, `Save failed (${res.status})`));
  return (await res.json()) as DesktopStatus;
}

export async function checkForUpdatesNow(): Promise<DesktopStatus> {
  const res = await sessionAwareFetch("/api/desktop/update/check", { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, `Check failed (${res.status})`));
  return (await res.json()) as DesktopStatus;
}

export async function startUpdate(): Promise<void> {
  const res = await sessionAwareFetch("/api/desktop/update/install", { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, `Update failed (${res.status})`));
}

export async function startFfmpegDownload(): Promise<void> {
  const res = await sessionAwareFetch("/api/desktop/ffmpeg/download", { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, `Download failed (${res.status})`));
}
