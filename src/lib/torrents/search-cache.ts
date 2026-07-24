import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import type { SearchResponse } from "./types";

const memory = new Map<string, { expires: number; value: SearchResponse }>();
const DEFAULT_TTL_MS = 1000 * 60 * 3; // 3 minutes
const RATE_WINDOW_MS = 1000 * 60;
const RATE_MAX = 40;

const rateBuckets = new Map<string, { count: number; reset: number }>();

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
): Promise<SearchResponse | null> {
  const mem = memory.get(key);
  if (mem && mem.expires > Date.now()) return mem.value;

  try {
    const row = await prisma.searchCache.findUnique({ where: { cacheKey: key } });
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
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
