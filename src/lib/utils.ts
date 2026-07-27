import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format byte sizes for UI display */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  // Math.floor(log(0.8)/log(1024)) is -1, which would index past the start of
  // `units` and scale the value *up* ("819 undefined"). Sub-byte values are
  // routine: WebTorrent speeds are decaying averages that idle below 1 B/s.
  const i = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1),
  );
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Elapsed/remaining time as a compact duration: "45s", "12m", "6d 16h". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
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
    // Skip empty units entirely rather than padding: "1h" beats "1h 0m", and a
    // leading "0d" would waste the two-unit budget.
    if (n === 0) continue;
    parts.push(`${n}${label}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

/** Join short metadata facts with a real, spoken separator. */
export function factsLine(
  parts: readonly (string | null | undefined | false)[],
): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(" · ");
}

/** Relative time like "2h ago" */
export function formatRelativeTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";

  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

/** Normalize titles for fuzzy matching */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\[\](){}【】]/g, " ")
    .replace(/\b(s\d{1,2}e\d{1,3}|ep?\s*\d{1,3}|season\s*\d+)\b/gi, " ")
    .replace(
      /\b(1080p|720p|480p|2160p|4k|hevc|x265|x264|web-?dl|webrip|bluray|bdrip|hdtv|aac|flac|10bit|dual|multi|sub|dub|vostfr|raw)\b/gi,
      " ",
    )
    .replace(/[._\-–—|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse size strings like "1.4 GiB" / "700 MB" into bytes */
export function parseSizeToBytes(input: string | null | undefined): number | null {
  if (!input) return null;
  const match = input.trim().match(/^([\d.,]+)\s*([kmgt]?i?b)$/i);
  if (!match) return null;
  const value = parseFloat(match[1].replace(",", ""));
  if (Number.isNaN(value)) return null;
  const unit = match[2].toLowerCase();
  const map: Record<string, number> = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  return Math.round(value * (map[unit] ?? 1));
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
