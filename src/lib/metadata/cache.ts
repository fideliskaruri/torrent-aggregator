import prisma from "@/lib/prisma";
import { boundedTtlCache } from "@/lib/cache/bounded-ttl-cache";
import type { MediaMetadata } from "@/lib/torrents/types";

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export function metadataCacheKey(
  source: string,
  mediaType: string,
  externalId: string,
): string {
  return `${source}:${mediaType}:${externalId}`;
}

export function queryCacheKey(source: string, query: string): string {
  return `query:${source}:${query.toLowerCase().trim()}`;
}

export async function getCachedMetadata(
  cacheKey: string,
): Promise<MediaMetadata | null> {
  try {
    const row = await prisma.cachedMetadata.findUnique({
      where: { cacheKey },
    });
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      // expired — best-effort delete
      void prisma.cachedMetadata
        .delete({ where: { cacheKey } })
        .catch(() => undefined);
      return null;
    }
    return {
      source: row.source as MediaMetadata["source"],
      mediaType: row.mediaType as MediaMetadata["mediaType"],
      externalId: row.externalId,
      title: row.title,
      posterUrl: row.posterUrl,
      backdropUrl: row.backdropUrl,
      synopsis: row.synopsis,
      rating: row.rating,
      year: row.year,
      releaseDate: row.releaseDate
        ? row.releaseDate.toISOString().slice(0, 10)
        : null,
      genres: row.genres ? (JSON.parse(row.genres) as string[]) : [],
    };
  } catch {
    // DB may not be ready yet during first boot
    return null;
  }
}

export async function setCachedMetadata(
  meta: MediaMetadata,
  ttlMs = DEFAULT_TTL_MS,
): Promise<void> {
  const cacheKey = metadataCacheKey(
    meta.source,
    meta.mediaType,
    meta.externalId,
  );
  const expiresAt = new Date(Date.now() + ttlMs);
  const releaseDate = metadataReleaseDate(meta.releaseDate);

  try {
    await prisma.cachedMetadata.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        source: meta.source,
        mediaType: meta.mediaType,
        externalId: meta.externalId,
        title: meta.title,
        posterUrl: meta.posterUrl ?? null,
        backdropUrl: meta.backdropUrl ?? null,
        synopsis: meta.synopsis ?? null,
        rating: meta.rating ?? null,
        year: meta.year ?? null,
        releaseDate,
        genres: JSON.stringify(meta.genres ?? []),
        rawJson: JSON.stringify(meta),
        expiresAt,
      },
      update: {
        title: meta.title,
        posterUrl: meta.posterUrl ?? null,
        backdropUrl: meta.backdropUrl ?? null,
        synopsis: meta.synopsis ?? null,
        rating: meta.rating ?? null,
        year: meta.year ?? null,
        releaseDate,
        genres: JSON.stringify(meta.genres ?? []),
        rawJson: JSON.stringify(meta),
        expiresAt,
      },
    });
  } catch {
    // ignore cache write failures
  }
}

/**
 * A `MediaMetadata.releaseDate` (ISO date/`YYYY-MM-DD`/`YYYY`) as a UTC `Date`
 * for the `CachedMetadata.releaseDate` column, or null.
 *
 * Anchored at UTC midnight and never fabricated: a missing or malformed value
 * is null, which stays ungated. Year-only strings are already stored as
 * `YYYY-01-01` by the providers, so slicing to the day is enough here.
 */
function metadataReleaseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const dayOnly = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayOnly)) return null;
  const date = new Date(`${dayOnly}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** In-memory short TTL cache for query → best match (per process) */
const memoryQueryCache = boundedTtlCache<MediaMetadata | null>({
  maxEntries: 1000,
  ttlMs: 1000 * 60 * 30,
  pruneIntervalMs: 1000 * 60 * 5,
  name: "metadata:query",
});

export function getMemoryQueryCache(key: string): MediaMetadata | null | undefined {
  return memoryQueryCache.get(key);
}

export function setMemoryQueryCache(
  key: string,
  value: MediaMetadata | null,
  ttlMs = 1000 * 60 * 30,
) {
  memoryQueryCache.set(key, value, ttlMs);
}
