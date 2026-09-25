/**
 * The storage gate every send passes through — and the one place the product
 * rule about Play lives.
 *
 * ## The rule
 *
 * A storage cap is a bound on how much media the app *keeps*. It was never
 * meant to be a wall in front of watching something, because the stream cache
 * is reclaimable by design: pressing Play is exactly the moment the app is
 * allowed to throw away a finished stream or a stalled allocation to make room.
 *
 *   - **Play** (`retention: "stream"`) → reclaim first, then proceed. Refused
 *     only when reclamation genuinely could not free enough, and then the
 *     message says what actually happened.
 *   - **Download** (`retention: "keep"`) → the cap applies. A kept file is not
 *     cache; asking for one more permanent file when the shelf is full is a
 *     request the app should refuse.
 *
 * The measured failure this replaces: eight torrents stuck at 0% progress held
 * 36.8 GB against a 20 GB cap, nothing was reclaimable, and *every* Play was
 * refused with copy pointing at a Settings tab that does not exist.
 *
 * ## Why it lives here rather than in each caller
 *
 * There are several send paths (on-demand ladder, direct send route, season
 * acquire, automation). If each re-implemented "when is a refusal correct?"
 * they would drift, and Play would work from one surface and not another. This
 * module is the seam; the callers supply facts, not policy.
 *
 * Reclamation runs *only* through `sweepRetentionCache` (via `reclaimForBytes`),
 * so every existing guard — kept/user origin, watchlist references, unfinished
 * watch positions, the foreground stream, the claim lease and its re-check —
 * still applies. There is no second delete path.
 */
import type { ClientConnectionConfig } from "@/lib/clients/types";
import type { SendRetention } from "@/lib/streaming/send-retention";
import {
  assertStorageBudget,
  formatBytesShort,
  resetDirectorySizeCache,
  type StoragePolicyResult,
} from "./disk-space";
import { reclaimForBytes, type RetentionSweepResult } from "./retention-sweep";
import {
  isOverridableLimit,
  storageOverrideFacts,
  type StorageOverrideFacts,
} from "./storage-override";

/** Facts a refusal must carry so the caller can offer an informed choice. */
function refusalFacts(
  space: Extract<StoragePolicyResult, { ok: false }>,
  incomingBytes: number | null,
): StorageOverrideFacts {
  return storageOverrideFacts({
    limit: space.limit,
    usedBytes: space.usedBytes,
    capBytes: space.maxStorageBytes,
    freeBytes: space.freeBytes,
    // Prefer what the POLICY actually counted over what the caller happened to
    // know: when the release size is unknown the policy reserves a default, and
    // that reserve is usually the whole reason for the refusal. Reporting the
    // caller's `null` here is what left the dialog saying "using 0 B of 1 MB".
    incomingBytes: space.incomingBytes ?? incomingBytes,
    incomingEstimated: space.incomingEstimated,
    message: space.message,
  });
}

export interface SendStorageDecision {
  ok: boolean;
  message: string;
  /** Present when a reclaim attempt ran. Null when the cap allowed the send. */
  reclaim: RetentionSweepResult | null;
  /**
   * Which limit refused, and whether the owner may knowingly override it.
   * Null when the send was allowed. See `storage-override.ts` for the rule —
   * limits the app invented (the cap, the free-space margin) are the owner's to
   * overrule; only a release that genuinely does not fit is a hard stop.
   */
  override: StorageOverrideFacts | null;
}

export interface SendStorageGateOptions {
  userId: string;
  config: ClientConnectionConfig;
  /** Folder the budget is measured under. */
  root: string;
  /** Size of the incoming release, when known. */
  incomingBytes?: number | null;
  /** What the viewer asked for. `stream` is a Play; anything else keeps. */
  retention?: SendRetention | null;
  /** Hashes that must survive reclamation (e.g. the stream being watched). */
  protectHashes?: readonly string[];
  /**
   * The owner saw the real numbers and chose to proceed past a limit the app
   * set for them.
   *
   * Honoured for the cap and the free-space margin. A `wont-fit` refusal ignores
   * this flag completely, because no amount of user intent creates disk that
   * does not exist — see `isOverridableLimit`.
   */
  overrideCap?: boolean;
  _assert?: typeof assertStorageBudget;
  _reclaim?: typeof reclaimForBytes;
  _resetDirectorySizeCache?: () => void;
  /**
   * Bytes already promised to downloads that are queued but have written
   * nothing yet. Test seam — defaults to reading the engine's queue.
   */
  _reservedBytes?: (userId: string) => Promise<number>;
}

/**
 * How many bytes have to disappear for this send to fit under the cap.
 *
 * Exported because it is the arithmetic the whole gate turns on and it is worth
 * testing on its own: an under-estimate refuses a Play that reclamation could
 * have rescued, and an over-estimate deletes more cache than the viewer's
 * request justified.
 */
export function storageDeficitBytes(
  space: StoragePolicyResult,
  incomingBytes: number | null | undefined,
): number {
  if (space.ok) return 0;
  const cap = space.maxStorageBytes;
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return 0;
  const incoming =
    incomingBytes != null && Number.isFinite(incomingBytes) && incomingBytes > 0
      ? incomingBytes
      : 0;
  return Math.max(0, space.usedBytes + incoming - cap);
}

/**
 * The honest refusal for a Play that reclamation could not rescue.
 *
 * "Storage cap reached, delete something" is the wrong story here — the app
 * already tried to delete something and could not. Naming what held the cache
 * back is the difference between advice the viewer can act on and a dead end.
 */
export function reclaimRefusalMessage(
  reclaim: RetentionSweepResult,
  fallback: string,
): string {
  const freed = reclaim.reclaimedBytes;
  const reasons = [...new Set(reclaim.skipped.map((s) => s.reason))];

  // Nothing on disk is cache: it is all kept media or downloads in flight.
  // Telling the viewer to "free space" implies a control that would help.
  const allProtected =
    reclaim.deleted.length === 0 &&
    reasons.length > 0 &&
    reasons.every((r) =>
      ["kept", "watchlisted", "partial", "streaming", "downloading", "seeding-grace"].includes(r),
    );

  if (allProtected) {
    return (
      `Not enough room to play this, and nothing on disk can be freed automatically — ` +
      `everything under the download folder is either kept, still downloading, or part-watched. ` +
      `Raise the cap in Settings → Downloads, or remove a download you have finished with.`
    );
  }

  if (freed > 0) {
    // The reclaim button was just pressed on the viewer's behalf and it was not
    // enough, so pointing back at it would be advice that has already failed.
    // Whatever is left under the folder is not reclaimable cache — it is kept
    // media, transfers in flight, or files no torrent row accounts for.
    return (
      `Freed ${formatBytesShort(freed)}, but this still needs more room than the cap allows. ` +
      `What is left under the download folder is not reclaimable cache. ` +
      `Raise the cap in Settings → Downloads, or remove files you no longer need from the download folder.`
    );
  }

  return fallback;
}

/**
 * Decide whether a send may proceed, reclaiming cache first when it is a Play.
 */
export async function checkSendStorage(
  opts: SendStorageGateOptions,
): Promise<SendStorageDecision> {
  const assertBudget = opts._assert ?? assertStorageBudget;
  const reclaim = opts._reclaim ?? reclaimForBytes;
  const dropSizeCache = opts._resetDirectorySizeCache ?? resetDirectorySizeCache;
  const readReserved =
    opts._reservedBytes ??
    (async (userId: string) => {
      const { queuedDownloadBytes } = await import(
        "@/lib/clients/builtin-engine"
      );
      return queuedDownloadBytes(userId);
    });
  const requestedBytes = opts.incomingBytes ?? null;
  // Queued downloads have claimed space but written none of it, so the folder
  // measurement cannot see them. Counting them here is what stops thirteen
  // episodes fanned out in parallel from all passing the same free space.
  const reserved = await readReserved(opts.userId).catch(() => 0);
  const incomingBytes =
    reserved > 0 ? (requestedBytes ?? 0) + reserved : requestedBytes;

  const first = await assertBudget({
    root: opts.root,
    maxStorageBytes: opts.config.maxStorageBytes,
    incomingBytes,
  });
  if (first.ok) return { ok: true, message: "", reclaim: null, override: null };

  // The owner was shown the real numbers and chose to go over their own cap.
  // The owner was shown the real numbers and chose to go past a limit the app
  // set. `isOverridableLimit` still refuses `wont-fit` and `setup` outright, so
  // this flag can never be used to write bytes the volume does not have.
  if (opts.overrideCap && isOverridableLimit(first.limit)) {
    return { ok: true, message: "", reclaim: null, override: null };
  }

  // Download keeps the cap — but as a question, not a verdict. The refusal
  // carries the facts a caller needs to offer "raise the cap" or "do it anyway";
  // what it must not do is end the interaction.
  if (opts.retention !== "stream") {
    return {
      ok: false,
      message: first.message,
      reclaim: null,
      override: refusalFacts(first, requestedBytes),
    };
  }

  // Not a cap refusal (setup missing, or a volume limit). Reclaiming the stream
  // cache cannot fix any of those, so do not delete anything to find out.
  const deficit = storageDeficitBytes(first, incomingBytes);
  if (deficit <= 0) {
    return {
      ok: false,
      message: first.message,
      reclaim: null,
      override: refusalFacts(first, requestedBytes),
    };
  }

  const swept = await reclaim({
    userId: opts.userId,
    config: opts.config,
    neededBytes: deficit,
    protectHashes: opts.protectHashes,
    mode: "delete",
  });

  // The directory-size probe memoises for 30s; without this the re-check reads
  // the pre-reclaim size and refuses space that was just freed.
  dropSizeCache();

  const second = await assertBudget({
    root: opts.root,
    maxStorageBytes: opts.config.maxStorageBytes,
    incomingBytes,
  });
  if (second.ok) return { ok: true, message: "", reclaim: swept, override: null };

  return {
    ok: false,
    message: reclaimRefusalMessage(swept, second.message),
    reclaim: swept,
    override: refusalFacts(second, requestedBytes),
  };
}
