/**
 * Is this release actually the work the user asked for?
 *
 * The defect this exists to stop, reported with a screenshot: the title page
 * for the 2026 film *The Odyssey* offered a release list containing
 *
 *   - `The Odyssey (1997) [480p] [bluray] [YTS]`      — a different film
 *   - `Maelstrom: The Odyssey of 'Waterworld' (2018)` — a documentary
 *   - `Homer - The Odyssey [Fagles Trans] Read by Ian McKellen` — an AUDIOBOOK
 *
 * and happily played one. Nothing in the pipeline ever asked whether a result
 * was the same *work* as the target: the search is free text, and for a film
 * `selectBestRelease` took `ordered[0]` — the best-ranked row of a title
 * substring match. A seeded audiobook outranks nothing, it simply was not
 * excluded.
 *
 * ## Scope: films only, and deliberately so
 *
 * A film's year is part of its identity (*Dune* 1984 vs 2021), and a film has
 * no season/episode structure to constrain it — so a free-text film search is
 * exactly where a wrong work sails through. Series releases already have to
 * match an exact season and episode, and their names legitimately disagree with
 * the catalogue far more often (`BLEACH Sennen Kessen` vs
 * `Bleach - Thousand-Year Blood War`, every anime alias the grab ladder exists
 * to try). Applying a name test there would reject releases that are correct,
 * which is a worse failure than the one being fixed.
 *
 * ## The rule: reject only what can be DISPROVEN
 *
 * This is a guard, not a ranker. It answers "can this be the target?" and says
 * no only on positive evidence, because a false reject is an unplayable title:
 *
 *   1. **Proven different film** — both the target and the release state a
 *      year and they differ by more than one. (One year of slack: scene names
 *      sometimes carry a production/festival year.)
 *   2. **Proven different work** — the name the release states is neither the
 *      target's name, nor a name the target refines, nor the target's name
 *      followed by trailing junk the release-name cleaner did not recognise.
 *
 * That third allowance is what keeps the guard safe. `filmNameFromRelease`
 * strips the tokens it knows (`1080p`, `WEB-DL`, group tags…), but an unknown
 * trailing token would otherwise make a perfectly good release look like a
 * longer, different work and take playback away. Trailing junk is tolerated;
 * a **subtitle** (`Name: Something`, `Name - Something`) is not, because that
 * names a distinct work — which is exactly how the audiobook companion
 * "The Odyssey - An Illustrated Guide" is rejected while
 * "The Odyssey 2026 REMUX proper" is kept.
 *
 * Anything unknown — no year on either side, an unparseable name — passes. Not
 * knowing is not evidence.
 */
import { catalogAgrees, workIdentity } from "@/lib/torrents/work-identity";

/** Years this far apart are still allowed to be the same film. */
const YEAR_SLACK = 1;

/** Starts a subtitle, i.e. names a *different* work rather than refining one. */
const SUBTITLE_MARKER = /^\s*(?::|[-–—]\s)/;

export interface WorkMatchTarget {
  /** The work's name, as the catalogue/user knows it. */
  title: string;
  /** Release year, when known. Absent means "unknown", never "any". */
  year?: number | null;
  /** True when the target is a series; the guard then stands down. */
  isSeries?: boolean;
}

/**
 * True when `releaseTitle` could be a release of `target`.
 *
 * Series targets always return true — see the scope note above.
 */
export function releaseMatchesWork(
  releaseTitle: string,
  target: WorkMatchTarget,
): boolean {
  const name = target.title?.trim();
  if (!name) return true; // nothing to compare against
  if (target.isSeries) return true;

  const release = releaseTitle?.trim();
  if (!release) return true;

  const identity = workIdentity(release);

  // A release that declares season/episode structure is a series release. It
  // cannot be the film we are looking for, whatever it is called.
  if (identity.isSeries) return false;

  const targetYear = normalizeYear(target.year);
  if (
    targetYear != null &&
    identity.year != null &&
    Math.abs(identity.year - targetYear) > YEAR_SLACK
  ) {
    return false;
  }

  return (
    catalogAgrees(identity.name, name) || extendsWithJunkOnly(identity.name, name)
  );
}

/**
 * Does `releaseName` start with `targetName` and continue only into junk?
 *
 * `catalogAgrees` answers the other direction (the catalogue refining the
 * release). This covers the release carrying an extra token the cleaner did
 * not strip, which must not cost the viewer a valid release — while a subtitle
 * continuation still names a different work and is refused.
 */
function extendsWithJunkOnly(releaseName: string, targetName: string): boolean {
  const a = normalizeForCompare(releaseName);
  const b = normalizeForCompare(targetName);
  if (!a || !b || !a.startsWith(b)) return false;
  if (a.length === b.length) return true;
  // The boundary must fall between words, so "The Odyssey" does not match
  // "The Odysseyssey", and the remainder must not open a subtitle.
  const rest = releaseName.trim().slice(targetName.trim().length);
  if (rest && !/^[\s:._\-–—]/.test(rest)) return false;
  return !SUBTITLE_MARKER.test(rest);
}

/** Casefold for comparison. Mirrors work-identity's own key normalisation. */
function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeYear(year: number | null | undefined): number | null {
  if (typeof year !== "number" || !Number.isFinite(year)) return null;
  const y = Math.trunc(year);
  return y >= 1900 && y <= 2200 ? y : null;
}

/**
 * Keep only the releases that could be the target's, preserving input order.
 *
 * Order is the ranker's and is never touched here: this filters, it does not
 * re-rank.
 *
 * An empty result is a real, honest answer and is returned as one. The
 * tempting fallback — "if the filter emptied the pool, return it unchanged" —
 * would reinstate the exact defect this module exists to fix: for *The
 * Odyssey* NOTHING in the pool is the 2026 film, so falling back would hand
 * the audiobook straight back to the player. A title with no matching release
 * must say so.
 */
export function filterReleasesForWork<T extends { title: string }>(
  releases: readonly T[],
  target: WorkMatchTarget,
): readonly T[] {
  if (releases.length === 0) return releases;
  return releases.filter((r) => releaseMatchesWork(r.title, target));
}
