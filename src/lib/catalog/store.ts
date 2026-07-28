/**
 * `CatalogEntry` reads and writes — the cache the discovery rails read from.
 *
 * The rule this module exists to keep: **a rail never computes, it reads.**
 * Resolving a torrent, searching an indexer or fetching a feed while a page is
 * rendering is what makes a catalog feel slow, so everything expensive happens
 * on a refresh (see `./refresh.ts`) and lands here. `discovery.ts` does one
 * indexed query per rail and nothing else.
 *
 * ## Why the primary key is derived rather than random
 *
 * A refresh rewrites a whole source at once. With `cuid()` ids every refresh
 * would hand every card a new React key, remounting the entire board — and
 * `@@unique([workKey, source, seedTitle])` cannot be used to upsert against
 * instead, because SQLite (correctly, per SQL) treats two NULLs as distinct,
 * so every `trending` row (which has no `seedTitle`) would duplicate on the
 * second refresh rather than update.
 *
 * Deriving the id from exactly the three columns that unique constrains fixes
 * both at once: the upsert target is a plain primary key with no NULL
 * semantics, and a work keeps its identity across refreshes.
 */
import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import { normalizeMediaType } from "@/lib/metadata/media-type";
import { releaseDateToDate } from "./tmdb";
import type { CatalogSource } from "./feeds";
import type { Artwork } from "./artwork";
import { resolveDetailBounded, type CatalogDetail } from "./detail";
import type { AvailabilitySignal } from "./availability";
import type { TmdbTitle } from "./tmdb";
import type { CatalogWork } from "./works";

/** A work plus whatever artwork was resolved for it. */
export type CatalogWorkWithArt = CatalogWork & Artwork;

/**
 * Exactly what a `CatalogEntry` row needs to be written.
 *
 * Narrower than {@link CatalogWorkWithArt} on purpose. "Because you're
 * watching…" rows are re-derived from rows already in the cache, which no
 * longer carry a popularity sum or a release count — and inventing plausible
 * numbers to satisfy a wider type is how a field ends up holding something
 * nobody measured.
 */
export interface CatalogRowDraft {
  workKey: string;
  title: string;
  year: number | null;
  mediaType: string;
  /**
   * Primary release / first-air date, or null when unknown. Populated from
   * TMDB (`release_date` / `first_air_date`) or a work-detail lookup; the
   * charts-only fallback path has no date to give and leaves it null. Drives
   * future-gating downstream — see src/lib/browse/release-status.ts — so it is
   * never fabricated: null stays null.
   */
  releaseDate: Date | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
  /** TMDB's 0–10 vote average. Null means *unrated*, never "rated zero". */
  rating: number | null;
  /**
   * The *best single release's* seeders, never a popularity sum: this number
   * is a health hint about something the user could actually download, and a
   * sum would overstate every one of them.
   */
  seeders: number;
  bestRelease: string | null;
}

/**
 * A catalog title from TMDB, plus whatever the torrent charts knew about it.
 *
 * The two halves are kept honest about their provenance: the title, artwork,
 * synopsis and rating are TMDB's and are always present; the seeder count and
 * release name come from a chart cross-reference that usually misses, and
 * when it misses they are `0` and `null` rather than a plausible-looking
 * number nobody measured.
 */
export function draftFromTmdb(
  title: TmdbTitle,
  workKey: string,
  signal: AvailabilitySignal | null,
): CatalogRowDraft {
  return {
    workKey,
    // Verbatim. See `./tmdb.ts`: running a canonical title through
    // release-name cleaning turns "A Shop for Killers" into "A Shop for".
    title: title.title,
    year: title.year,
    mediaType: title.mediaType,
    releaseDate: releaseDateToDate(title.releaseDate),
    posterUrl: title.posterUrl,
    backdropUrl: title.backdropUrl,
    overview: title.overview,
    rating: title.rating,
    seeders: signal?.peakSeeders ?? 0,
    bestRelease: signal?.bestRelease ?? null,
  };
}

/**
 * A ranked work, ready to be stored.
 *
 * `detail` is what `./detail.ts` resolved for this work, or `null` when it
 * resolved nothing — a provider miss, an outage, or a budget overrun. Passing
 * it in rather than fetching it here keeps this function pure and keeps the
 * network call batched: see {@link draftsFromWorks}.
 */
export function draftFromWork(
  work: CatalogWorkWithArt,
  detail: CatalogDetail | null = null,
): CatalogRowDraft {
  return {
    workKey: work.workKey,
    title: work.title,
    year: work.year,
    mediaType: work.mediaType,
    // A work reverse-engineered from release names has no date of its own; the
    // detail lookup (same TMDB matcher that chose the poster) supplies one when
    // it resolved a match, else null. Never invented from a release string.
    releaseDate: releaseDateToDate(detail?.releaseDate ?? null),
    posterUrl: work.posterUrl,
    backdropUrl: work.backdropUrl,
    // A work reverse-engineered from release names carries no synopsis of its
    // own, so these come from `metadata/work-detail.ts` via `./detail.ts` —
    // resolved through the *same* TMDB matcher that chose this row's poster,
    // so a row's prose and its artwork always describe the same film. Null
    // when that lookup found nothing: still no invented text, still no
    // "rated zero".
    overview: detail?.overview ?? null,
    rating: detail?.rating ?? null,
    seeders: work.peakSeeders,
    bestRelease: work.bestRelease,
  };
}

/**
 * {@link draftFromWork} over a whole ranked list, with one batched detail
 * lookup for the set. Order-preserving. Never throws.
 *
 * The lookup is bounded and every failure path is `null`, so the worst case is
 * the behaviour this function replaced: rows written without a synopsis.
 */
export async function draftsFromWorks(
  works: readonly CatalogWorkWithArt[],
): Promise<CatalogRowDraft[]> {
  if (works.length === 0) return [];

  const details = await resolveDetailBounded(
    works.map((work) => ({
      title: work.title,
      year: work.year,
      // Normalised rather than passed through, so a type this module cannot
      // vouch for arrives as null instead of as a wrong lookup.
      mediaType: normalizeMediaType(work.mediaType),
    })),
  );

  return works.map((work, i) => draftFromWork(work, details[i] ?? null));
}

/** A stored row, ready to be stored again under a different source. */
export function draftFromRow(row: CatalogRow): CatalogRowDraft {
  return {
    workKey: row.workKey,
    title: row.title,
    year: row.year,
    mediaType: row.mediaType,
    releaseDate: row.releaseDate,
    posterUrl: row.posterUrl,
    backdropUrl: row.backdropUrl,
    overview: row.overview,
    rating: row.rating,
    seeders: row.seeders,
    bestRelease: row.bestRelease,
  };
}

/** One stored catalog row, as the rails read it. */
export interface CatalogRow {
  id: string;
  workKey: string;
  title: string;
  year: number | null;
  mediaType: string;
  /** Primary release / first-air date; null when unknown. Drives future-gating. */
  releaseDate: Date | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
  rating: number | null;
  source: string;
  rank: number;
  seedTitle: string | null;
  seeders: number;
  bestRelease: string | null;
  refreshedAt: Date;
}

/**
 * Stable primary key for a catalog row.
 *
 * Derived from the same triple the schema's unique constraint names, so the
 * two can never disagree. Hashed rather than concatenated because `workKey`
 * and `seedTitle` are free-form text of unbounded length.
 */
export function catalogEntryId(
  source: CatalogSource,
  seedTitle: string | null,
  workKey: string,
): string {
  return createHash("sha1")
    .update(`${source}\u0000${seedTitle ?? ""}\u0000${workKey}`)
    .digest("hex");
}

/**
 * Drop drafts whose work key a earlier draft already claimed.
 *
 * A partition's primary key is derived from its work key, so two drafts that
 * key the same would upsert the same row twice: the second would overwrite the
 * first, take its rank, and leave a gap — a rail one card shorter than it
 * looks, for no visible reason. The higher-ranked draft wins because the list
 * arrives most-popular-first.
 *
 * This is a real case, not a defensive one: TMDB paging can return the same
 * title on two pages when a chart reorders mid-request, and a film and its
 * re-release share a work identity.
 */
export function dedupeByWorkKey(
  drafts: readonly CatalogRowDraft[],
): CatalogRowDraft[] {  const seen = new Set<string>();
  const out: CatalogRowDraft[] = [];
  for (const draft of drafts) {
    if (!draft.workKey || seen.has(draft.workKey)) continue;
    seen.add(draft.workKey);
    out.push(draft);
  }
  return out;
}

/**
 * Replace everything stored under one (`source`, `seedTitle`) partition.
 *
 * Ordering is deliberate: rows are written *before* stale ones are removed, so
 * a crash mid-refresh leaves a rail with extra old cards rather than a hole.
 * Too much content is a blemish; a rail that empties itself because a write
 * failed halfway looks like the product breaking.
 *
 * Writes are sequential because SQLite takes one writer at a time — firing 24
 * upserts concurrently only produces 24 lock contentions.
 */
export async function replaceCatalogSource(
  source: CatalogSource,
  seedTitle: string | null,
  drafts: readonly CatalogRowDraft[],
): Promise<number> {
  const refreshedAt = new Date();
  const keptIds: string[] = [];

  for (const [rank, draft] of dedupeByWorkKey(drafts).entries()) {
    const id = catalogEntryId(source, seedTitle, draft.workKey);
    keptIds.push(id);

    const data = {
      workKey: draft.workKey,
      title: draft.title,
      year: draft.year,
      releaseDate: draft.releaseDate,
      mediaType: draft.mediaType,
      posterUrl: draft.posterUrl,
      backdropUrl: draft.backdropUrl,
      overview: draft.overview,
      rating: draft.rating,
      source,
      rank,
      seedTitle,
      seeders: draft.seeders,
      bestRelease: draft.bestRelease,
      refreshedAt,
    };

    await prisma.catalogEntry.upsert({
      where: { id },
      create: { id, ...data },
      // `posterUrl`/`backdropUrl` are overwritten with whatever this refresh
      // resolved, including null. Keeping a stale poster would be the same
      // borrowed-artwork failure the work-identity rules exist to prevent: the
      // row it belonged to may no longer be this work.
      update: data,
    });
  }

  const removed = await prisma.catalogEntry.deleteMany({
    where: { source, seedTitle, id: { notIn: keptIds } },
  });

  return removed.count;
}

/** Read one rail's worth of rows, most popular first. */
export async function readCatalogRows(
  source: CatalogSource,
  seedTitle: string | null,
  limit: number,
): Promise<CatalogRow[]> {
  return prisma.catalogEntry.findMany({
    where: { source, seedTitle },
    orderBy: [{ rank: "asc" }, { title: "asc" }],
    take: limit,
  });
}

/** Every seed a "Because you're watching…" rail has rows for. */
export async function readRelatedSeeds(): Promise<string[]> {
  const rows = await prisma.catalogEntry.findMany({
    where: { source: "related", seedTitle: { not: null } },
    select: { seedTitle: true },
    distinct: ["seedTitle"],
  });
  return rows
    .map((r) => r.seedTitle)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

/** What the read path needs to decide between "serve" and "go and fetch". */
export interface CatalogStatus {
  entryCount: number;
  /** Newest `refreshedAt` across all rows, or null when the cache is empty. */
  refreshedAt: Date | null;
}

export async function readCatalogStatus(): Promise<CatalogStatus> {
  const [entryCount, newest] = await Promise.all([
    prisma.catalogEntry.count(),
    prisma.catalogEntry.findFirst({
      orderBy: { refreshedAt: "desc" },
      select: { refreshedAt: true },
    }),
  ]);
  return { entryCount, refreshedAt: newest?.refreshedAt ?? null };
}

/** Drop every row for a source. Used when a seed stops being the user's seed. */
export async function dropRelatedSeeds(seeds: readonly string[]): Promise<number> {
  if (seeds.length === 0) return 0;
  const removed = await prisma.catalogEntry.deleteMany({
    where: { source: "related", seedTitle: { in: [...seeds] } },
  });
  return removed.count;
}
