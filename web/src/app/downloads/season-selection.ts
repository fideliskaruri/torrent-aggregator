/**
 * Which season the series download dialog opens to, and how it keeps its
 * place across a 5-second poll.
 *
 * Two rules the dialog's data contract depends on:
 *
 *  - **The default season is the one the user is waiting on.** A season still
 *    downloading, or short of 100%, is why someone opened the dialog in the
 *    first place; a show that is entirely ready has no such season, so the
 *    first ordered season (the grouping module already orders seasons
 *    ascending, "Other" last) is the honest fallback.
 *  - **Selection is stable across a poll.** The dialog re-derives its group
 *    from the live torrent list every five seconds; re-picking a default each
 *    time would snap the view back to whatever season is downloading right
 *    now and fight a user reading a different one. The already-selected season
 *    survives every poll where it still exists, and is only replaced when it
 *    has actually vanished (deleted, or the last poll dropped it).
 *
 * Pure and DOM-free, driven as a table by `season-selection.test.ts`.
 */
import {
  isDownloading,
  type DownloadGroup,
  type SeasonBucket,
  type SeriesGroup,
} from "./grouping";

/** First season that is still downloading or short of 100%, else the first season. */
export function defaultSeasonKey<T>(
  seasons: readonly SeasonBucket<T>[],
): string | null {
  if (!seasons.length) return null;
  const active = seasons.find(
    (season) => isDownloading(season.state) || season.progress < 1,
  );
  return (active ?? seasons[0]).key;
}

/**
 * The season key the dialog should show: the current one if it still exists,
 * otherwise the default. Passing `null` for `currentKey` (dialog just opened,
 * or opened a different series) always resolves through `defaultSeasonKey`.
 */
export function resolveSelectedSeasonKey<T>(
  seasons: readonly SeasonBucket<T>[],
  currentKey: string | null,
): string | null {
  if (currentKey && seasons.some((season) => season.key === currentKey)) {
    return currentKey;
  }
  return defaultSeasonKey(seasons);
}

/**
 * Look up a series group by its identity key, independent of whatever text or
 * status filter narrowed the list the caller built `groups` from.
 *
 * The dialog's data contract requires it to keep showing every season and
 * episode of the work the user opened even while the page's own search box or
 * status chips would hide some of those rows from the main list — so the
 * caller must build `groups` from the *unfiltered* download rows (excluding
 * stream/prewarm) and look the series up here, never from the filtered list
 * the page renders.
 */
export function seriesGroupByKey<T>(
  groups: readonly DownloadGroup<T>[],
  key: string,
): SeriesGroup<T> | null {
  const found = groups.find((group) => group.kind === "series" && group.key === key);
  return (found as SeriesGroup<T> | undefined) ?? null;
}
