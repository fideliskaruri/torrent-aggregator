/**
 * Download hours: weekly rules that say when new downloads may start. Mirrors the
 * server's DownloadWindow (server/TorrentFlow.Engine/Queue/DownloadWindows.cs).
 * Rates travel as bytes per second; the form edits them as MB/s where blank means no limit.
 */

export interface DownloadWindow {
  /** Days the window starts on, 0 = Sunday. */
  days: number[];
  startHour: number;
  /** 1–24. At or before startHour means the window runs overnight into the next day. */
  endHour: number;
  maxActiveDownloads?: number | null;
  maxDownloadRate?: number | null;
  maxUploadRate?: number | null;
}

/** The editable shape: caps are strings so an empty box means "no limit". */
export interface DownloadWindowDraft {
  days: number[];
  startHour: number;
  endHour: number;
  maxActiveDownloads: string;
  maxDownloadMbps: string;
  maxUploadMbps: string;
}

export const MAX_DOWNLOAD_WINDOWS = 14;
export const MAX_WINDOW_ACTIVE = 20;
const BYTES_PER_MB = 1_000_000;
const MAX_RATE = 2_147_483_647;

export const DAY_LABELS = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 0, short: "Sun", long: "Sunday" },
] as const;

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function newWindowDraft(): DownloadWindowDraft {
  return {
    days: [1, 2, 3, 4, 5],
    startHour: 1,
    endHour: 7,
    maxActiveDownloads: "",
    maxDownloadMbps: "",
    maxUploadMbps: "",
  };
}

function mbps(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "";
  // Exact (bytes are whole numbers, so at most six decimals) so an untouched rate saves back unchanged.
  return String(bytes / BYTES_PER_MB);
}

export function toDraft(window: DownloadWindow): DownloadWindowDraft {
  return {
    days: [...window.days].sort((a, b) => a - b),
    startHour: window.startHour,
    endHour: window.endHour,
    maxActiveDownloads:
      window.maxActiveDownloads != null ? String(window.maxActiveDownloads) : "",
    maxDownloadMbps: mbps(window.maxDownloadRate),
    maxUploadMbps: mbps(window.maxUploadRate),
  };
}

function toRate(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  if (!Number.isFinite(number) || number <= 0) return Number.NaN;
  return Math.min(MAX_RATE, Math.max(1, Math.round(number * BYTES_PER_MB)));
}

/** Draft → API body. Throws with a readable message when a rule cannot be saved. */
export function toWindow(draft: DownloadWindowDraft, index: number): DownloadWindow {
  const problem = validateDraft(draft);
  if (problem) throw new Error(`Download hours rule ${index + 1}: ${problem}`);
  const active = draft.maxActiveDownloads.trim();
  return {
    days: [...new Set(draft.days)].sort((a, b) => a - b),
    startHour: draft.startHour,
    endHour: draft.endHour,
    maxActiveDownloads: active ? Math.trunc(Number(active)) : null,
    maxDownloadRate: toRate(draft.maxDownloadMbps),
    maxUploadRate: toRate(draft.maxUploadMbps),
  };
}

/** Null when the rule can be saved, otherwise what to fix. */
export function validateDraft(draft: DownloadWindowDraft): string | null {
  if (!draft.days.length) return "pick at least one day";
  if (draft.startHour < 0 || draft.startHour > 23 || draft.endHour < 1 || draft.endHour > 24)
    return "pick a start and end hour";
  if (draft.startHour === draft.endHour) return "start and end must differ";
  const active = draft.maxActiveDownloads.trim();
  if (active) {
    const n = Number(active);
    if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_ACTIVE)
      return `downloads at once must be a whole number from 1 to ${MAX_WINDOW_ACTIVE}`;
  }
  if (Number.isNaN(toRate(draft.maxDownloadMbps) ?? 0))
    return "download speed must be a positive number of MB/s";
  if (Number.isNaN(toRate(draft.maxUploadMbps) ?? 0))
    return "upload speed must be a positive number of MB/s";
  return null;
}

function dayRange(days: number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "Every day";
  const weekdays = [1, 2, 3, 4, 5];
  if (set.size === 5 && weekdays.every((d) => set.has(d))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  return DAY_LABELS.filter((d) => set.has(d.value))
    .map((d) => d.short)
    .join(", ");
}

/** "Weekdays 01:00–07:00 · 2 at once · 5 MB/s down" */
export function describeWindow(draft: DownloadWindowDraft): string {
  const allDay = draft.startHour === 0 && draft.endHour === 24;
  const hours = allDay
    ? "all day"
    : `${formatHour(draft.startHour)}–${formatHour(draft.endHour)}${
        draft.endHour <= draft.startHour ? " (next day)" : ""
      }`;
  const parts = [`${dayRange(draft.days)} ${hours}`];
  if (draft.maxActiveDownloads.trim()) parts.push(`${draft.maxActiveDownloads.trim()} at once`);
  if (draft.maxDownloadMbps.trim()) parts.push(`${draft.maxDownloadMbps.trim()} MB/s down`);
  if (draft.maxUploadMbps.trim()) parts.push(`${draft.maxUploadMbps.trim()} MB/s up`);
  return parts.join(" · ");
}
