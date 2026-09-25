/**
 * iTunes Search — keyless movie artwork.
 *
 * Why this exists even though TMDB now has a real key: TMDB rate-limits under a
 * browse-heavy UI, a key can be revoked or expire, and a fresh clone of this
 * repo has no key at all. The product has to look finished with zero keys.
 *
 * Two things here look wrong and are deliberate:
 *
 * 1. **The search is deliberately unfiltered.** Adding `media=movie` or
 *    `entity=movie` returns `resultCount: 0` from this network — verified twice
 *    against the live endpoint, once during design and once in the test run,
 *    while the same query without the parameter returns real films. The
 *    corporate proxy appears to strip or mangle the parameter. So the query
 *    goes out bare and the `kind` filter is applied client-side, which costs
 *    nothing and works on both networks.
 *
 *      https://itunes.apple.com/search?term=dune&limit=8            -> 8 results
 *      https://itunes.apple.com/search?term=dune&media=movie&limit=5 -> 0 results
 *      https://itunes.apple.com/search?term=dune&entity=movie&limit=5 -> 0 results
 *
 * 2. **`artworkUrl100` is resized, never used as-is.** It is a 100x100 *square*
 *    crop; dropped into a 2:3 poster slot it looks like a bug. The path segment
 *    is a resize instruction, so swapping `/100x100bb.jpg` for `/600x900bb.jpg`
 *    returns a real poster-shaped image (verified: HTTP 200, image/jpeg,
 *    138659 bytes).
 *
 * The payload also mixes audiobooks (`kind: undefined`, `trackName: undefined`)
 * and TV episodes into a film search, so rows without a usable `kind` and
 * `trackName` are dropped rather than trusted.
 */

export interface ItunesCandidate {
  id: number;
  title: string;
  year: number | null;
  /** Poster-shaped artwork, upscaled away from the square 100x100 default. */
  posterUrl: string | null;
  /** iTunes exposes no wide art. Always null; kept for a uniform shape. */
  backdropUrl: null;
  /** `feature-movie`, `tv-episode`, `song`, … */
  kind: string;
  /** Store synopsis. Plain text, occasionally absent on back-catalogue films. */
  description: string | null;
  /**
   * The single genre iTunes assigns, e.g. `Sci-Fi & Fantasy`. iTunes has no
   * genre *list* and no rating at all — see `keyless-detail.ts` for why the
   * rating stays null rather than being synthesised from the store.
   */
  genre: string | null;
  /** `YYYY-MM-DD`, sliced off the store's ISO timestamp. */
  releaseDate: string | null;
  /** Feature runtime in whole minutes, from `trackTimeMillis`. */
  runtimeMin: number | null;
}

interface ItunesRow {
  trackId?: number;
  collectionId?: number;
  trackName?: string;
  collectionName?: string;
  releaseDate?: string;
  artworkUrl100?: string;
  kind?: string;
  longDescription?: string;
  shortDescription?: string;
  primaryGenreName?: string;
  trackTimeMillis?: number;
}

const ITUNES_SEARCH = "https://itunes.apple.com/search";

/** The only `kind` values that are films. */
export const MOVIE_KINDS = ["feature-movie"] as const;

/**
 * Rewrite an `artworkUrl100` to a poster-shaped size.
 *
 * The trailing `/{w}x{h}bb.{ext}` segment is Apple's resize instruction, so it
 * can be replaced. Exported because it is the one piece of this module worth
 * asserting on directly.
 */
export function upscaleItunesArtwork(
  url: string | undefined | null,
  size = "600x900",
): string | null {
  if (!url) return null;
  const resized = url.replace(/\/\d+x\d+bb\.(jpg|png)$/i, `/${size}bb.jpg`);
  // No resize segment means an unfamiliar URL shape; a square poster is worse
  // than none, so only return what we successfully rewrote.
  return resized === url ? null : resized;
}

/**
 * Search iTunes and return film candidates. Never throws.
 *
 * `kinds` defaults to films; pass others explicitly if a caller ever needs
 * them. Filtering happens here, client-side, for the proxy reason above.
 */
export async function searchItunes(
  query: string,
  opts: { limit?: number; timeoutMs?: number; kinds?: readonly string[] } = {},
): Promise<ItunesCandidate[]> {
  const term = query.trim();
  if (!term) return [];

  const { limit = 12, timeoutMs = 5000, kinds = MOVIE_KINDS } = opts;
  const allowed = new Set(kinds);

  const url = new URL(ITUNES_SEARCH);
  url.searchParams.set("term", term);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];

    const json = (await res.json()) as { results?: ItunesRow[] };
    return (json.results ?? [])
      .map(toCandidate)
      .filter((c): c is ItunesCandidate => c !== null && allowed.has(c.kind));
  } catch {
    return [];
  }
}

function toCandidate(row: ItunesRow): ItunesCandidate | null {
  const title = row.trackName || row.collectionName;
  if (!title || !row.kind) return null;

  const year = row.releaseDate ? parseInt(row.releaseDate.slice(0, 4), 10) : NaN;

  return {
    id: row.trackId ?? row.collectionId ?? 0,
    title,
    year: Number.isFinite(year) ? year : null,
    posterUrl: upscaleItunesArtwork(row.artworkUrl100),
    backdropUrl: null,
    kind: row.kind,
    description:
      trimmed(row.longDescription) ?? trimmed(row.shortDescription) ?? null,
    genre: trimmed(row.primaryGenreName) ?? null,
    releaseDate: /^\d{4}-\d{2}-\d{2}/.test(row.releaseDate ?? "")
      ? (row.releaseDate as string).slice(0, 10)
      : null,
    runtimeMin:
      typeof row.trackTimeMillis === "number" && row.trackTimeMillis > 0
        ? Math.round(row.trackTimeMillis / 60000)
        : null,
  };
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}
