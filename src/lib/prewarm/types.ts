/**
 * Shared types for the pre-warm subsystem.
 *
 * Two features live under `src/lib/prewarm/`:
 *
 *   A. **Pre-ranking** (`prerank.ts`) — decide *which release* to grab before
 *      the user asks, so "Download" is one fast action instead of a live search.
 *   B. **Pre-warming** (`prewarm.ts`) — actually start fetching the next
 *      episode once ~15% of the current one has been watched.
 *
 * Both are speculative. Nothing in here may present itself as a user action,
 * and nothing in here may make a claim it has not checked.
 */
import type { CatalogSearchCategory } from "@/lib/metadata/media-type";
import type { TorrentResult } from "@/lib/torrents/types";

/** `EngineTorrent.origin` values. Only `prewarm` rows may ever be evicted. */
export const PREWARM_ORIGIN = "prewarm";
/** The default — an explicit, user-requested grab. Never evictable. */
export const USER_ORIGIN = "user";

/** `GrabJob.kind` for a speculative grab, so Activity can label it honestly. */
export const PREWARM_GRAB_KIND = "prewarm";

/**
 * A thing we might want to have ready.
 *
 * `season` / `episode` are optional because pre-ranking is useful for films
 * and for a bare title on screen, not only for the next episode of a series.
 */
export interface PreRankTarget {
  /** Show or film title — a *work* name, never a raw release name. */
  title: string;
  /** Raw media type as stored (`anime` / `tv` / `movie` / …). */
  mediaType?: string | null;
  season?: number | null;
  episode?: number | null;
}

/**
 * The outcome of pre-ranking one target.
 *
 * `candidate: null` is a **determined** answer — we looked at a real result
 * pool and nothing in it was usable. That is different from `preRank()` /
 * `getPreRanked()` returning `null`, which means *not yet determined*. The
 * distinction is the same one the availability model draws between
 * `"unavailable"` and `null`, and it exists for the same reason: a claim has
 * to be earned.
 */
export interface PreRankedChoice {
  /** Memo key — opaque, do not parse. */
  key: string;
  /** The exact query string the grab will search with. */
  query: string;
  /** `normalizeTitle(title)` — the SearchCache lookup column. */
  normalizedQuery: string;
  category: CatalogSearchCategory;
  season: number | null;
  episode: number | null;
  /** Chosen release, or null when the pool held nothing usable. */
  candidate: TorrentResult | null;
  /** Size of the pool the choice was made from. */
  resultCount: number;
  /** Where the answer came from. `search` means we paid for it just now. */
  source: "memo" | "search-cache" | "search";
  rankedAt: number;
  expiresAt: number;
}

/** The episode a pre-warm would fetch, and how we worked that out. */
export interface NextEpisode {
  /** Show title (work name), suitable for an episode search query. */
  title: string;
  mediaType: string | null;
  season: number;
  episode: number;
  watchListItemId: string | null;
  /**
   * `playing-episode` — one past whatever is on screen (the high-hit-rate case).
   * `hunt-cursor`     — the library's own next-wanted episode.
   */
  source: "playing-episode" | "hunt-cursor";
}

export type PrewarmStatus =
  /** A speculative grab was sent to the client. */
  | "sent"
  /** Deliberately did nothing. See `reason`. */
  | "skipped"
  /** Tried and failed. Logged, never surfaced. */
  | "failed"
  /** Nothing to pre-warm — not an error and not a skip worth counting. */
  | "not-applicable";

export type PrewarmReason =
  | "sent"
  | "below-trigger"
  | "no-next-episode"
  | "no-client"
  /**
   * The client cannot give us a row to label. Without an `EngineTorrent` row
   * carrying `origin: "prewarm"` a speculative download is indistinguishable
   * from one the user asked for and can never be evicted — so we do not start
   * one.
   */
  | "unlabelable-client"
  | "cooldown"
  | "in-flight"
  | "at-concurrency-cap"
  /**
   * The torrent being watched is still fetching a lot of itself. Speculation
   * must not race the foreground for bandwidth.
   */
  | "foreground-busy"
  /**
   * The episode on screen is a stream-only torrent, so the user is streaming,
   * not downloading. The next-episode pre-warm is itself a download and must
   * not shadow a stream — it only continues a download the user chose (a kept
   * grab or a season pack).
   */
  | "streaming-source"
  | "already-held"
  | "not-determined"
  | "no-release"
  | "no-space"
  | "send-failed"
  | "error";

export interface PrewarmOutcome {
  status: PrewarmStatus;
  reason: PrewarmReason;
  /** Diagnostic text for the server log. Never rendered as a user error. */
  message: string;
  next: NextEpisode | null;
  title: string | null;
  infoHash: string | null;
  /**
   * True when the release had already been chosen before this grab ran —
   * i.e. pre-ranking did its job.
   */
  preRanked: boolean;
  /**
   * True when the grab's own search was served from the search cache rather
   * than an indexer fan-out. This is the measurable form of "fast path".
   */
  fastPath: boolean;
  /**
   * True when the resulting `EngineTorrent` row was actually stamped
   * `origin: "prewarm"`. A `sent` outcome with `labelled: false` means a
   * speculative download exists that eviction cannot reclaim — report it, do
   * not pretend it did not happen.
   */
  labelled: boolean;
  evictedCount: number;
  freedBytes: number;
}

/** One `EngineTorrent` row considered for LRU eviction. */
export interface EvictionCandidate {
  id: string;
  hash: string;
  name: string;
  origin: string;
  sizeBytes: number;
  progress: number;
  status: string;
  lastUsedAt: Date;
}

export interface EvictionResult {
  evicted: EvictionCandidate[];
  freedBytes: number;
  neededBytes: number;
  /** Did we free at least `neededBytes`? */
  satisfied: boolean;
  /** Rows deliberately left alone, with the reason. */
  skipped: Array<{ hash: string; reason: string }>;
}
