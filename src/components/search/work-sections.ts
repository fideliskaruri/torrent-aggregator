/**
 * How one work's releases are arranged: season sections, then a quality ladder.
 *
 * This logic used to live inline in `search-results.tsx` and ran **once over
 * the whole page**, which is what made a "dune" search put *Dune: Prophecy*
 * episodes and *Children of Dune* episodes in the same "S01" tab. The fix is
 * not to special-case Dune — it is that seasons and qualities are only
 * meaningful *within a single work*, so this module takes the releases of one
 * work and nothing else. Callers run it per {@link WorkGroup}; there is no way
 * to express the old page-wide question with it.
 *
 * Pure and DOM-free: `work-sections.test.ts` drives it as a table.
 */
import { parseResolution } from "@/lib/torrents/quality";

/** The shape this module needs from a release. Deliberately structural. */
export interface SectionableRelease {
  title: string;
  episode?: {
    season?: number;
    episode?: number;
    isBatch: boolean;
    isSeasonPack: boolean;
    isMultiSeason?: boolean;
  };
}

export interface Section<T> {
  /** Stable within one work. Namespace it before using it as a DOM id. */
  key: string;
  /** Full name, for tooltips and accessible names. */
  label: string;
  /** Tab text. */
  short: string;
  items: T[];
}

/**
 * Split one work's releases into season sections.
 *
 * Newest season first: the reason to search a running show is almost always
 * the latest season, and ordering ascending buried it under the back
 * catalogue. Multi-season ranges (`S01-S05`) are never filed under a single
 * season — they would claim to be a season they only partly contain.
 *
 * Returns a single "Results" section when there is no season structure to
 * show, so callers always have something to render and only have to decide
 * whether a *switcher* is worth drawing (`sections.length > 1`).
 */
export function buildSections<T extends SectionableRelease>(
  items: readonly T[],
  { includeSeasons }: { includeSeasons: boolean },
): Section<T>[] {
  const complete: T[] = [];
  const bySeason = new Map<number, T[]>();
  const other: T[] = [];

  for (const t of items) {
    const season = t.episode?.season;
    if (includeSeasons && season != null && !t.episode?.isMultiSeason) {
      const list = bySeason.get(season) ?? [];
      list.push(t);
      bySeason.set(season, list);
    } else if (includeSeasons && (t.episode?.isBatch || t.episode?.isSeasonPack)) {
      complete.push(t);
    } else {
      other.push(t);
    }
  }

  const sections: Section<T>[] = [];
  if (complete.length) {
    sections.push({
      key: "complete",
      label: "Complete series",
      short: "Complete",
      items: complete,
    });
  }
  for (const season of [...bySeason.keys()].sort((a, b) => b - a)) {
    sections.push({
      key: `s${season}`,
      label: `Season ${season}`,
      short: `S${String(season).padStart(2, "0")}`,
      items: bySeason.get(season)!,
    });
  }
  if (other.length) {
    sections.push({
      key: "other",
      label: sections.length ? "Everything else" : "Results",
      short: sections.length ? "Other" : "Results",
      items: other,
    });
  }
  return sections;
}

/** How many distinct numbered seasons a work's sections cover. */
export function seasonCount<T>(sections: readonly Section<T>[]): number {
  return sections.filter((s) => /^s\d+$/.test(s.key)).length;
}

/**
 * Which section opens first.
 *
 * Ranking order looks like the principled answer but is not: on a bare "the
 * bear" search the top-ranked release happened to be a season 1 rip, so the
 * page opened on the oldest season. What the user meant is in the query
 * itself — and when the query names no season, the reason to search a running
 * show is almost always the newest one.
 */
export function defaultSectionKey<T>(
  sections: readonly Section<T>[],
  query: string,
): string | null {
  const asked = /\bs(?:eason)?\s*0*(\d{1,3})\b/i.exec(query)?.[1];
  const askedKey = asked ? `s${parseInt(asked, 10)}` : null;
  return (
    (askedKey && sections.find((s) => s.key === askedKey)?.key) ??
    sections.find((s) => s.key.startsWith("s"))?.key ??
    sections[0]?.key ??
    null
  );
}

export interface QualityGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * Collapse a section to one row per resolution, in a fixed descending ladder.
 *
 * Twenty rows is not a choice, it is homework: the only decision the user is
 * actually making is *which quality*, and everything below the best 1080p is a
 * near-duplicate of it. The ladder is fixed rather than rank-ordered so it sits
 * in the same place on every search. Nothing is dropped — the caller discloses
 * the runners-up behind an honestly-counted toggle.
 *
 * Returns null when there is nothing to compare: a ladder of one rung is a
 * header over the whole list, which is noise.
 */
export function qualityLadder<T extends { title: string }>(
  items: readonly T[],
): QualityGroup<T>[] | null {
  if (!items.length) return null;

  const buckets = new Map<number, T[]>();
  for (const t of items) {
    // 0 stands for "no resolution in the title" — real, and not a failure.
    const res = parseResolution(t.title) ?? 0;
    const list = buckets.get(res) ?? [];
    list.push(t);
    buckets.set(res, list);
  }
  if (buckets.size < 2) return null;

  return [...buckets.keys()]
    .sort((a, b) => b - a)
    .map((res) => ({
      key: `q${res}`,
      label: res ? `${res}p` : "Unlabelled quality",
      items: buckets.get(res)!,
    }));
}

/**
 * The line under a work's name: seasons and an honest release count.
 *
 * The count is of *this work's* releases on this page, which is exactly the
 * number of rows the card contains — unlike the header it replaces, which
 * reported the whole page's size under one work's name.
 *
 * The year is deliberately not here. For a film it is part of identity (*Dune*
 * 1984 and *Dune* 2021 are different films), so it belongs in the heading
 * beside the name rather than in a metadata line; and a series has none at all,
 * because its releases disagree about it.
 */
export function workSubtitle({
  seasons,
  releaseCount,
}: {
  seasons: number;
  releaseCount: number;
}): string {
  return [
    seasons > 1 ? `${seasons} seasons` : null,
    `${releaseCount.toLocaleString()} ${releaseCount === 1 ? "release" : "releases"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
