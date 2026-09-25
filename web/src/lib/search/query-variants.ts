/**
 * Conservative outbound query normalization, shared by provider discovery and
 * the grab ladder.
 *
 * A provider ranks and matches on the exact string it is handed. The formal
 * TMDB/AniList title is often NOT what an indexer — or TMDB's own search — keys
 * on. Live proof (Re:ZERO): the full name `Re:ZERO -Starting Life in Another
 * World-` returns 0 hits, while the short `Re Zero` / `ReZero` forms match. The
 * grab ladder learned this the hard way and grew the rule below. Provider
 * discovery starts from this ladder and adds only its own weaker rescue query.
 *
 * Pure — safe for tests and for both the server route and the grabber.
 */
/**
 * The single canonical form of a user query.
 *
 * Every surface that fans out to a provider, ranks hits, or keys a cache must
 * agree on this string, or `MOONKN`, `moonkn ` and `moon  kn` become three
 * different upstream requests with three different cache entries — which is
 * exactly how one casing warmed up while another timed out on a cold path.
 * Unicode is folded (NFKC) so full-width/compatibility characters collapse,
 * every whitespace run (including NBSP) becomes one space, and case is folded
 * because both TMDB and AniList match case-insensitively.
 *
 * Pure — safe for tests.
 */
function canonicalizeSearchQuery(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, " ")
    .trim()
    .toLowerCase();
}

const YEAR_TOKEN = /^(?:18|19|20|21)\d{2}$/;
const NUMBERED_SEASON_OR_EPISODE = /^(?:s|e|ep|season|episode)\d{1,3}$/;
const SEARCH_QUALIFIERS = new Set([
  "anime",
  "episode",
  "episodes",
  "film",
  "movie",
  "season",
  "series",
  "show",
  "tv",
]);
const SEARCH_ARTICLES = new Set(["a", "an", "the"]);

/** Remove common discovery qualifiers while preserving the actual title words. */
export function searchIntentQuery(raw: string): string {
  const normalized = canonicalizeSearchQuery(raw)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  const tokens = normalized
    .split(" ")
    .filter(Boolean);
  const kept: string[] = [];
  const years: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (YEAR_TOKEN.test(token)) {
      years.push(token);
      continue;
    }
    if (NUMBERED_SEASON_OR_EPISODE.test(token) || SEARCH_QUALIFIERS.has(token)) {
      if (
        (token === "season" || token === "episode") &&
        /^\d{1,3}$/.test(tokens[index + 1] ?? "")
      ) {
        index += 1;
      }
      continue;
    }
    kept.push(token);
  }
  if (kept.some((token) => !SEARCH_ARTICLES.has(token))) {
    return kept.join(" ");
  }
  return years[0] ?? (kept.join(" ") || normalized);
}
