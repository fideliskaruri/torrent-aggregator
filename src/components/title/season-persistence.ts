/**
 * Which season the title page should show, across the two very different ways
 * this component can receive new props.
 *
 * The bug this answers (BUG-SEASON-SPA-PERSISTENCE): pick a non-default season,
 * navigate away and come back through an in-app link or Back, and the page
 * dropped back to the provider/watch-cursor default. A hard refresh on the same
 * URL restored it correctly.
 *
 * Why the two paths differ: a hard refresh re-runs the server page component,
 * which reads the durable `tf_season` cookie. A client-side navigation may
 * replay a router-cached RSC payload that was produced *before* the season was
 * picked, so the server-rendered `rememberedSeason` prop can be stale. The
 * browser cookie is the live source that makes SPA return match refresh.
 *
 * A legacy inbound `?s=` may seed one visit, but it is immediately migrated to
 * the cookie and removed from the address bar. It is not persistence.
 */

import { isValidSeason } from "@/lib/title/remembered-season";

function seasonOrNull(value: number | null | undefined): number | null {
  return isValidSeason(value) ? value : null;
}

export interface SeasonSources {
  /** One-time migration seed from an old inbound `?s=` link. */
  legacySeason?: number | null;
  /** The `tf_season` cookie value read server-side, when present. */
  rememberedSeason?: number | null;
  /** The `tf_season` cookie value read client-side from `document.cookie`. */
  cookieSeason?: number | null;
}

/**
 * The season to open with when nothing has been picked in this mount yet.
 *
 * Same order on the server and the client, so a hard refresh and a client-side
 * navigation land on the same season.
 */
export function resolveInitialSeason(sources: SeasonSources): number | null {
  return (
    seasonOrNull(sources.legacySeason) ??
    seasonOrNull(sources.cookieSeason) ??
    seasonOrNull(sources.rememberedSeason)
  );
}

export interface SeasonResyncInput extends SeasonSources {
  /** The workKey the current `currentSeason` belongs to. */
  previousWorkKey: string;
  /** The workKey the incoming props describe. */
  workKey: string;
  /** The season currently held in component state. */
  currentSeason: number | null;
  /** True only after the user changed the season during this mount. */
  preserveCurrentSeason?: boolean;
}

/**
 * The season state after a props change.
 *
 * - A different title always re-resolves from scratch (state from the previous
 *   title must never leak into the next one).
 * - A season already picked in this mount survives stale props.
 * - Otherwise the browser cookie wins over the server-rendered cookie prop.
 * - A different title resolves from its own legacy seed/cookie only.
 */
export function resolveSeasonOnPropsChange(
  input: SeasonResyncInput,
): number | null {
  if (input.workKey !== input.previousWorkKey) {
    return resolveInitialSeason(input);
  }
  const current = seasonOrNull(input.currentSeason);
  if (input.preserveCurrentSeason && current != null) return current;
  return resolveInitialSeason(input) ?? current;
}
