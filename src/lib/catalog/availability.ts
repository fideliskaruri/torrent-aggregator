/**
 * The torrent charts, demoted to what they are actually good for.
 *
 * TMDB knows what exists and what is popular. It does not know — and cannot
 * know — whether a given title can be fetched, or how healthy the swarm is.
 * That is the one question the apibay top-100 lists answer authoritatively,
 * so they are read as an *overlay*: a lookup from a catalog title to the best
 * release of it that was seen in this week's charts, if any.
 *
 * ## What this may and may not claim
 *
 * A hit here means a release with that work identity appeared in a public
 * chart. It does **not** mean the title is on disk, and it does not mean a
 * search would find it now. So the only fields it fills are `seeders` (a
 * health hint) and `bestRelease` (a head start for a later search).
 * `availability` stays `null` — *not determined* — for every discovery card
 * regardless of what this module returns. Claiming otherwise is the exact bug
 * class an independent review already found five times in this repo.
 *
 * ## How a canonical title is matched to a release name
 *
 * Both sides go through `workIdentity` from `src/lib/torrents/work-identity.ts`
 * — the same function, so the two can never disagree about what counts as the
 * same work. The catalog side has no release junk to strip, so it is given the
 * shape that function expects to see: a year for a film, an episode marker for
 * a series. That is why `"The Odyssey"` is probed as `"The Odyssey 2026"`
 * (→ `film:the odyssey:2026`) and `"House of the Dragon"` as
 * `"House of the Dragon S01E01"` (→ `series:house of the dragon`), which are
 * precisely the keys the chart's own releases produce.
 *
 * A film gets one fallback: the same name with a year within a year of the
 * catalog's. Release years and TMDB release dates disagree at the turn of a
 * year and across festival/wide-release splits often enough to matter, and the
 * consequence of a miss is a card that under-reports its swarm — while the
 * consequence of a *loose* match would be a number describing something else,
 * so nothing looser than that is allowed.
 */
import { workIdentity } from "@/lib/torrents/work-identity";
import { isSeriesMediaType, type MediaType } from "@/lib/metadata/media-type";
import type { CatalogWork } from "./works";

/** What a chart can tell us about a catalog title. Both fields, or nothing. */
export interface AvailabilitySignal {
  /**
   * The *best single release's* seeders, never a popularity sum. This number
   * is shown next to one title as a health hint, and a sum of every release of
   * a show would overstate every one of them.
   */
  peakSeeders: number;
  bestRelease: string;
}

/** Chart releases, indexed for lookup. Built once per refresh. */
export interface AvailabilityIndex {
  /** Exact `workIdentity` key → best release seen for it. */
  byKey: Map<string, AvailabilitySignal>;
  /** `film|series` + name → every work under that name, for the year fallback. */
  byName: Map<string, NamedWork[]>;
  /** How many works went in. Zero means "the charts told us nothing". */
  size: number;
}

interface NamedWork {
  year: number | null;
  signal: AvailabilitySignal;
}

/**
 * The probe key for a catalog title.
 *
 * Exported because it is also the catalog's own `workKey`: one vocabulary
 * across the whole cache means seed exclusion and cross-rail de-duplication
 * keep working, and it means a catalog row and a chart release that are the
 * same work are stored under the same key.
 *
 * Note what this is *not* used for: the display title. `workIdentity` cleans
 * release names, and run over a canonical title it can take a real word for a
 * scene group — "A Shop for Killers" comes back as "A Shop for". The key it
 * returns is opaque and never shown; the title on the card is TMDB's, verbatim.
 */
export function catalogWorkKey(
  title: string,
  year: number | null,
  mediaType: MediaType | null,
): string {
  const trimmed = title.trim();
  if (!trimmed) return "";
  if (isSeriesMediaType(mediaType)) {
    // A series' identity carries no year — its releases span years and a year
    // would split one show into several cards.
    return workIdentity(`${trimmed} S01E01`).key;
  }
  return workIdentity(year ? `${trimmed} ${year}` : trimmed).key;
}

/** Index this refresh's chart works so catalog titles can be looked up. */
export function buildAvailabilityIndex(
  works: readonly CatalogWork[],
): AvailabilityIndex {
  const byKey = new Map<string, AvailabilitySignal>();
  const byName = new Map<string, NamedWork[]>();

  for (const work of works) {
    const signal: AvailabilitySignal = {
      peakSeeders: work.peakSeeders,
      bestRelease: work.bestRelease,
    };

    // The same work can arrive from more than one feed (205 and 208 carry the
    // same shows at different resolutions). The healthiest release wins, which
    // is a maximum and never a sum.
    const existing = byKey.get(work.workKey);
    if (!existing || signal.peakSeeders > existing.peakSeeders) {
      byKey.set(work.workKey, signal);
    }

    const nameKey = nameIndexKey(work.workKey);
    if (nameKey) {
      const bucket = byName.get(nameKey);
      if (bucket) bucket.push({ year: work.year, signal });
      else byName.set(nameKey, [{ year: work.year, signal }]);
    }
  }

  return { byKey, byName, size: works.length };
}

/**
 * `film:the odyssey:2026` → `film:the odyssey`.
 *
 * The key format is `kind:name:year` for films and `kind:name` for series, and
 * a work key is documented as opaque — so this deliberately does not parse it,
 * it only drops a trailing year segment when one is there. A key shape change
 * upstream degrades this to "no fallback", never to a wrong bucket.
 */
function nameIndexKey(workKey: string): string | null {
  const cut = workKey.lastIndexOf(":");
  if (cut <= 0) return null;
  const head = workKey.slice(0, cut);
  const tail = workKey.slice(cut + 1);
  if (tail !== "" && !/^\d{4}$/.test(tail)) return null;
  return head;
}

/** How far apart two release years may be and still be the same film. */
const YEAR_SLACK = 1;

/**
 * What the charts know about one catalog title, or null.
 *
 * Null is the common and completely normal answer: TMDB's chart and a torrent
 * chart overlap, they are not the same list. A miss costs a card its seeder
 * hint. It costs it nothing else, because a card never claimed to be
 * downloadable in the first place.
 */
export function matchAvailability(
  index: AvailabilityIndex,
  workKey: string,
  year: number | null,
): AvailabilitySignal | null {
  if (!workKey) return null;

  const exact = index.byKey.get(workKey);
  if (exact) return exact;

  const nameKey = nameIndexKey(workKey);
  if (!nameKey) return null;
  const bucket = index.byName.get(nameKey);
  if (!bucket || bucket.length === 0) return null;

  let best: NamedWork | null = null;
  for (const candidate of bucket) {
    // An unknown year on either side is not evidence of a different film, and
    // series carry no year at all by design.
    const comparable =
      year === null ||
      candidate.year === null ||
      Math.abs(candidate.year - year) <= YEAR_SLACK;
    if (!comparable) continue;
    if (!best || candidate.signal.peakSeeders > best.signal.peakSeeders) {
      best = candidate;
    }
  }

  return best?.signal ?? null;
}

/** An empty index, for when the charts were unreachable. Matches nothing. */
export function emptyAvailabilityIndex(): AvailabilityIndex {
  return { byKey: new Map(), byName: new Map(), size: 0 };
}
