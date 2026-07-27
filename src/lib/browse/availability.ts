/**
 * Availability resolver — the central concept of the browse experience.
 *
 * Every playable thing resolves to one of five states: ready, warm, fetchable,
 * unavailable, unknown. This is **derived state** — computed from the
 * EngineTorrent table and the search layer, never stored.
 *
 * The product rule: never render a Play button that will not play — and its
 * inverse: never hide a button for content the user already has.
 *
 * `unavailable` is a **claim** that we checked and found nothing viable.
 * `unknown` means the expensive check (indexer search cache) had no data, so
 * we cannot make that claim. The UI renders a neutral affordance for `unknown`.
 */
import prisma from "@/lib/prisma";
import { isViable } from "@/lib/torrents/quality";
import { parseEpisode } from "@/lib/torrents/episodes";
import { normalizeTitle } from "@/lib/utils";
import {
  getBuiltinTorrentPresenceForAvailability,
  type BuiltinTorrentPresence,
} from "@/lib/clients/builtin-engine";
import type { SearchResponse } from "@/lib/torrents/types";
import type { Availability } from "./types";

// ---------------------------------------------------------------------------
// In-memory short-lived cache for availability — avoids redundant DB hits
// when the home page resolves many items in one request.
// ---------------------------------------------------------------------------

interface CacheEntry {
  expires: number;
  value: Availability;
}

const memoryCache = new Map<string, CacheEntry>();
const MEMORY_TTL_MS = 30_000; // 30 seconds

function getCached(key: string): Availability | null {
  const entry = memoryCache.get(key);
  if (!entry || entry.expires < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key: string, value: Availability): void {
  if (value.state === null) return;
  memoryCache.set(key, { expires: Date.now() + MEMORY_TTL_MS, value });
}

/** Evict expired entries periodically to prevent unbounded growth. */
function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of memoryCache) {
    if (entry.expires < now) memoryCache.delete(key);
  }
}

// Prune every 60s (only while the process is alive)
if (typeof setInterval !== "undefined") {
  setInterval(pruneCache, 60_000).unref?.();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AvailabilityQuery {
  /** Title to search for (used as the search query when no local torrent). */
  title: string;
  /** Season number — narrows matching to the specific episode / pack. */
  season?: number | null;
  /** Episode number — narrows matching to the specific episode. */
  episode?: number | null;
  /** Media type for search context. */
  mediaType?: string | null;
}

/**
 * Resolve availability for a single title/episode (full: local + search cache).
 */
export async function resolveAvailability(
  userId: string,
  query: AvailabilityQuery,
): Promise<Availability> {
  const cacheKey = availCacheKey(userId, query);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const torrents = await prisma.engineTorrent.findMany({
    where: { userId },
    select: { hash: true, name: true, progress: true, status: true },
  });

  const result = await computeAvailabilityWithTorrents(
    userId,
    query,
    torrents,
  );
  setCached(cacheKey, result);
  return result;
}

/**
 * Resolve availability for a batch of titles in one pass (full: local + search
 * cache).
 *
 * Fetches all user torrents once and batches search-cache lookups into a single
 * `findMany` to avoid N+1 queries on both tables.
 */
export async function resolveAvailabilityBatch(
  userId: string,
  queries: AvailabilityQuery[],
): Promise<Availability[]> {
  if (queries.length === 0) return [];

  // Single DB query for all user torrents
  const allTorrents = await prisma.engineTorrent.findMany({
    where: { userId },
    select: { hash: true, name: true, progress: true, status: true },
  });

  // Resolve local state first; collect queries that need the search cache
  const localResults: (Availability | null)[] = queries.map((q) => {
    const cacheKey = availCacheKey(userId, q);
    const cached = getCached(cacheKey);
    if (cached) return cached;
    return resolveLocalOnly(q, allTorrents, readyPresenceForUser(userId));
  });

  // Identify which queries still need the search-cache check (got null above,
  // meaning no local torrent found).
  const needSearchIdx: number[] = [];
  const searchTitles: string[] = [];
  for (let i = 0; i < queries.length; i++) {
    if (localResults[i] === null) {
      needSearchIdx.push(i);
      searchTitles.push(queries[i].title);
    }
  }

  // Batch-fetch all needed search-cache rows in one query
  const searchCacheMap = await batchGetSearchByTitle(searchTitles);

  // Resolve the remaining items
  const results: Availability[] = [];
  for (let i = 0; i < queries.length; i++) {
    if (localResults[i] !== null) {
      const result = localResults[i]!;
      setCached(availCacheKey(userId, queries[i]), result);
      results.push(result);
      continue;
    }

    const cached = searchCacheMap.get(normalizeTitle(queries[i].title)) ?? null;
    const result = resolveFromSearchCache(queries[i], cached);
    setCached(availCacheKey(userId, queries[i]), result);
    results.push(result);
  }

  return results;
}

/**
 * Cheap local-only availability for a batch (ready / warm / unknown).
 *
 * Resolves `ready` and `warm` from the EngineTorrent table — one indexed
 * query for the whole batch. Does **not** check the search cache, so anything
 * without a local torrent comes back as `unknown` rather than making a false
 * `unavailable` claim. Use this when the indexer-search cost is not justified
 * (e.g. the My Library rail, where showing ready/warm is the main value).
 */
export async function resolveLocalAvailabilityBatch(
  userId: string,
  queries: AvailabilityQuery[],
): Promise<Availability[]> {
  if (queries.length === 0) return [];

  const allTorrents = await prisma.engineTorrent.findMany({
    where: { userId },
    select: { hash: true, name: true, progress: true, status: true },
  });

  return queries.map((q) => {
    const local = resolveLocalOnly(q, allTorrents, readyPresenceForUser(userId));
    // null means no local torrent — report unknown, NOT unavailable
    return local ?? { state: null };
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Key for the 30-second availability memo.
 *
 * `userId` is part of the key because the value is not: `ready` and `warm` are
 * read from that user's own `EngineTorrent` rows, so a key without the user
 * would hand one account's download state to another for half a minute. The
 * app normally runs single-user on loopback, which is exactly why this would
 * never have been noticed — and exactly why it is not worth leaving.
 */
function availCacheKey(userId: string, q: AvailabilityQuery): string {
  return `avail:${userId}:${normalizeTitle(q.title)}:S${q.season ?? "X"}E${q.episode ?? "X"}`;
}

interface TorrentRow {
  hash: string;
  name: string;
  progress: number;
  status: string;
}

type ReadyTorrentPresence = BuiltinTorrentPresence;
type ReadyPresenceLookup = (hash: string) => ReadyTorrentPresence;

function readyPresenceForUser(userId: string): ReadyPresenceLookup {
  return (hash) => getBuiltinTorrentPresenceForAvailability(userId, hash);
}

/**
 * Match a torrent name against a query. A torrent satisfies a query when:
 * - Its normalized name contains the normalized title, AND
 * - If season/episode are specified, the torrent's parsed episode matches
 *   (or the torrent is a season pack covering the requested episode).
 */
function torrentMatchesQuery(
  torrent: TorrentRow,
  query: AvailabilityQuery,
): boolean {
  const normalizedName = normalizeTitle(torrent.name);
  const normalizedTitle = normalizeTitle(query.title);

  if (!normalizedName.includes(normalizedTitle)) return false;

  // If no season/episode constraint, title match is sufficient
  if (query.season == null && query.episode == null) return true;

  const parsed = parseEpisode(torrent.name);

  // Season pack satisfies any episode request within that season
  if (parsed.isSeasonPack && parsed.season != null) {
    if (query.season != null && parsed.season === query.season) return true;
    // Multi-season pack covers a range
    if (parsed.isMultiSeason && query.season != null) {
      return query.season >= parsed.season;
    }
  }

  // Exact episode match
  if (query.season != null && query.episode != null) {
    return parsed.season === query.season && parsed.episode === query.episode;
  }
  if (query.season != null) {
    return parsed.season === query.season;
  }
  if (query.episode != null) {
    return parsed.episode === query.episode;
  }

  return true;
}

/**
 * Resolve local (EngineTorrent) availability only. Returns `null` when no
 * matching local torrent exists — the caller decides whether that means
 * `unknown` (cheap path) or needs the search cache (full path).
 */
function resolveLocalOnly(
  query: AvailabilityQuery,
  torrents: TorrentRow[],
  readyPresence: ReadyPresenceLookup,
): Availability | null {
  const matching = torrents.filter((t) => torrentMatchesQuery(t, query));

  const readyCandidates = matching.filter(
    (t) => t.progress === 1 && t.status !== "removed",
  );
  let sawUnknownReady = false;
  let sawAbsentReady = false;
  for (const ready of readyCandidates) {
    const presence = readyPresence(ready.hash);
    if (presence === "present") {
      return { state: "ready", infoHash: ready.hash };
    }
    if (presence === "unknown") sawUnknownReady = true;
    if (presence === "absent") sawAbsentReady = true;
  }

  if (sawUnknownReady) return { state: null };

  const warm = matching.find(
    (t) =>
      t.progress > 0 &&
      t.progress < 1 &&
      t.status !== "removed" &&
      t.status !== "error",
  );
  if (warm) {
    return { state: "warm", infoHash: warm.hash, progress: warm.progress };
  }

  if (sawAbsentReady) {
    // A completed DB row proves the user acquired this once, but a rehydrated
    // engine without the hash cannot serve bytes now. `fetchable` is the honest
    // downgrade: try to recover/re-get it, without falsely claiming it is gone.
    return { state: "fetchable" };
  }

  return null;
}

/**
 * Full availability with search cache. Called for the single-resolve path and
 * for batch items that had no local torrent.
 */
async function computeAvailabilityWithTorrents(
  userId: string,
  query: AvailabilityQuery,
  torrents: TorrentRow[],
): Promise<Availability> {
  const local = resolveLocalOnly(query, torrents, readyPresenceForUser(userId));
  if (local) return local;

  // No local torrent — check the search cache
  const cached = await getSingleSearchByTitle(query.title);
  return resolveFromSearchCache(query, cached);
}

/**
 * Given (possibly null) cached search results, determine fetchable / unavailable / unknown.
 */
function resolveFromSearchCache(
  query: AvailabilityQuery,
  cached: SearchResponse | null,
): Availability {
  // No cached search at all — we cannot claim unavailable
  if (!cached) return { state: null };

  if (hasViableMatch(cached, query)) {
    return { state: "fetchable" };
  }

  // We checked and found nothing viable — this IS a real unavailable claim
  return { state: "unavailable" };
}

// ---------------------------------------------------------------------------
// Search-cache access (single + batched)
// ---------------------------------------------------------------------------

/**
 * Look up cached searches by **normalized query title**, not by `cacheKey`.
 *
 * `cacheKey` is a sha256 over the complete search option set — category,
 * limit, sources, filters and the user's target resolution. Availability used
 * to rebuild that hash from the outside using guessed values
 * (`limit: "default"`, `filters: {}`, no `target`), which could never collide
 * with what `searchTorrents` actually wrote. The result was a lookup that
 * missed 100% of the time: `fetchable` and `unavailable` were unreachable
 * states, every browse render paid a DB round trip for a guaranteed miss, and
 * because a miss degrades to the *neutral* `{ state: null }` affordance the
 * page looked entirely correct. Nothing failed loudly, and no test caught it
 * because the tests call `resolveFromSearchCache` directly and bypass the seam.
 *
 * Keying on the query is stable under all of that: it does not care which
 * caller ran the search or with which options, and adding a new option to the
 * hash (as `target` once was) cannot silently break it again.
 */
const searchMemory = new Map<string, { expires: number; value: SearchResponse }>();

/** Parse a row into the memo + result map. Returns false on corrupt JSON. */
function absorbRow(
  row: { normalizedQuery: string | null; payload: string; expiresAt: Date },
  into: Map<string, SearchResponse>,
): void {
  const q = row.normalizedQuery;
  // First row per title wins; callers order by freshest first.
  if (!q || into.has(q)) return;
  try {
    const value = JSON.parse(row.payload) as SearchResponse;
    searchMemory.set(q, { expires: row.expiresAt.getTime(), value });
    into.set(q, value);
  } catch {
    // Corrupt JSON — skip
  }
}

async function getSingleSearchByTitle(
  title: string,
): Promise<SearchResponse | null> {
  const key = normalizeTitle(title);
  if (!key) return null;

  const mem = searchMemory.get(key);
  if (mem && mem.expires > Date.now()) return mem.value;

  try {
    // Accept stale rows — a stale answer is more useful than `unknown`.
    const row = await prisma.searchCache.findFirst({
      where: { normalizedQuery: key },
      orderBy: { expiresAt: "desc" },
    });
    if (!row) return null;
    const out = new Map<string, SearchResponse>();
    absorbRow(row, out);
    return out.get(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Batch-fetch cached searches for many titles. One `findMany` instead of N
 * queries. Returns a Map keyed by normalized title.
 */
async function batchGetSearchByTitle(
  titles: string[],
): Promise<Map<string, SearchResponse>> {
  const result = new Map<string, SearchResponse>();
  if (titles.length === 0) return result;

  // De-duplicate and check in-memory first
  const needed: string[] = [];
  const unique = [...new Set(titles.map((t) => normalizeTitle(t)))].filter(
    Boolean,
  );
  for (const key of unique) {
    const mem = searchMemory.get(key);
    if (mem && mem.expires > Date.now()) {
      result.set(key, mem.value);
    } else {
      needed.push(key);
    }
  }

  if (needed.length === 0) return result;

  try {
    const rows = await prisma.searchCache.findMany({
      where: { normalizedQuery: { in: needed } },
      orderBy: { expiresAt: "desc" },
    });
    for (const row of rows) absorbRow(row, result);
  } catch {
    // DB error — return what we have from memory
  }

  return result;
}

// ---------------------------------------------------------------------------
// Viable-match scanner
// ---------------------------------------------------------------------------

/**
 * Scan cached search results for a viable release matching the query.
 */
function hasViableMatch(
  response: SearchResponse,
  query: AvailabilityQuery,
): boolean {
  const normalizedTitle = normalizeTitle(query.title);

  for (const r of response.results) {
    if (!normalizeTitle(r.title).includes(normalizedTitle)) continue;
    if (!isViable(r)) continue;

    if (query.season != null || query.episode != null) {
      const parsed = r.episode ?? parseEpisode(r.title);

      if (parsed.isSeasonPack && parsed.season != null) {
        if (query.season != null && parsed.season === query.season) return true;
        continue;
      }

      if (query.season != null && parsed.season !== query.season) continue;
      if (query.episode != null && parsed.episode !== query.episode) continue;
    }

    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  torrentMatchesQuery as _torrentMatchesQuery,
  hasViableMatch as _hasViableMatch,
  resolveLocalOnly as _resolveLocalOnly,
  resolveFromSearchCache as _resolveFromSearchCache,
  type ReadyTorrentPresence as _ReadyTorrentPresence,
  type TorrentRow as _TorrentRow,
};
