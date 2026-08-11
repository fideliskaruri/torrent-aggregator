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
export function canonicalizeSearchQuery(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, " ")
    .trim()
    .toLowerCase();
}

/** The query as typed (whitespace-normalized) for echo/display purposes. */
export function displaySearchQuery(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, " ")
    .trim();
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

export function searchTitleVariants(title: string): string[] {
  const raw = title.trim();
  if (!raw) return [];
  const out: string[] = [];
  const add = (value: string) => {
    const v = value.replace(/\s+/g, " ").trim();
    if (v.length < 2) return;
    if (out.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    out.push(v);
  };

  add(raw);
  // Drop parenthetical years: "Show (2016)" → "Show"
  const noYear = raw
    .replace(/\(\s*(?:19|20)\d{2}\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  add(noYear);

  // Head before a dash subtitle. TMDB often writes "-Starting" with NO space
  // after the dash (`Re:ZERO -Starting Life in Another World-`), so require
  // whitespace only *before* the dash; trailing spaces are optional.
  const dashHead = (noYear.split(/\s+[-–—]\s*/)[0] ?? noYear)
    .replace(/[-–—]+$/g, "")
    .trim();
  add(dashHead);

  // Prefer short cleaned heads — these are what indexers rank ("Re Zero", "ReZero").
  for (const base of [dashHead, noYear]) {
    add(base.replace(/:/g, " "));
    add(base.replace(/:/g, ""));
    const alnum = base
      .replace(/[:._]/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    add(alnum);
    // Compact token users type into search: "rezero"
    add(alnum.replace(/\s+/g, ""));
  }

  // Cap — ladder budget is finite; formal + short aliases is enough.
  return out.slice(0, 6);
}

/**
 * Provider discovery gets one deliberately weaker rescue query in addition to
 * the conservative grab ladder. A compact token is commonly a title with its
 * spaces omitted (`moonknight`), so its first four characters can recover the
 * provider's spaced title without broadening torrent queries.
 */
export function searchDiscoveryVariants(title: string): string[] {
  const variants = searchTitleVariants(title);
  const raw = title.trim();
  const intent = searchIntentQuery(raw);
  if (
    intent &&
    !variants.some((value) => value.toLowerCase() === intent.toLowerCase())
  ) {
    variants.push(intent);
  }
  if (/^[\p{L}\p{N}]+$/u.test(intent) && intent.length >= 6) {
    const prefix = Array.from(intent).slice(0, 4).join("");
    if (
      !variants.some((value) => value.toLowerCase() === prefix.toLowerCase())
    ) {
      variants.push(prefix);
    }
  }

  const [primary, ...rescues] = variants;
  if (!primary) return [];
  // Autocomplete and discovery are latency-sensitive. Keep the raw query plus
  // the two strongest normalized rescues rather than serializing the full grab
  // ladder into outbound provider requests.
  return [primary, ...rescues.slice(-2)];
}
