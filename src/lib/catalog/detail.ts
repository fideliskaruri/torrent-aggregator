/**
 * The catalog's one dependency on work detail (synopsis, rating).
 *
 * Sibling of `./artwork.ts` and built to the same rules, for the same reason:
 * a synopsis is content, but a synopsis provider is a network call, and a
 * network call must never be able to delay, empty or fail a refresh.
 *
 * ## Why this exists now and did not before
 *
 * `draftFromWork` used to hard-code `overview: null, rating: null` with a
 * comment explaining that a work reverse-engineered from release names has no
 * synopsis and "there is nowhere honest to get one from". That was true when
 * it was written. It stopped being true when `metadata/work-detail.ts` landed:
 * it resolves detail through `resolveTmdbRef` — *the same matcher that already
 * chose the row's poster* — so a row's synopsis and its artwork can never
 * disagree about which film they describe. That shared matcher is the honesty
 * argument; without it this would be a second, weaker guess at identity and
 * the old comment would still stand.
 *
 * Measured effect: `overview` was populated on 20 of 116 catalog rows —
 * 0 of 48 trending, 0 of 48 popular — which is why nearly every hero read a
 * mechanical status clause instead of describing the film.
 *
 * Everything here degrades to `null`. A row with no synopsis renders; a
 * refresh that hangs on synopses does not.
 */
import type { ArtworkQuery } from "./artwork";

/** Exactly the fields a catalog row takes from a work detail lookup. */
export interface CatalogDetail {
  overview: string | null;
  /** TMDB's 0–10 vote average. Null means *unrated*, never "rated zero". */
  rating: number | null;
}

/** Order-preserving nulls: the shape every failure path returns. */
function noDetail(count: number): (CatalogDetail | null)[] {
  return Array.from({ length: count }, () => null);
}

/**
 * How long a refresh will wait for synopses before writing rows without them.
 *
 * Larger than the artwork budget because a detail lookup is two requests per
 * title rather than one, and paid in the same place: the background, or a cold
 * start that has nothing to show yet. Losing it costs prose, never content.
 */
export const DETAIL_BUDGET_MS = 20_000;

/**
 * Resolve synopsis and rating for a batch of titles. Order-preserving, never
 * throws, always exactly `queries.length` long.
 *
 * The import is dynamic for the same reason `./artwork.ts` defers its own: the
 * metadata module reaches three network providers, and a unit test of the
 * catalog that never asks for a synopsis should not have to load them.
 */
export async function resolveDetailFor(
  queries: readonly ArtworkQuery[],
): Promise<(CatalogDetail | null)[]> {
  if (queries.length === 0) return [];
  try {
    const { resolveWorkDetailBatch } = await import("@/lib/metadata/work-detail");
    const resolved = await resolveWorkDetailBatch([...queries]);
    if (!Array.isArray(resolved)) return noDetail(queries.length);
    return queries.map((_, i) => {
      const detail = resolved[i];
      if (!detail) return null;
      return {
        overview: nonEmpty(detail.overview),
        rating: typeof detail.rating === "number" ? detail.rating : null,
      };
    });
  } catch {
    return noDetail(queries.length);
  }
}

/**
 * {@link resolveDetailFor}, bounded.
 *
 * Same guarantees, in the same order of how badly each has bitten this
 * codebase: the result is exactly as long as the input; a rejection is nulls,
 * not a failed refresh; a hang is nulls after {@link DETAIL_BUDGET_MS}.
 */
export async function resolveDetailBounded(
  queries: readonly ArtworkQuery[],
  budgetMs: number = DETAIL_BUDGET_MS,
): Promise<(CatalogDetail | null)[]> {
  if (queries.length === 0) return [];

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<(CatalogDetail | null)[]>((resolve) => {
    timer = setTimeout(() => resolve(noDetail(queries.length)), budgetMs);
  });

  try {
    const resolved = await Promise.race([
      resolveDetailFor(queries).catch(() => noDetail(queries.length)),
      budget,
    ]);
    return queries.map((_, i) => resolved[i] ?? null);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * An empty or whitespace-only synopsis is a missing synopsis.
 *
 * TMDB returns `""` for titles it has no localised overview for, and an empty
 * string is truthy enough to reach a card and render as a blank paragraph —
 * which reads as a broken layout rather than as an absent fact.
 */
function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
