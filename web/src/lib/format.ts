/**
 * One owner for every human-readable number and date the web UI prints.
 *
 * Call sites used to disagree on base (1024 vs 1000), idle speed, ETA spacing,
 * and whether a date was hydration-safe. Everything below is the contract:
 * binary bytes, null when idle/unknown, fixed English month names for calendar
 * dates so SSR and the browser never disagree.
 *
 * Invalid or unknown values return null so callers omit the field. Do not print
 * em dashes or en dashes in UI copy.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Format byte sizes for UI display (binary 1024). Null when unknown/invalid. */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || Number.isNaN(bytes) || bytes < 0) return null;
  if (bytes === 0) return "0 B";
  // Math.floor(log(0.8)/log(1024)) is -1, which would index past the start of
  // `units` and scale the value *up* ("819 undefined"). Sub-byte values are
  // routine: WebTorrent speeds are decaying averages that idle below 1 B/s.
  const i = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1),
  );
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
}

/**
 * Human download/upload speed, or null when nothing is moving.
 * Idle callers omit the chip rather than printing "0 B/s".
 */
export function formatSpeed(bytesPerSec: number | null | undefined): string | null {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return null;
  }
  const size = formatBytes(bytesPerSec);
  return size ? `${size}/s` : null;
}

/** Elapsed/remaining time as a compact duration: "45s", "12m", "6d 16h". */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const units: [label: string, size: number][] = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ];
  // Two units is the sweet spot: "6d 16h" is readable, "6d 16h 40m" is noise,
  // and a bare "9609m" (which is what a torrent ETA actually looks like) is
  // unreadable. Slow swarms routinely produce week-long estimates.
  const parts: string[] = [];
  let rest = Math.round(seconds);
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n === 0) continue;
    parts.push(`${n}${label}`);
    if (parts.length === 2) break;
  }
  return parts.length > 0 ? parts.join(" ") : "0s";
}

/**
 * ETA chip text. Returns null when there is no positive estimate.
 *
 * `prefix` is the leading glue when the ETA sits after another fact on the
 * same line (" · " on downloads rows, empty when it is the only fact).
 */
export function formatEta(
  seconds: number | null | undefined,
  options?: { prefix?: string },
): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const duration = formatDuration(seconds);
  if (!duration) return null;
  return `${options?.prefix ?? ""}ETA ${duration}`;
}

/** Runtime as "42 min", or null when unknown/non-positive. */
export function formatRuntimeMinutes(
  minutes: number | null | undefined,
): string | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return `${Math.round(minutes)} min`;
}

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export type FormatWhenStyle = "relative" | "short" | "air";

function parseCalendarDate(
  input: Date | string | null | undefined,
): { year: number; month: number; day: number; date: Date } | null {
  if (input == null || input === "") return null;

  if (typeof input === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      // Local midnight so relative diffs stay in the user's day, not UTC.
      const date = new Date(year, month - 1, day);
      if (Number.isNaN(date.getTime())) return null;
      return { year, month, day, date };
    }
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) return null;
    return {
      year: parsed.getFullYear(),
      month: parsed.getMonth() + 1,
      day: parsed.getDate(),
      date: parsed,
    };
  }

  if (Number.isNaN(input.getTime())) return null;
  return {
    year: input.getFullYear(),
    month: input.getMonth() + 1,
    day: input.getDate(),
    date: input,
  };
}

function formatRelative(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 30) return `${days}d ago`;
  // Fall through to a fixed short calendar string (hydration-safe).
  return formatShortCalendar(date.getFullYear(), date.getMonth() + 1, date.getDate(), now);
}

function formatShortCalendar(
  year: number,
  month: number,
  day: number,
  now?: Date,
): string {
  const monthName = MONTHS_SHORT[month - 1];
  const includeYear = now == null || year !== now.getFullYear();
  return includeYear
    ? `${monthName} ${day}, ${year}`
    : `${monthName} ${day}`;
}

function formatAirCalendar(year: number, month: number, day: number): string {
  return `${day} ${MONTHS_SHORT[month - 1]} ${year}`;
}

function formatLongCalendar(year: number, month: number, day: number): string {
  return `${MONTHS_LONG[month - 1]} ${day}, ${year}`;
}

/**
 * One date formatter for relative chips, short day headers, and air/release
 * dates. Calendar styles use fixed English month names so SSR and the client
 * never disagree.
 *
 * - `relative`: "2h ago", then a short calendar date past ~30 days
 * - `short`: "May 4, 2023" (long month) for title release dates
 * - `air`: "12 Mar 2026" (day-first short month) for episode air dates
 *
 * Returns null for missing/invalid input (callers omit the row).
 */
export function formatWhen(
  input: Date | string | null | undefined,
  options?: { style?: FormatWhenStyle; now?: Date },
): string | null {
  const style = options?.style ?? "relative";
  const now = options?.now ?? new Date();

  if (style === "relative") {
    if (input == null || input === "") return null;
    const date =
      typeof input === "string"
        ? new Date(input)
        : input;
    if (Number.isNaN(date.getTime())) return null;
    return formatRelative(date, now);
  }

  const parts = parseCalendarDate(input);
  if (!parts) return null;

  if (style === "air") {
    return formatAirCalendar(parts.year, parts.month, parts.day);
  }

  // short: long month, US-ish order used on the title hero.
  return formatLongCalendar(parts.year, parts.month, parts.day);
}

/**
 * Compact day-group label for activity/notification feeds.
 * "Today" / "Yesterday" / "Mar 12" / "Mar 12, 2025". Hydration-safe.
 */
export function formatDayGroupLabel(
  input: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  const parts = parseCalendarDate(input);
  if (!parts) return "Earlier";

  const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth() + 1}-${yesterday.getDate()}`;
  const key = `${parts.year}-${parts.month}-${parts.day}`;

  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  return formatShortCalendar(parts.year, parts.month, parts.day, now);
}
