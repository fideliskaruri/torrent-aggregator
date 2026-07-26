import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import type { SearchResponse } from "./types";

const memory = new Map<string, { expires: number; value: SearchResponse }>();
const DEFAULT_TTL_MS = 1000 * 60 * 3; // 3 minutes
const RATE_WINDOW_MS = 1000 * 60;
const RATE_MAX = 40;

const rateBuckets = new Map<string, { count: number; reset: number }>();

/**
 * Budget for **outbound indexer fetches**, not for user requests.
 *
 * This app binds to 127.0.0.1 with no auth, so throttling the user protects
 * nobody — there is no adversary on the other end of the socket. What genuinely
 * needs protecting is the public indexers, which ban IPs that hammer them.
 *
 * Counting HTTP requests to `/api/search` measured the wrong thing entirely: a
 * cache hit contacts no indexer at all, yet still burned budget, so paging
 * through results or nudging a filter could lock the user out of his own app
 * for a minute with nothing to show for it. The budget is therefore spent at
 * the point of the actual upstream fan-out.
 */
export function rateLimit(key: string, max = RATE_MAX): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.reset < now) {
    rateBuckets.set(key, { count: 1, reset: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

/** Seconds until `key`'s budget refills, for an actionable error message. */
export function rateLimitResetSeconds(key: string): number {
  const bucket = rateBuckets.get(key);
  if (!bucket) return 0;
  return Math.max(0, Math.ceil((bucket.reset - Date.now()) / 1000));
}

/**
 * Stable cache key. Nested objects (filters) must be fully included —
 * JSON.stringify(obj, Object.keys(obj)) only keeps those keys at *every*
 * depth, so nested filter fields (resolution, minSeeders, …) became `{}`
 * and every filter combo shared one unfiltered cache entry.
 */
export function cacheKeyFrom(parts: Record<string, unknown>): string {
  const raw = JSON.stringify(sortKeysDeep(parts));
  return createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeysDeep(obj[key]);
  }
  return out;
}

export async function getSearchCache(
  key: string,
  opts: { allowStale?: boolean } = {},
): Promise<SearchResponse | null> {
  const mem = memory.get(key);
  if (mem && (opts.allowStale || mem.expires > Date.now())) return mem.value;

  try {
    const row = await prisma.searchCache.findUnique({ where: { cacheKey: key } });
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      // A stale entry is worth far more than an error when we are being
      // throttled — the alternative is showing the user nothing at all.
      if (opts.allowStale) return JSON.parse(row.payload) as SearchResponse;
      void prisma.searchCache.delete({ where: { cacheKey: key } }).catch(() => undefined);
      return null;
    }
    const value = JSON.parse(row.payload) as SearchResponse;
    memory.set(key, { expires: row.expiresAt.getTime(), value });
    return value;
  } catch {
    return null;
  }
}

export async function setSearchCache(
  key: string,
  value: SearchResponse,
  ttlMs = DEFAULT_TTL_MS,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  memory.set(key, { expires: expiresAt.getTime(), value });
  try {
    await prisma.searchCache.upsert({
      where: { cacheKey: key },
      create: {
        cacheKey: key,
        payload: JSON.stringify(value),
        expiresAt,
      },
      update: {
        payload: JSON.stringify(value),
        expiresAt,
      },
    });
  } catch {
    // ignore
  }
}
