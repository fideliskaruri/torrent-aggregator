import prisma from "@/lib/prisma";
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
        genres: JSON.stringify(meta.genres ?? []),
        rawJson: JSON.stringify(meta),
        expiresAt,
      },
    });
  } catch {
    // ignore cache write failures
  }
}

/** In-memory short TTL cache for query → best match (per process) */
const memoryQueryCache = new Map<
  string,
  { expires: number; value: MediaMetadata | null }
>();

export function getMemoryQueryCache(key: string): MediaMetadata | null | undefined {
  const hit = memoryQueryCache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    memoryQueryCache.delete(key);
    return undefined;
  }
  return hit.value;
}

export function setMemoryQueryCache(
  key: string,
  value: MediaMetadata | null,
  ttlMs = 1000 * 60 * 30,
) {
  memoryQueryCache.set(key, { expires: Date.now() + ttlMs, value });
}
