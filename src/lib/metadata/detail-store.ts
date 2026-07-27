/**
 * Second-tier, on-disk cache for work and season detail.
 *
 * ## Why this exists
 *
 * The in-memory tier in `work-detail.ts` is per-process. This is a self-hosted
 * app on somebody's own machine that gets restarted constantly, and every
 * restart used to throw away every synopsis, cast list and episode listing and
 * re-fetch them from TMDB on one shared API key. This tier makes detail
 * survive a restart: memory -> database -> TMDB, write-through on a fetch.
 *
 * ## Why raw SQL rather than a Prisma model
 *
 * `prisma/schema.prisma` is owned exclusively by the repo owner and two agents
 * running `prisma migrate` concurrently corrupts the migration history. The
 * exact model this module wants has been sent for review (see
 * `WORK_DETAIL_CACHE_MODEL` below, which is the literal definition asked for).
 * Until it is applied there is no generated `prisma.workDetailCache` delegate
 * to compile against, so the two statements here are written as raw SQL
 * against exactly the DDL that model produces. The consequence that matters:
 * this file works unchanged the moment the migration lands, and until then it
 * detects the missing table once and degrades to the previous memory-only
 * behaviour rather than throwing on every page.
 *
 * ## Storage decisions
 *
 * - `payload` is JSON, or the literal string `"null"` for a remembered miss.
 *   A miss therefore needs no boolean column, which removes a Prisma/SQLite
 *   type-mapping assumption from the raw path.
 * - `fetchedAt` is written as an ISO-8601 string because that is precisely how
 *   Prisma stores `DateTime` on SQLite (verified against the live
 *   `CachedMetadata.expiresAt` column, which reads back as
 *   `typeof = 'text'`, `"2026-08-02T23:34:05.162Z"`). Reading and writing the
 *   same representation keeps raw rows and Prisma rows interchangeable.
 * - `version` is stored per row. A payload written by an older build is
 *   ignored, not deserialised, so adding a field later cannot resurrect a
 *   half-shaped object into a typed one.
 *
 * ## Never breaks a page
 *
 * Every method swallows its errors and every call is time-bounded. A locked,
 * missing or corrupt database degrades to "no persistent cache", never to an
 * exception on a render path.
 */
import prisma from "@/lib/prisma";

/**
 * Bump when the persisted shape changes incompatibly. Rows at any other
 * version are ignored on read and overwritten on the next fetch.
 */
export const PAYLOAD_VERSION = 1;

/** Ceiling on persisted rows. Detail payloads are large; this is not a log. */
const MAX_ROWS = 5000;
/** How often to consider pruning, in writes. Pruning every write is wasteful. */
const PRUNE_EVERY = 200;
/** A local SQLite read should take single-digit milliseconds. */
const DB_TIMEOUT_MS = 2000;

/**
 * The exact Prisma model this module is written against. Kept in the source it
 * belongs to so the two cannot drift apart silently.
 *
 * ```prisma
 * model WorkDetailCache {
 *   id           String   @id @default(cuid())
 *   /// detail:tmdb:movie:693134 | season:tmdb:tv:95396:1
 *   cacheKey     String   @unique
 *   kind         String // detail | season
 *   mediaType    String // movie | tv
 *   tmdbId       Int
 *   seasonNumber Int?
 *   /// Payload shape version. Rows at another version are ignored.
 *   version      Int
 *   /// JSON, or the literal "null" for a remembered miss.
 *   payload      String
 *   fetchedAt    DateTime
 *   createdAt    DateTime @default(now())
 *   updatedAt    DateTime @updatedAt
 *
 *   @@index([fetchedAt])
 *   @@index([kind, tmdbId])
 * }
 * ```
 */
export const WORK_DETAIL_CACHE_MODEL = "WorkDetailCache";

export interface RowMeta {
  kind: "detail" | "season";
  mediaType: "movie" | "tv";
  tmdbId: number;
  seasonNumber?: number | null;
}

export interface StoredRow {
  /** Parsed payload, or null for a remembered miss. */
  payload: unknown;
  /** Epoch ms. The caller applies its own positive/negative TTL policy. */
  fetchedAt: number;
  /** False when this row records "asked, nothing acceptable". */
  found: boolean;
}

export interface DetailStore {
  read(key: string): Promise<StoredRow | null>;
  write(key: string, meta: RowMeta, payload: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Safety rails
// ---------------------------------------------------------------------------

/** Resolves to `fallback` on throw or on timeout. Never rejects. */
async function bounded<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), DB_TIMEOUT_MS);
    try {
      work().then(
        (value) => finish(value),
        () => finish(fallback),
      );
    } catch {
      finish(fallback);
    }
  });
}

// ---------------------------------------------------------------------------
// Prisma-backed implementation
// ---------------------------------------------------------------------------

/**
 * `null` until probed. Cached because the answer only changes when a migration
 * runs, and probing `sqlite_master` on every title render would be silly.
 */
let tableReady: boolean | null = null;
let writesSincePrune = 0;

async function hasTable(): Promise<boolean> {
  if (tableReady !== null) return tableReady;
  const rows = await bounded<unknown[]>(
    () =>
      prisma.$queryRawUnsafe(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        WORK_DETAIL_CACHE_MODEL,
      ) as Promise<unknown[]>,
    [],
  );
  tableReady = Array.isArray(rows) && rows.length > 0;
  return tableReady;
}

interface RawRow {
  payload: string;
  fetchedAt: string;
  version: number;
}

function decodeRow(row: RawRow): StoredRow | null {
  if (Number(row.version) !== PAYLOAD_VERSION) return null;
  const fetchedAt = Date.parse(row.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    // A truncated or hand-edited row is not a reason to fail a page.
    return null;
  }
  return { payload, fetchedAt, found: payload !== null };
}

const prismaStore: DetailStore = {
  async read(key) {
    if (!(await hasTable())) return null;
    const rows = await bounded<RawRow[]>(
      () =>
        prisma.$queryRawUnsafe(
          `SELECT payload, fetchedAt, version FROM ${WORK_DETAIL_CACHE_MODEL} WHERE cacheKey = ? LIMIT 1`,
          key,
        ) as Promise<RawRow[]>,
      [],
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return null;
    return decodeRow(row);
  },

  async write(key, meta, payload) {
    if (!(await hasTable())) return;
    const now = new Date().toISOString();
    const body = JSON.stringify(payload ?? null);
    await bounded(
      () =>
        prisma.$executeRawUnsafe(
          `INSERT INTO ${WORK_DETAIL_CACHE_MODEL}
             (id, cacheKey, kind, mediaType, tmdbId, seasonNumber, version, payload, fetchedAt, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(cacheKey) DO UPDATE SET
             version = excluded.version,
             payload = excluded.payload,
             fetchedAt = excluded.fetchedAt,
             updatedAt = excluded.updatedAt`,
          `wdc_${key}`,
          key,
          meta.kind,
          meta.mediaType,
          meta.tmdbId,
          meta.seasonNumber ?? null,
          PAYLOAD_VERSION,
          body,
          now,
          now,
          now,
        ),
      0,
    );

    writesSincePrune += 1;
    if (writesSincePrune >= PRUNE_EVERY) {
      writesSincePrune = 0;
      void prune();
    }
  },
};

/** Best-effort trim to `MAX_ROWS`, oldest fetch first. Failure is harmless. */
async function prune(): Promise<void> {
  await bounded(
    () =>
      prisma.$executeRawUnsafe(
        `DELETE FROM ${WORK_DETAIL_CACHE_MODEL} WHERE id IN (
           SELECT id FROM ${WORK_DETAIL_CACHE_MODEL}
           ORDER BY fetchedAt DESC LIMIT -1 OFFSET ?
         )`,
        MAX_ROWS,
      ),
    0,
  );
}

// ---------------------------------------------------------------------------
// Injection seam
// ---------------------------------------------------------------------------

let active: DetailStore = prismaStore;

export function detailStore(): DetailStore {
  return active;
}

/** Test-only. Pass nothing to restore the real, Prisma-backed store. */
export function setDetailStore(store?: DetailStore | null): void {
  active = store ?? prismaStore;
  tableReady = null;
  writesSincePrune = 0;
}

/** Key for a work's detail payload. */
export function detailRowKey(mediaType: string, tmdbId: number): string {
  return `detail:tmdb:${mediaType}:${tmdbId}`;
}

/** Key for one season's episode listing. */
export function seasonRowKey(tmdbId: number, seasonNumber: number): string {
  return `season:tmdb:tv:${tmdbId}:${seasonNumber}`;
}
