/**
 * Shared types for the grab pipeline.
 *
 * Three callers (automation, rules, on-demand) share the same pipeline shape:
 * search → rank → viability → resolve path → send → record history → advance.
 * They genuinely differ in how each stage is configured, and those differences
 * are modelled here as explicit hooks and options — not as `if (kind)` branches
 * inside the pipeline.
 */
import type { PrismaClient } from "@prisma/client";
import type { TorrentResult, TorrentSourceId } from "@/lib/torrents/types";
import type { AddTorrentPayload, ClientConnectionConfig, TorrentPurpose } from "@/lib/clients/types";
import type { StorageOverrideFacts } from "@/lib/library/storage-override";

/**
 * The Prisma transaction client passed into post-send hooks.
 *
 * This is the `tx` inside `prisma.$transaction(async (tx) => { ... })` — it
 * supports every model method but NOT `$transaction`, `$connect`, etc.
 * Hooks MUST use this handle (not the top-level prisma) for their writes,
 * so that GrabJob + DownloadHistory + cursor advance / rule state commit
 * atomically. No network calls inside the transaction — only DB writes.
 */
export type TxClient = Parameters<
  Parameters<PrismaClient["$transaction"]>[0]
>[0];

// ---------------------------------------------------------------------------
// Search configuration
// ---------------------------------------------------------------------------

export type PipelineSearchOptions = {
  query: string;
  category: "all" | "anime" | "movies" | "tv" | "music" | "apps" | "games";
  limit: number;
  sources?: TorrentSourceId[];
  /** Resolve catalog metadata for category verification (rules need this). */
  enrich: boolean;
  /** Use background indexer budget (scheduled work, not a human waiting). */
  background: boolean;
  /** Bypass the search cache. */
  skipCache: boolean;
  /** Per-title ranking target; null/undefined uses the global setting. */
  targetResolution?: number | null;
  filters: {
    hasMagnet: boolean;
    minSeeders?: number;
    maxSizeBytes?: number;
    resolution?: string;
    season?: number;
    episode?: number;
  };
};

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Hook the caller provides to pick the best result from search results.
 *
 * Automation picks the exact cursor episode; rules pick the first
 * category-matching result; on-demand picks the exact season/episode.
 * Returning null means "no viable candidate".
 */
export type SelectCandidate = (
  results: TorrentResult[],
) => TorrentResult | null;

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Hook that checks whether a candidate has already been grabbed.
 * Returns a skip reason string when the release is a duplicate, or null
 * when it should proceed.
 */
export type CheckDuplicate = (
  candidate: TorrentResult,
) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Viability gate
// ---------------------------------------------------------------------------

export type ViabilityDecision =
  | { proceed: true }
  | { proceed: false; deferred: true; message: string }
  | { proceed: false; deferred: false; message: string };

/**
 * Hook that decides whether a candidate is healthy enough to grab now.
 *
 * Automation has the full seeder-wait / 6h escape-hatch logic.
 * Rules and on-demand apply simpler gates.
 * Returning `{ proceed: true }` means "grab it".
 * `deferred: true` means "not a miss — hold the cursor".
 */
export type CheckViability = (
  candidate: TorrentResult,
) => Promise<ViabilityDecision>;

// ---------------------------------------------------------------------------
// Storage budget
// ---------------------------------------------------------------------------

export type StorageBudgetCheck = (
  candidate: TorrentResult,
  target: { savePath: string | null; category: string | null },
) => Promise<
  | { ok: true }
  | {
      ok: false;
      message: string;
      /**
       * Which limit refused and whether the owner may knowingly override it.
       * Carried up so the caller can offer a real choice instead of a dead end;
       * the pipeline itself never interprets it.
       */
      storage?: StorageOverrideFacts | null;
    }
>;

// ---------------------------------------------------------------------------
// Smart path resolution
// ---------------------------------------------------------------------------

export type ResolveTarget = (
  config: ClientConnectionConfig,
  candidate: TorrentResult,
) => { category: string | null; savePath: string | null };

// ---------------------------------------------------------------------------
// Post-send hooks — run INSIDE the Prisma transaction
// ---------------------------------------------------------------------------

/**
 * Called inside the transaction after a successful send.
 *
 * The `tx` handle is the Prisma interactive-transaction client. All writes
 * (cursor advance, rule state update, etc.) MUST go through `tx` so they
 * commit atomically with GrabJob + DownloadHistory. If any write throws,
 * the entire transaction rolls back — GrabJob, DownloadHistory, and the
 * caller's own state are left exactly as before the attempt.
 *
 * **No network calls inside this hook.** The external send already happened
 * before the transaction opened.
 */
export type OnGrabSuccess = (
  tx: TxClient,
  candidate: TorrentResult,
  target: { category: string | null; savePath: string | null },
  sendMessage: string,
) => Promise<void>;

/**
 * Called inside the transaction after a failed send.
 *
 * Same atomicity guarantees as `OnGrabSuccess`. The caller should record
 * the failure (e.g. mark client offline in summary state), but must NOT
 * advance a cursor — the episode was not grabbed.
 */
export type OnGrabFailure = (
  tx: TxClient,
  candidate: TorrentResult,
  target: { category: string | null; savePath: string | null },
  sendMessage: string,
  offline: boolean,
) => Promise<void>;

/**
 * Called when no viable candidate was found (miss / skip).
 * NOT inside a transaction — these are standalone writes.
 * Automation uses this to record hunt misses and count them toward
 * season rollover.
 */
export type OnNoCandidateReason =
  | "no_results"
  | "no_match"
  | "below_resolution_floor"
  | "duplicate"
  | "deferred"
  | "not_viable";

export type OnNoCandidate = (
  reason: OnNoCandidateReason,
  message: string,
  candidate: TorrentResult | null,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Pipeline options (the full configuration object a caller builds)
// ---------------------------------------------------------------------------

export type GrabPipelineOptions = {
  userId: string;
  /** Canonical parent for durable history written by this acquisition. */
  workId?: string | null;
  search: PipelineSearchOptions;
  config: ClientConnectionConfig;
  selectCandidate: SelectCandidate;
  checkDuplicate?: CheckDuplicate;
  checkViability?: CheckViability;
  checkStorageBudget?: StorageBudgetCheck;
  resolveTarget: ResolveTarget;
  /** Title for GrabJob / DownloadHistory when no candidate is selected. */
  fallbackTitle: string;
  /** GrabJob.kind — "library" | "rule" | "ondemand" */
  grabJobKind: string;
  /** GrabJob.externalId — watchlist item id or rule id */
  externalId: string | null;
  /**
   * REQUIRED acquisition intent for the client send. Threaded to the engine so
   * a Play (`stream`) can never be born as, or recorded as, a permanent
   * download — the exact defect this pipeline used to have when it omitted any
   * stream signal. Also stamped onto GrabJob/DownloadHistory so Activity and
   * "Recently Added" can exclude ephemeral streams.
   */
  purpose: TorrentPurpose;
  /**
   * Hard minimum for kept downloads. A selected release below this height, or
   * one whose name does not state a resolution, is refused before any send.
   */
  minimumResolution?: number | null;
  /**
   * Prefix for the DownloadHistory message, e.g. "Library automation" or
   * "Auto-rule: Weekly anime". Defaults to a label derived from grabJobKind.
   */
  downloadHistoryPrefix?: string;
  /** Extra payload fields for the client send (e.g. built-in connect-only prewarm). */
  addPayload?: Partial<AddTorrentPayload>;
  /**
   * Human-readable message when selectCandidate returns null.
   * Defaults to a generic "No matching release in N results" / "No matching
   * torrents". Rules use this to say "No anime releases in 42 results";
   * on-demand uses "No matching S01E05 release".
   *
   * `sources` is the per-source outcome of the search that just ran. It is
   * passed so a caller can tell "the indexers answered and had nothing" apart
   * from "every indexer failed" — reporting the second as the first is how a
   * blocked mirror looks like a film that does not exist.
   */
  noMatchMessage?: (
    resultCount: number,
    sources?: readonly { id: string; count: number; error?: string }[],
  ) => string;
  /** Called inside the transaction after successful send + DB writes. */
  onSuccess?: OnGrabSuccess;
  /** Called inside the transaction after failed send. */
  onFailure?: OnGrabFailure;
  /** Called when no candidate is viable (outside any transaction). */
  onNoCandidate?: OnNoCandidate;
  /**
   * Override the search function (for testing). Defaults to `searchTorrents`.
   */
  _searchFn?: typeof import("@/lib/torrents/aggregator").searchTorrents;
  /**
   * Override the send function (for testing). Defaults to `sendToClient`.
   */
  _sendFn?: typeof import("@/lib/clients").sendToClient;
  /**
   * Override the Prisma client (for testing). Defaults to the real Prisma.
   */
  _prisma?: typeof import("@/lib/prisma").default;
};

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export type GrabPipelineResult = {
  status: "sent" | "failed" | "skipped" | "already_active";
  /** Human-readable summary. */
  message: string;
  candidate: TorrentResult | null;
  target: { category: string | null; savePath: string | null } | null;
  /** Whether the torrent client appeared offline. */
  offline: boolean;
  /** Set only when a storage limit refused the grab. @see StorageBudgetCheck */
  storage?: StorageOverrideFacts | null;
};
