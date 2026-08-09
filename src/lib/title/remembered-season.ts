/**
 * Durable per-title manual season memory.
 *
 * The bug this answers: pick Rick and Morty Season 2, leave through an
 * ordinary app link (not Back), come back — the title page reset to whatever
 * the watch cursor or provider default happened to be, which for a
 * long-running show can be a season far past what was actually being watched.
 * React state alone never survives leaving through a fresh title link.
 *
 * This is deliberately **not** the resume/watch cursor. Those describe actual
 * playback progress and must keep outranking a manual pick that has gone
 * stale; this only remembers "last season the user *looked at* on this
 * title", so it can outrank a stale watch cursor / provider default without
 * ever masquerading as progress.
 *
 * One cookie holds a bounded map of every title's remembered season —
 * `{ [workKey]: season }` — rather than one cookie per title, which would
 * grow without bound across a library. The map itself is capped at
 * {@link MAX_ENTRIES} titles and the serialized cookie at
 * {@link MAX_COOKIE_VALUE_LENGTH} characters; both are enforced by evicting
 * the oldest remembered entries first, so a large library can never grow the
 * cookie past what a browser will store (~4KB per cookie).
 *
 * Pure and isomorphic: no `document`, no `next/headers`. Client code reads
 * `document.cookie` and server code reads the request's `Cookie` header —
 * both hand the raw string to {@link parseRememberedSeasonMap} /
 * {@link readRememberedSeason}, and both write back through
 * {@link nextRememberedSeasonCookieValue}.
 */

export const REMEMBERED_SEASON_COOKIE_NAME = "tf_season";

/** Titles remembered at once. Oldest entries are evicted first past this. */
export const MAX_ENTRIES = 100;

/**
 * Serialized cookie value ceiling, in characters.
 *
 * Browsers cap a cookie (name + value) around 4096 bytes; this leaves
 * headroom for the cookie name, attributes and multi-byte workKeys.
 */
export const MAX_COOKIE_VALUE_LENGTH = 3500;

/** A season must be a positive integer; anything else is not a season. */
const MIN_SEASON = 1;
/** Generous ceiling — well past any real show — that only rejects garbage. */
const MAX_SEASON = 9999;

export type RememberedSeasonMap = Record<string, number>;

function normalizeWorkKey(workKey: string): string {
  return workKey.trim().toLowerCase();
}

/** Is `value` a season number worth remembering? */
export function isValidSeason(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_SEASON &&
    value <= MAX_SEASON
  );
}

/**
 * Parses the raw `tf_season` cookie value into a workKey → season map.
 *
 * Never throws: a missing, truncated, foreign-format or malformed cookie
 * (an old format, a value edited by hand, a value from a future version)
 * simply parses to `{}`, which falls through to the rest of the precedence
 * chain rather than breaking the page.
 */
export function parseRememberedSeasonMap(
  raw: string | null | undefined,
): RememberedSeasonMap {
  if (!raw) return {};
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return {};
  }
  if (
    parsed == null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return {};
  }

  const out: RememberedSeasonMap = {};
  let count = 0;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (count >= MAX_ENTRIES) break;
    const workKey = normalizeWorkKey(String(key));
    if (!workKey || !isValidSeason(value)) continue;
    out[workKey] = value;
    count += 1;
  }
  return out;
}

/** The remembered season for one title, or `null` when none is stored. */
export function readRememberedSeason(
  raw: string | null | undefined,
  workKey: string,
): number | null {
  const map = parseRememberedSeasonMap(raw);
  return map[normalizeWorkKey(workKey)] ?? null;
}

/**
 * Bounds a map to {@link MAX_ENTRIES} entries and a serialized size under
 * {@link MAX_COOKIE_VALUE_LENGTH}, evicting the oldest entries (the ones
 * `Object.entries` yields first — insertion order) until both hold.
 */
function boundMap(map: RememberedSeasonMap): string {
  let entries = Object.entries(map);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }
  let serialized = encodeURIComponent(JSON.stringify(Object.fromEntries(entries)));
  while (serialized.length > MAX_COOKIE_VALUE_LENGTH && entries.length > 1) {
    entries = entries.slice(1);
    serialized = encodeURIComponent(JSON.stringify(Object.fromEntries(entries)));
  }
  // A single entry that still overflows the cap (a pathologically long
  // workKey) is dropped rather than shipped truncated and unparseable.
  if (serialized.length > MAX_COOKIE_VALUE_LENGTH) return "";
  return serialized;
}

/**
 * The next cookie value after remembering `season` for `workKey`.
 *
 * Returns `null` (write nothing) when `season` fails validation — an invalid
 * manual selection must never overwrite a previously-remembered good one.
 * Re-inserts the key at the end of iteration order so the just-picked title
 * is the last evicted under the entry cap (a simple recency policy without
 * tracking timestamps).
 */
export function nextRememberedSeasonCookieValue(
  currentRaw: string | null | undefined,
  workKey: string,
  season: number,
): string | null {
  const key = normalizeWorkKey(workKey);
  if (!key || !isValidSeason(season)) return null;

  const map = parseRememberedSeasonMap(currentRaw);
  delete map[key];
  map[key] = season;
  return boundMap(map);
}
