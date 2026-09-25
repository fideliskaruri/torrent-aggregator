/**
 * Media type: the catalog's word for what a title *is*, and the one place it
 * gets converted into anything else.
 *
 * A watchlist row stores `mediaType` as a free-form string. Six call sites had
 * each grown their own copy of the same two derivations — "which search
 * category do I hunt in?" and "does this have episodes?" — and the copies had
 * silently diverged in three ways:
 *
 *   - **Fallback.** `automation/runner` and the search page fell back to
 *     `"all"`; `watchlist/check-releases` and `library/ondemand` fell back to
 *     `"tv"`; `browse/availability` returned null. Same input, three verdicts.
 *   - **Normalisation.** Only `browse/availability` trimmed and lowercased.
 *     Everywhere else compared with `===`, so a row stored as `"Movie"` — the
 *     casing TMDB's own UI uses — missed every branch and fell through to the
 *     `"tv"` fallback. The hunt then searched the TV category for a film, found
 *     nothing, and counted a miss. Nothing errored; the title simply never
 *     arrived.
 *   - **Aliases.** Only `browse/availability` knew `"movies"` (plural, the
 *     *category* slug) could show up where a media type was expected.
 *
 * So this module owns normalisation and the mapping, and deliberately does
 * **not** own the fallback. `searchCategoryForMediaType` returns null for
 * anything it cannot vouch for, and each caller states its own default in the
 * open — because the defaults genuinely differ and hiding that behind a shared
 * one would just move the bug. A hunt for a monitored series is right to assume
 * `"tv"`; a browse rail is right to render no category link at all.
 */

/** The three media types the catalogs (AniList, TMDB) actually produce. */
export type MediaType = "anime" | "movie" | "tv";

/** The category slugs `searchTorrents` accepts for catalog content. */
export type CatalogSearchCategory = "anime" | "movies" | "tv";

/**
 * Spellings seen in stored rows and in URLs, mapped to the canonical type.
 *
 * `movies`/`series`/`show` are here because the *category* slug and the *media
 * type* look alike and get passed to the wrong parameter; accepting both costs
 * nothing and removes a class of silent miss.
 */
const MEDIA_TYPE_ALIASES: Record<string, MediaType> = {
  anime: "anime",
  movie: "movie",
  movies: "movie",
  film: "movie",
  tv: "tv",
  series: "tv",
  show: "tv",
  tvshow: "tv",
};

const SEARCH_CATEGORY_BY_MEDIA_TYPE: Record<MediaType, CatalogSearchCategory> = {
  anime: "anime",
  movie: "movies",
  tv: "tv",
};

/**
 * Canonical media type, or null if the value is not one we recognise.
 *
 * Null rather than a default: a caller that guesses is at least guessing
 * knowingly, whereas a shared default makes an unknown value indistinguishable
 * from a known one.
 */
export function normalizeMediaType(raw: string | null | undefined): MediaType | null {
  if (!raw) return null;
  return MEDIA_TYPE_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/**
 * The search category to hunt a title in, or null if the media type is unknown.
 *
 * Callers supply their own fallback. See the module comment for why.
 */
export function searchCategoryForMediaType(
  raw: string | null | undefined,
): CatalogSearchCategory | null {
  const mediaType = normalizeMediaType(raw);
  return mediaType ? SEARCH_CATEGORY_BY_MEDIA_TYPE[mediaType] : null;
}

/**
 * Does this title have seasons and episodes?
 *
 * Anime counts. It is catalogued separately from TV because AniList is a
 * better source for it, not because it is shaped differently — an anime still
 * has `S02E05`, still needs a hunt cursor, still needs an episode picker.
 * Unknown types answer false: showing an episode UI for something we cannot
 * confirm is a series is the worse of the two mistakes.
 */
export function isSeriesMediaType(raw: string | null | undefined): boolean {
  const mediaType = normalizeMediaType(raw);
  return mediaType === "tv" || mediaType === "anime";
}
