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
import type { TorrentResult } from "@/lib/torrents/types";
import { type ReleaseStatus } from "@/lib/browse/release-status";


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

  