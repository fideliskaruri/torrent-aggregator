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
  /** Opaque work key from `groupReleasesByWork`. Stable React key. */
  key: string;
  /** Display name (catalog spelling when it agrees, else the release name). */
  name: string;
  /** Film year; always null for series. */
  year: number | null;
  isSeries: boolean;
  /** Catalog media type ("movie" | "tv" | "anime"), when known. */
  mediaType: string | null;
  posterUrl: string | null;
  /** Primary / first-air date that drives future-gating, when trusted. */
  releaseDate: string | null;
  /** The single source of truth for "is this out yet?". */
  status: ReleaseStatus;
  /** Title-page href, or null when there is nothing to open. */
  href: string | null;
  /** The top-ranked release — what Play/Download act on from the card. */
  best: TorrentResult;
  /** Every release for this work, still in server rank order. */
  releases: TorrentResult[];
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
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const LEADING_ARTICLE = /^(?:the|a|an) /;

/**
 * How well `name` answers `query`; lower is a better match. A leading article
 * ("The") is ignored for the exact/prefix decision so "The Odyssey" still counts
 * as an exact hit for the query "odyssey", and vice versa.
 */
function queryRelevanceTier(query: string, name: string): number {
  const q = normalizeForMatch(query);
  if (!q) return 5;
  const n = normalizeForMatch(name);
  const qBare = q.replace(LEADING_ARTICLE, "");
  const nBare = n.replace(LEADING_ARTICLE, "");
  if (n === q || nBare === qBare) return 0; // exact (article-insensitive)
  if (n.startsWith(q) || nBare.startsWith(qBare)) return 1; // prefix
  const phrase = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^| )${phrase}(?: |$)`).test(n)) return 2; // whole-word span
  if (n.includes(q)) return 3; // substring anywhere
  const tokens = qBare.split(" ").filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => n.includes(token))) return 4;
  return 5;
}
