/**
 * Presentation names for indexers, and plain-English reasons when one fails.
 *
 * Search intentionally degrades rather than failing when a source is down, but
 * that only helps if the user is told. Raw text like `apibay: apibay HTTP 403`
 * leaks an internal id and a transport detail, and stutters the name.
 */
import type { TorrentSourceId } from "./types";

export const SOURCE_LABELS: Record<TorrentSourceId, string> = {
  nyaa: "Nyaa",
  apibay: "The Pirate Bay",
  torrentscsv: "Torrents-CSV",
  eztv: "EZTV",
  yts: "YTS",
  "1337x": "1337x",
};

/** Short form for chips and badges, where the full name will not fit. */
export const SOURCE_SHORT_LABELS: Record<TorrentSourceId, string> = {
  nyaa: "Nyaa",
  apibay: "TPB",
  torrentscsv: "CSV",
  eztv: "EZTV",
  yts: "YTS",
  "1337x": "1337x",
};

export function sourceLabel(id: string): string {
  return SOURCE_LABELS[id as TorrentSourceId] ?? id;
}

export function sourceShortLabel(id: string): string {
  return SOURCE_SHORT_LABELS[id as TorrentSourceId] ?? id;
}

/**
 * Turns a raw fetch/parse error into something a user can act on.
 * Falls back to a generic message rather than surfacing internals.
 */
export function sourceErrorReason(error: string | undefined): string {
  if (!error) return "Unavailable";
  const e = error.toLowerCase();

  if (/\b(403|forbidden)\b/.test(e)) return "Blocked this request";
  if (/\b(429|rate limit)\b/.test(e)) return "Rate limited";
  if (/\b(401|unauthorized)\b/.test(e)) return "Rejected this request";
  if (/\b(404)\b/.test(e)) return "Endpoint not found";
  if (/\b5\d\d\b/.test(e)) return "Having server trouble";
  if (/timeout|timed out|abort/.test(e)) return "Timed out";
  if (/enotfound|dns|getaddrinfo/.test(e)) return "Could not be resolved";
  if (/econnrefused|econnreset|socket|network|fetch failed/.test(e))
    return "Unreachable";
  return "Unavailable";
}

/** "The Pirate Bay is blocked this request" reads badly — build the sentence. */
export function describeSourceFailure(id: string, error?: string): string {
  return `${sourceLabel(id)} — ${sourceErrorReason(error)}`;
}
