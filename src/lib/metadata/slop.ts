/**
 * Slop: titles that are not the name of a real work.
 *
 * Two sources feed the browse rails, and each leaks a different kind of
 * non-title into them:
 *
 *   - **The catalog (TMDB).** Trending charts carry announced-but-unnamed
 *     projects whose title is a literal placeholder — "Untitled Marvel
 *     Project", "Untitled Star Wars Film". TMDB is telling the truth (the work
 *     has no name yet), but a card reading "Untitled … Project" is noise on a
 *     home page, not a thing anyone can decide to watch.
 *   - **The charts fallback.** When TMDB is unreachable the catalog is
 *     reverse-engineered from release names, and the browse collapser has a
 *     documented last-resort placeholder ("Unknown title") for a release that
 *     is nothing but an episode coordinate. A rail must never render that
 *     placeholder as if it were a work.
 *
 * This is the RULE CLASS, not a blocklist of the specific strings a screenshot
 * happened to show. It rejects the *shape* of a non-title:
 *
 *   1. Structurally unusable — empty, a single character, or carrying neither a
 *      letter nor a digit (pure punctuation like "---" or "|||"). A purely
 *      numeric title is *not* junk: 1917, 300 and 2012 are real films.
 *   2. A known placeholder for an unnamed/unknown work — "Untitled …", our own
 *      "Unknown title", "TBA"/"TBD"/"N/A", "Coming soon".
 *   3. A bare structural coordinate promoted into a title slot — "Episode 5",
 *      "Season 3", "Movie #12", "S01E05".
 *
 * It is deliberately conservative: a legitimately terse real title ("Unknown",
 * the 2011 film; "Us"; "It"; "1917") must pass, because dropping a real title is
 * a worse failure than showing one slightly ugly card. So the placeholder set is
 * matched as whole phrases — "Unknown title" (our placeholder) is rejected but
 * bare "Unknown" is not — and "Untitled" is only rejected as a prefix because
 * TMDB uses it exactly that way for unnamed projects.
 */

/** Normalise for comparison: casefold, collapse separators, trim. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[._\-–—|/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whole-phrase placeholders for an unnamed or unknown work. Matched against the
 * normalised title in full, so "Unknown" (a real film) and "TBA Records" (were
 * such a thing to exist) are not swept up with the placeholders themselves.
 */
const PLACEHOLDER_PHRASES = new Set([
  "unknown title",
  "untitled",
  "no title",
  "tba",
  "tbd",
  "n a",
  "null",
  "undefined",
  "none",
  "placeholder",
  "coming soon",
]);

/**
 * "Untitled …" — TMDB's convention for an announced project with no name yet
 * ("Untitled Marvel Project"). Only as a leading word: a real title that merely
 * contains the word later is left alone.
 */
const UNTITLED_PREFIX = /^untitled\b/;

/**
 * A bare structural coordinate standing in for a title: "Episode 5",
 * "Episode #12", "Season 3", "Movie 4", "Movie #4", "Part 2", or a raw
 * `S01E05` / `1x05` / `E05`. These are positions within a work, never the work.
 */
const BARE_COORDINATE =
  /^(?:episode|ep|season|movie|film|part|chapter|vol(?:ume)?|pt)\s*#?\s*\d+$/;
const EPISODE_CODE =
  /^(?:s\d{1,3}\s*e\d{1,4}|\d{1,3}x\d{1,4}|e(?:p(?:isode)?)?\s*\d{1,4})$/;

/** True when `raw` is a placeholder / coordinate / structural junk, not a work. */
export function isSlopTitle(raw: string | null | undefined): boolean {
  if (!raw) return true;
  const trimmed = raw.trim();
  // Structural: a single character, or a string with neither letter nor digit,
  // is punctuation/noise and not a title. Purely numeric titles are kept — the
  // films 1917 and 300 are real.
  if (trimmed.length < 2) return true;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return true;

  const norm = normalize(trimmed);
  if (!norm) return true;
  if (PLACEHOLDER_PHRASES.has(norm)) return true;
  if (UNTITLED_PREFIX.test(norm)) return true;
  if (BARE_COORDINATE.test(norm)) return true;
  if (EPISODE_CODE.test(norm)) return true;

  return false;
}

/** Inverse of {@link isSlopTitle}: true when the title names a renderable work. */
export function isRenderableTitle(raw: string | null | undefined): boolean {
  return !isSlopTitle(raw);
}
