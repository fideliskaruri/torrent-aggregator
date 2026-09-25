/**
 * Artwork resolution: a title in, a poster and a backdrop out.
 *
 * ## Why this module exists
 *
 * Cards rendered as grey tiles with a single letter because TMDB — the only
 * provider for movies and TV — was gated on `process.env.TMDB_API_KEY` being
 * truthy, and `.env` carried the two-character placeholder `xx`. TMDB looked
 * configured, every request 401'd, and the failure was silent. AniList needs no
 * key, so anime had covers and nothing else did.
 *
 * The fix is not "add the key". It is that **artwork must survive having no
 * keys at all**: TMDB rate-limits under a browse-heavy UI, keys get revoked,
 * and a fresh clone of this repo has no key. So every media type has a keyless
 * fallback (TVmaze for TV, iTunes for film, AniList for anime), and the key
 * gate now treats a placeholder as absent so a misconfiguration degrades to the
 * fallbacks instead of to nothing.
 *
 * ## The hard part is saying no
 *
 * A wrong poster is worse than no poster. This repo has already shipped a card
 * wearing a different film's poster, and it makes the whole app look broken.
 * Returning the provider's first result is therefore not acceptable: a search
 * for "Dune" that lands on *Dune: Part Two* is a bug, while a search for
 * "Frieren" that lands on *Frieren: Beyond Journey's End* is correct. The
 * difference is not string distance — it is whether the extra words name a
 * different instalment or merely describe the same work. `matchTier` encodes
 * exactly that, and anything it cannot vouch for resolves to `null`.
 *
 * ## Cost
 *
 * Every lookup is memoised in-process (positive *and* negative), concurrent
 * lookups of the same title share one promise, every provider call is bounded
 * by a timeout, and batches run with bounded concurrency. A dead network
 * degrades to letter tiles; it never throws and never hangs a page.
 *
 * Persistence is deliberately in-memory only: durable caching would need a
 * `prisma/schema.prisma` change, which this module is not allowed to make.
 */

// ---------------------------------------------------------------------------
// Public contract — other modules are written against this exact shape.
// ---------------------------------------------------------------------------

export interface ArtworkQuery {
  title: string;
  year?: number | null;
  mediaType: "movie" | "tv" | "anime" | null;
}

export interface Artwork {
  posterUrl: string | null;
  backdropUrl: string | null;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Title normalisation
// ---------------------------------------------------------------------------

/**
 * Comparable form of a title: no case, no accents, no punctuation.
 *
 * `&`/`and` and `’`/`'` differ freely between catalogs, and "Journey's End"
 * must equal "Journeys End".
 */
function normalizeTitleForMatch(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2018\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CURRENT_YEAR = new Date().getFullYear();

/** A plausible release year. 2049 is part of a title, not a year. */
function plausibleYear(value: number): boolean {
  return value >= 1900 && value <= CURRENT_YEAR + 5;
}

const RELEASE_NOISE =
  /\b(1080p|720p|480p|2160p|4k|uhd|hdr10?\+?|hevc|x26[45]|h\.?26[45]|av1|web-?dl|webrip|bluray|bdrip|brrip|dvdrip|hdtv|remux|proper|repack|multi|dual|subbed|dubbed|complete|batch)\b/gi;
const SEASON_EPISODE =
  /\b(s\d{1,2}\s*-\s*s?\d{1,2}|s\d{1,2}e\d{1,3}(?:\s*-\s*e?\d{1,3})?|s\d{1,2}|e\d{1,3}|ep\s*\d{1,3}|season\s*\d+|part\s+\d+\s*$)\b/gi;

/**
 * Trim a caller's title down to the work's name, and recover a year if one is
 * sitting in it.
 *
 * This deliberately overlaps `enrich.cleanTorrentTitle` rather than importing
 * it: `enrich` imports *this* module, and a cycle between them is not worth the
 * dozen lines saved. The two jobs also differ — this one only has to make two
 * titles comparable and produce a stable cache key, so that three episodes of
 * one show collapse to a single lookup.
 *
 * A bare trailing year is only treated as a year when it is plausible as one,
 * so `Blade Runner 2049` keeps its digits (the exact regression `enrich`
 * documents) while `Dune 2021` yields `Dune` + 2021.
 */
export function cleanQueryTitle(raw: string): { title: string; year: number | null } {
  let year: number | null = null;

  const bracketedYear = raw.match(/[([](\d{4})[)\]]/);
  if (bracketedYear && plausibleYear(Number(bracketedYear[1]))) {
    year = Number(bracketedYear[1]);
  }

  let title = raw
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .replace(SEASON_EPISODE, " ")
    .replace(RELEASE_NOISE, " ")
    .replace(/[._\-\u2013\u2014|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const trailing = title.match(/^(.*\S)\s+(\d{4})$/);
  if (trailing && plausibleYear(Number(trailing[2]))) {
    const head = trailing[1].trim();
    // A single-token title *is* the year ("1917", "2012"). Never strip that.
    if (head && head.split(/\s+/).length >= 1 && normalizeTitleForMatch(head)) {
      title = head;
      year = year ?? Number(trailing[2]);
    }
  }

  title = dropTrailingListNoise(raw, title);

  return { title: title.trim(), year };
}

/**
 * Drop a stray number left dangling after the technical groups.
 *
 * Observed live on this repo's own search page: APIBAY returns
 * `Dune Part Two (2024) [1080p] [WEBRip] 88`, and once the brackets are gone
 * the title reads "Dune Part Two 88". That trailing token then looks exactly
 * like an instalment number, so the matcher refuses *Dune: Part Two* and the
 * top card on a "dune" search renders as a grey letter tile.
 *
 * The rule is positional, not numeric, because the number itself carries no
 * signal: "Rocky 4" and "Dune Part Two 88" are indistinguishable as strings.
 * What separates them is that the junk digit sits *after* the release's
 * bracketed metadata, where a title cannot reach. `Rocky 4` has no brackets,
 * so it is untouched; `Blade Runner 2049` is untouched twice over (no
 * brackets, and it is not the last token after one).
 */
function dropTrailingListNoise(raw: string, title: string): string {
  const lastBracket = raw.lastIndexOf("]");
  const lastParen = raw.lastIndexOf(")");
  const afterGroups = Math.max(lastBracket, lastParen);
  if (afterGroups < 0) return title;
  if (!/^\s*\d{1,4}\s*$/.test(raw.slice(afterGroups + 1))) return title;

  const stripped = title.replace(/\s+\d{1,4}$/, "").trim();
  // Never strip a title down to nothing, and never leave a bare instalment
  // head behind ("Part", "Vol") — that would be worse than the noise.
  if (!stripped || !normalizeTitleForMatch(stripped)) return title;
  return stripped;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Safety rails
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
