/**
 * Collapse a rank-ordered release list into one card per *work*.
 *
 * Search used to render ~163 raw torrent rows — the same film five times, one
 * per encode. The product is title-centric: a query yields one clickable card
 * per movie or series, best match first, releases hidden behind an expander.
 *
 * Identity is not re-derived here. `groupReleasesByWork` already answers "which
 * film or series is this release?" (including the hard Dune/Breaking-Bad rules)
 * and emits groups in the order their best-ranked release appeared — so the
 * work the user most likely meant stays first without a second relevance pass.
 * This module only turns each group into the shape a card needs: a title-page
 * href, a poster, and — the one judgement call — whether the work is out yet.
 *
 * Pure and DOM-free so `group-titles.test.ts` can drive it as a table.
 */
import type { MediaMetadata, TorrentResult } from "@/lib/torrents/types";
import {
  catalogAgrees,
  groupReleasesByWork,
} from "@/lib/torrents/work-identity";
import { releaseStatus, type ReleaseStatus } from "@/lib/browse/release-status";
import { titleHrefForName } from "@/components/title/work-key";

export interface TitleResult {
  /** Opaque work key. Stable React key. */
  key: string;
  /** Display name (catalog spelling). */
  name: string;
  /** Film year when known; series may still carry a first-air year for display. */
  year: number | null;
  isSeries: boolean;
  /** Catalog media type ("movie" | "tv" | "anime"), when known. */
  mediaType: string | null;
  /** Provider format such as MOVIE, TV, ONA or OVA, when known. */
  format?: string | null;
  posterUrl: string | null;
  /** Primary / first-air date that drives future-gating, when trusted. */
  releaseDate: string | null;
  /** The single source of truth for "is this out yet?". */
  status: ReleaseStatus;
  /** Title-page href, or null when there is nothing to open. */
  href: string | null;
  /** One-line synopsis when the catalog has one. */
  overview?: string | null;
  /**
   * Legacy torrent fields — only filled by `groupTitles` (indexer path).
   * Catalog search never sets these; the title page owns torrent matching.
   */
  best?: TorrentResult;
  releases?: TorrentResult[];
}

/**
 * Only metadata from a release whose catalog title *agrees* with the group
 * name may speak for the work. This is the same one-directional rule that
 * governs which release may lend its poster: a row we only suspect belongs
 * here must not decide the work's release date and gray out a card that is
 * actually available today.
 */
function trustedMetadata(
  name: string,
  releases: readonly TorrentResult[],
): MediaMetadata | null {
  for (const release of releases) {
    const meta = release.metadata;
    if (meta && catalogAgrees(name, meta.title ?? "")) return meta;
  }
  return null;
}

/**
 * Group ranked releases into title cards.
 *
 * `now` is injectable so the future-gating decision is testable without
 * mocking the clock.
 *
 * When `query` is given, the grouped cards are stable-sorted by how well each
 * work's *name* answers that query — exact/prefix matches first, then
 * whole-word, then substring. Release rank (seeders/quality) is the wrong
 * signal for "which title did the user mean": a well-seeded tangential release
 * ("Maelstrom: The Odyssey of Waterworld") otherwise outranks the exact-name
 * match ("The Odyssey"). Ordering within a relevance tier is left at release
 * rank, so this restores "best matching on top" without touching the release
 * ranking itself. Omitting `query` preserves the original server order.
 */
export function groupTitles(
  results: readonly TorrentResult[],
  now: Date = new Date(),
  query?: string,
): TitleResult[] {
  const groups = groupReleasesByWork(
    results,
    (t) => t.title,
    (t) => t.metadata,
  );

  const titles = groups.map((group) => {
    const meta = trustedMetadata(group.name, group.items);
    const releaseDate = meta?.releaseDate ?? null;
    const status = releaseStatus(releaseDate, now);
    const mediaType =
      meta?.mediaType ?? (group.isSeries ? "tv" : "movie");
    const href = titleHrefForName(group.name, {
      mediaType,
      season: null,
    });

    return {
      key: group.key,
      name: group.name,
      year: group.year,
      isSeries: group.isSeries,
      mediaType,
      posterUrl: group.posterUrl,
      releaseDate,
      status,
      href,
      best: group.items[0],
      releases: group.items,
    };
  });

  if (!query || !query.trim()) return titles;

    // Stable sort: relevance tier first; within a tier prefer the card that
    // actually looks like a title (has a year, then a poster) over a bare name
    // with no metadata; original release-rank index is the final tiebreak.
    return titles
      .map((title, index) => ({
        title,
        index,
        tier: queryRelevanceTier(query, title.name),
        richness: titleRichness(title),
      }))
      .sort(
        (a, b) =>
          a.tier - b.tier || b.richness - a.richness || a.index - b.index,
      )
      .map((entry) => entry.title);
  }

  /** Higher = more complete card. Year beats poster: a year alone names the film. */
  function titleRichness(title: TitleResult): number {
    let score = 0;
    if (title.year != null) score += 2;
    if (title.posterUrl) score += 1;
    return score;
  }

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactForMatch(value: string): string {
  return normalizeForMatch(value).replace(/ /g, "");
}

const LEADING_ARTICLE = /^(?:the|a|an) /;
const MIN_FUZZY_LENGTH = 5;
const MAX_FUZZY_QUERY_LENGTH = 64;
const MAX_FUZZY_CANDIDATE_LENGTH = 96;

function boundedDamerauLevenshtein(
  left: string,
  right: string,
  maxDistance: number,
): number | null {
  const a = Array.from(left);
  const b = Array.from(right);
  if (Math.abs(a.length - b.length) > maxDistance) return null;

  const rows = Array.from(
    { length: a.length + 1 },
    () => new Map<number, number>(),
  );
  rows[0].set(0, 0);
  for (let j = 1; j <= Math.min(b.length, maxDistance); j += 1) {
    rows[0].set(j, j);
  }

  for (let i = 1; i <= a.length; i += 1) {
    const row = rows[i];
    const start = Math.max(1, i - maxDistance);
    const end = Math.min(b.length, i + maxDistance);
    if (start === 1 && i <= maxDistance) row.set(0, i);

    for (let j = start; j <= end; j += 1) {
      const same = a[i - 1] === b[j - 1];
      let distance = Math.min(
        (rows[i - 1].get(j) ?? Infinity) + 1,
        (row.get(j - 1) ?? Infinity) + 1,
        (rows[i - 1].get(j - 1) ?? Infinity) + (same ? 0 : 1),
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        distance = Math.min(
          distance,
          (rows[i - 2].get(j - 2) ?? Infinity) + 1,
        );
      }
      if (distance <= maxDistance) row.set(j, distance);
    }
  }

  return rows[a.length].get(b.length) ?? null;
}

function fuzzyDistance(query: string, name: string): number | null {
  const qCompact = compactForMatch(query);
  const nCompact = compactForMatch(name);
  const queryLength = Array.from(qCompact).length;
  const candidateLength = Array.from(nCompact).length;
  if (
    queryLength < MIN_FUZZY_LENGTH ||
    candidateLength < MIN_FUZZY_LENGTH ||
    queryLength > MAX_FUZZY_QUERY_LENGTH ||
    candidateLength > MAX_FUZZY_CANDIDATE_LENGTH
  ) {
    return null;
  }

  const maxDistance = Math.min(
    2,
    Math.max(1, Math.floor(queryLength / 6)),
  );
  return boundedDamerauLevenshtein(qCompact, nCompact, maxDistance);
}

/**
 * How well `name` answers `query`; lower is a better match. A leading article
 * ("The") is ignored for the exact/prefix decision so "The Odyssey" still counts
 * as an exact hit for the query "odyssey", and vice versa.
 *
 * Exported because the TMDB title search (`/api/search/titles`) must rank by
 * the same rule. TMDB returns by its own popularity, which put *Stargate
 * Atlantis* above the exact-title *Atlantis* for the query "atlantis". One
 * implementation, two callers — a second copy would drift.
 */
export function queryRelevanceTier(query: string, name: string): number {
  const q = normalizeForMatch(query);
  if (!q) return 6;
  const n = normalizeForMatch(name);
  const qCompact = compactForMatch(query);
  const nCompact = compactForMatch(name);
  const qBare = q.replace(LEADING_ARTICLE, "");
  const nBare = n.replace(LEADING_ARTICLE, "");
  const nBareCompact = compactForMatch(nBare);
  const qBareCompact = compactForMatch(qBare);
  if (n === q || nBare === qBare) {
    return 0; // exact (article-insensitive)
  }
  if (
    n.startsWith(q) ||
    nBare.startsWith(qBare) ||
    nCompact === qCompact ||
    nBareCompact === qBareCompact ||
    nCompact.startsWith(qCompact) ||
    nBareCompact.startsWith(qBareCompact)
  ) {
    return 1; // prefix
  }
  const phrase = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^| )${phrase}(?: |$)`).test(n)) return 2; // whole-word span
  if (n.includes(q)) return 3; // substring anywhere
  const tokens = qBare.split(" ").filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => n.includes(token))) return 4;
  if (fuzzyDistance(query, name) != null) return 5;
  return 6;
}
