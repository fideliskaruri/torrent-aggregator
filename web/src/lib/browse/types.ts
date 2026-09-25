/**
 * Browse data-layer types — the single source of truth for the home page.
 *
 * Another agent builds the UI directly against these types. Every field a card
 * needs must be here; the UI must never call the torrent engine or re-parse
 * release names to render a rail.
 */

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * The four concrete states a playable thing can be in, plus `null` meaning
 * "not yet determined".
 *
 * - `ready`       — fully downloaded, plays instantly.
 * - `warm`        — partially downloaded / actively streaming.
 * - `fetchable`   — not local, but a viable release exists on indexers.
 * - `unavailable` — we checked and found nothing viable.
 * - `null`        — not yet determined (e.g. no cached search). The UI should
 *                   render a neutral affordance, not a disabled control.
 *
 * `unavailable` is a **claim** — it means we actively checked and found
 * nothing. `null` means we have not checked the expensive path (indexer
 * search) and cannot make that claim. Confusing the two hides a Play button
 * for content that may well be sitting on disk or available online.
 */
export type AvailabilityState = "ready" | "warm" | "fetchable" | "unavailable";

// ---------------------------------------------------------------------------
// Playback progress (POST / GET /api/progress)
// ---------------------------------------------------------------------------

/** Body accepted by `POST /api/progress`. */
export interface ProgressUpdateBody {
  infoHash: string;
  filePath: string;
  positionSec: number;
  durationSec: number;
  title: string;
  season?: number | null;
  episode?: number | null;
  posterUrl?: string | null;
  watchListItemId?: string | null;
}

/** A single row returned by `GET /api/progress`. */
export interface ProgressEntry {
  id: string;
  workId?: string | null;
  workKey?: string | null;
  infoHash: string;
  filePath: string;
  positionSec: number;
  durationSec: number | null;
  /** 0–1 fraction of the file watched. */
  fraction: number;
  completedAt: string | null;
  title: string;
  season: number | null;
  episode: number | null;
  posterUrl: string | null;
  watchListItemId: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Rail items and rails
// ---------------------------------------------------------------------------

/** A single card in a rail. Carries everything the UI needs to render. */
export interface RailItem {
  /** Stable identifier (PlaybackProgress id, EngineTorrent id, WatchListItem id, etc.). */
  id: string;
  /** Canonical logical parent. Null only for legacy/unresolved rows. */
  workId?: string | null;
  /** Canonical title route key; never re-derived from a torrent when present. */
  workKey?: string | null;
  title: string;
  /** E.g. "S02E07" or "Season 3 Pack". */
  subtitle: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  availability: AvailabilityState | null;
  /** 0–1 watch progress fraction (Continue Watching / Ready to Play). */
  progressFraction: number | null;
  /** Resume position in seconds (Continue Watching). */
  resumePositionSec: number | null;
  /** Info hash for playback navigation. */
  infoHash: string | null;
  /** File path inside the torrent (Continue Watching). */
  filePath: string | null;
  /** WatchListItem id for library / next-up navigation. */
  watchListItemId: string | null;
  /** Media type for routing (anime | tv | movie). */
  mediaType: string | null;
  /**
   * Primary release / first-air date (ISO string) when known. Drives
   * future-gating: a card whose releaseDate is in the future is grayed and
   * labelled "Coming {date}", never offered as a dead Play/Download. Null =
   * unknown, which is never gated. See src/lib/browse/release-status.ts.
   */
  releaseDate?: string | null;
  /**
   * True when this is a movie that has had a theatrical release but no past
   * home release (Digital/Physical/TV). When set, the card shows "In cinemas"
   * instead of a Play/Download action, mirroring the title-page treatment.
   *
   * Populated from persisted Browse home-release evidence. Undefined/false
   * means unknown — never gate on this.
   */
  inTheatricalWindow?: boolean;
  /** Earliest known upcoming Digital/Physical/TV date for the cinema chip. */
  nextHomeReleaseAt?: string | null;
  /**
   * One-paragraph synopsis of the work, when the catalog has one.
   *
   * Optional so rails that have no synopsis to give (Continue Watching, Ready
   * to Play) need not invent one. The hero prefers this over any status copy:
   * a hero paragraph should describe the film, not the downloader.
   */
  overview?: string | null;
  /** Season number, if applicable. */
  season: number | null;
  /** Episode number, if applicable. */
  episode: number | null;
}

/** One horizontal rail on the home page. */
export interface Rail {
  /** Machine-readable rail key. */
  id: string;
  /** Human-readable title shown above the rail. */
  title: string;
  items: RailItem[];
}

/** The complete browse payload — one round trip from `GET /api/browse`. */
export interface BrowsePayload {
  rails: Rail[];
  /** ISO timestamp of when this payload was assembled. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Completion threshold
// ---------------------------------------------------------------------------
