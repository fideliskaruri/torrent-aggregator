/**
 * The catalog's one dependency on artwork.
 *
 * Posters are resolved by `src/lib/metadata/artwork.ts`, which is owned and
 * built separately (AniList for anime, TVmaze for TV, iTunes for films — all
 * keyless). This module is the seam between that and the catalog, and it
 * exists for two reasons that are worth more than the indirection costs:
 *
 *  1. **A poster is decoration; a rail is content.** A slow or missing artwork
 *     provider must never delay, empty or fail a refresh. Everything here
 *     degrades to `null`, which the card layer already treats as the *common*
 *     case — `PosterImage` draws a deterministic tinted tile with the title's
 *     initial, and posters are missing for most torrent-sourced rows anyway.
 *
 *  2. **A refresh must be bounded.** `resolveArtworkBatch` promises never to
 *     throw, but nothing can promise to be fast, so the call is raced against a
 *     budget. Losing the race costs this refresh its posters and nothing else;
 *     the next one fills them in.
 *
 * The `Artwork` / `ArtworkQuery` shapes below are the metadata module's
 * published contract, restated so this file has something to type against
 * regardless of whether that module has landed yet.
 */

/** Exactly the metadata module's query shape. */
export interface ArtworkQuery {
  title: string;
  year?: number | null;
  mediaType: "movie" | "tv" | "anime" | null;
}

/** Exactly the metadata module's result shape. */
export interface Artwork {
  posterUrl: string | null;
  backdropUrl: string | null;
}

/** Order-preserving nulls: the shape every failure path returns. */
function noArtwork(count: number): Artwork[] {
  return Array.from({ length: count }, () => ({
    posterUrl: null,
    backdropUrl: null,
  }));
}

/**
 * Whether the artwork provider is present in this build.
 *
 * `src/lib/metadata/artwork.ts` is developed in parallel with this module and
 * is not this module's to create, so the catalog was written to work without
 * it: every poster resolves to `null`, rows are still written, rails still
 * render, cards fall back to their tinted tile. It has since landed, so the
 * real provider is wired in below — but the degraded path is kept intact
 * rather than deleted, because it is the same path a provider outage takes.
 */
export const ARTWORK_PROVIDER_AVAILABLE = true;

/**
 * Resolve artwork for a batch of titles. Order-preserving. Never throws.
 *
 * Always returns exactly `queries.length` entries, because the caller zips the
 * result back onto its works by index — a short array would silently shift
 * every poster onto the wrong title, which is precisely the "borrowed artwork"
 * failure this repo has already paid for once.
 *
 * The import is dynamic on purpose. The metadata module reaches out to three
 * network providers at module scope-adjacent depth; deferring it keeps the
 * catalog's own module graph loadable in a unit test that never asks for a
 * poster, and keeps an import-time failure there from taking down a refresh
 * here.
 */
export async function resolveArtworkFor(
  queries: readonly ArtworkQuery[],
): Promise<Artwork[]> {
  if (queries.length === 0) return [];
  try {
    const { resolveArtworkBatch } = await import("@/lib/metadata/artwork");
    const resolved = await resolveArtworkBatch([...queries]);
    return Array.isArray(resolved) ? resolved : noArtwork(queries.length);
  } catch {
    return noArtwork(queries.length);
  }
}

/**
 * How long a refresh will wait for posters before writing rows without them.
 *
 * Generous, because it is only ever paid in the background or on a cold start
 * that has nothing to show anyway — and cheap to lose, because losing it costs
 * artwork, never content.
 */
export const ARTWORK_BUDGET_MS = 15_000;

/**
 * {@link resolveArtworkFor}, bounded and hardened.
 *
 * Guarantees, in order of how badly each one has bitten this codebase before:
 * the result is exactly as long as the input; a rejection is nulls, not a
 * failed refresh; a hang is nulls after {@link ARTWORK_BUDGET_MS}; and a
 * malformed entry is nulls rather than `undefined` reaching Prisma.
 */
export async function resolveArtworkBounded(
  queries: readonly ArtworkQuery[],
  budgetMs: number = ARTWORK_BUDGET_MS,
): Promise<Artwork[]> {
  if (queries.length === 0) return [];

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<Artwork[]>((resolve) => {
    timer = setTimeout(() => resolve(noArtwork(queries.length)), budgetMs);
  });

  try {
    const resolved = await Promise.race([
      resolveArtworkFor(queries).catch(() => noArtwork(queries.length)),
      budget,
    ]);
    return queries.map((_, i) => ({
      posterUrl: resolved[i]?.posterUrl ?? null,
      backdropUrl: resolved[i]?.backdropUrl ?? null,
    }));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
