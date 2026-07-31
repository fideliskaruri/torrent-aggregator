/**
 * Persistent, stale-while-revalidate cache for discovery-rail home releases.
 *
 * Rails read one local batch and never wait on TMDB per card. Missing entries
 * are refreshed behind the response and stored in SearchCache under a private
 * key namespace. `normalizedQuery` stays null, so these rows can never be
 * mistaken for an indexer search by availability.ts.
 */
import prisma from "@/lib/prisma";
import { resolveTmdbRef } from "@/lib/metadata/artwork";
import { fetchTmdbDetail } from "@/lib/metadata/tmdb";
import type { CatalogRow } from "@/lib/catalog/store";
import {
  classifyHomeReleaseEvidence,
  type HomeReleaseSignal,
  type TmdbCountryRelease,
} from "./home-release";

const CACHE_PREFIX = "browse:home-release:";
const PAYLOAD_KIND = "browse-home-release";
const PAYLOAD_VERSION = 2;
const CHECKED_TTL_MS = 6 * 60 * 60 * 1000;
const UNKNOWN_TTL_MS = 15 * 60 * 1000;
const CONCURRENCY = 4;

type Candidate = Pick<
  CatalogRow,
  "workKey" | "title" | "year" | "mediaType" | "releaseDate"
>;

interface CachePayload {
  kind: typeof PAYLOAD_KIND;
  version: typeof PAYLOAD_VERSION;
  signal: HomeReleaseSignal;
}

const memory = new Map<
  string,
  { expiresAt: number; signal: HomeReleaseSignal }
>();
const pending = new Set<string>();

function cacheKey(workKey: string): string {
  return `${CACHE_PREFIX}${workKey}`;
}

function isMovie(row: Candidate): boolean {
  return ["movie", "movies", "film", "feature"].includes(
    row.mediaType.trim().toLowerCase(),
  );
}

function isPastOrToday(date: Date | null, now: Date): boolean {
  return date !== null && date.getTime() <= now.getTime();
}

function candidates(rows: readonly Candidate[], now: Date): Candidate[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (
      !row.workKey ||
      seen.has(row.workKey) ||
      !isMovie(row) ||
      !isPastOrToday(row.releaseDate, now)
    ) {
      return false;
    }
    seen.add(row.workKey);
    return true;
  });
}

function isIsoDayOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function decode(payload: string): HomeReleaseSignal | null {
  try {
    const parsed = JSON.parse(payload) as Partial<CachePayload>;
    const signal = parsed.signal;
    if (
      parsed.kind !== PAYLOAD_KIND ||
      parsed.version !== PAYLOAD_VERSION ||
      !signal ||
      typeof signal.checked !== "boolean" ||
      !isIsoDayOrNull(signal.theatricalReleasedAt) ||
      !isIsoDayOrNull(signal.releasedAt) ||
      !isIsoDayOrNull(signal.nextHomeReleaseAt)
    ) {
      return null;
    }
    return {
      checked: signal.checked,
      theatricalReleasedAt: signal.theatricalReleasedAt,
      releasedAt: signal.releasedAt,
      nextHomeReleaseAt: signal.nextHomeReleaseAt,
    };
  } catch {
    return null;
  }
}

/**
 * One local read for a set of rail rows. Database failure is unknown, not a
 * reason to gate.
 */
export async function readHomeReleaseSignals(
  rows: readonly Candidate[],
  now: Date = new Date(),
): Promise<Map<string, HomeReleaseSignal>> {
  const out = new Map<string, HomeReleaseSignal>();
  const wanted = candidates(rows, now);
  const needed: Candidate[] = [];

  for (const row of wanted) {
    const hit = memory.get(row.workKey);
    if (hit && hit.expiresAt > now.getTime()) {
      out.set(row.workKey, hit.signal);
    } else {
      memory.delete(row.workKey);
      needed.push(row);
    }
  }
  if (needed.length === 0) return out;

  try {
    const rowsFromCache = await prisma.searchCache.findMany({
      where: {
        cacheKey: { in: needed.map((row) => cacheKey(row.workKey)) },
        expiresAt: { gt: now },
      },
      select: { cacheKey: true, payload: true, expiresAt: true },
    });
    for (const row of rowsFromCache) {
      if (!row.cacheKey.startsWith(CACHE_PREFIX)) continue;
      const workKey = row.cacheKey.slice(CACHE_PREFIX.length);
      const signal = decode(row.payload);
      if (!workKey || !signal) continue;
      out.set(workKey, signal);
      memory.set(workKey, {
        expiresAt: row.expiresAt.getTime(),
        signal,
      });
    }
  } catch {
    // A cache miss and a cache outage are both unknown on the read path.
  }

  return out;
}

/**
 * Refresh uncached movie rows after the current payload has enough information
 * to render. This function deliberately returns immediately.
 */
export function scheduleHomeReleaseRefresh(
  rows: readonly Candidate[],
  known: ReadonlyMap<string, HomeReleaseSignal>,
  now: Date = new Date(),
): void {
  const work = candidates(rows, now).filter(
    (row) => !known.has(row.workKey) && !pending.has(row.workKey),
  );
  for (const row of work) pending.add(row.workKey);

  void mapBounded(work, CONCURRENCY, async (row) => {
    try {
      const signal = await fetchSignal(row, now);
      await writeSignal(row.workKey, signal, now);
    } finally {
      pending.delete(row.workKey);
    }
  });
}

async function fetchSignal(
  row: Candidate,
  now: Date,
): Promise<HomeReleaseSignal> {
  const unknown: HomeReleaseSignal = {
    checked: false,
    theatricalReleasedAt: null,
    releasedAt: null,
    nextHomeReleaseAt: null,
  };
  try {
    const ref = await resolveTmdbRef({
      title: row.title,
      year: row.year,
      mediaType: "movie",
    });
    if (!ref || ref.mediaType !== "movie") return unknown;

    const detail = await fetchTmdbDetail("movie", ref.id, { timeoutMs: 4_000 });
    if (!detail) return unknown;
    const results = detail.release_dates?.results as
      | TmdbCountryRelease[]
      | undefined;
    return classifyHomeReleaseEvidence(results, now);
  } catch {
    return unknown;
  }
}

async function writeSignal(
  workKey: string,
  signal: HomeReleaseSignal,
  now: Date,
): Promise<void> {
  const ttl = signal.checked ? CHECKED_TTL_MS : UNKNOWN_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);
  const payload: CachePayload = {
    kind: PAYLOAD_KIND,
    version: PAYLOAD_VERSION,
    signal,
  };

  memory.set(workKey, { expiresAt: expiresAt.getTime(), signal });
  try {
    await prisma.searchCache.upsert({
      where: { cacheKey: cacheKey(workKey) },
      create: {
        cacheKey: cacheKey(workKey),
        normalizedQuery: null,
        payload: JSON.stringify(payload),
        expiresAt,
      },
      update: {
        normalizedQuery: null,
        payload: JSON.stringify(payload),
        expiresAt,
      },
    });
  } catch {
    // Memory still prevents a provider request on every render this process.
  }
}

async function mapBounded<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      worker,
    ),
  );
}
