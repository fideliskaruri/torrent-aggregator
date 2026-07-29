import type { ClientConnectionConfig, TorrentPurpose } from "@/lib/clients/types";
import {
  markTorrentStreamOnly,
  promoteTorrentToKept,
  streamingRetentionEnabled,
} from "./retention";

export type SendRetention = "stream" | "keep";

/**
 * Map an explicit send retention (plus watchlist context) to the acquisition
 * purpose the engine adds with. This is the ONE place the "a watchlisted play
 * is an intent to keep" rule lives, so the grab callers (which set the pipeline
 * purpose) and {@link applySendRetention} (which verifies the result) can never
 * disagree about what a given request meant.
 *
 *   - `keep`                       → keep (whole file, permanent download)
 *   - `stream` + no watchlist item → stream (ephemeral playback cache)
 *   - `stream` + watchlist item    → keep (streaming a watchlisted title retains it)
 *   - null / undefined             → keep (the safe default)
 */
export function sendRetentionToPurpose(
  retention: SendRetention | null | undefined,
  watchListItemId?: string | null,
): TorrentPurpose {
  if (retention === "stream" && !watchListItemId) return "stream";
  return "keep";
}

/**
 * Post-send VERIFICATION of a torrent's retention classification.
 *
 * Classification now happens authoritatively at the add boundary: the engine
 * births `EngineTorrent.origin` from the required `purpose` and applies the
 * monotonic promote/label transitions itself. This function no longer decides
 * anything — it re-asserts the intended end state through the same guarded,
 * monotonic helpers, so it is idempotent and can only ever move a row toward the
 * user's most explicit intent:
 *
 *   - keep   → promoteTorrentToKept  (stream|prewarm → user; never demotes)
 *   - stream → markTorrentStreamOnly (prewarm → stream; idempotent on stream;
 *                                     never touches a `user`/kept row)
 *
 * With `TORRENTFLOW_STREAM_CACHE=off` there is no stream cache to reconcile, so
 * we leave the engine's classification untouched rather than silently converting
 * anything (issue G — no silent downgrade).
 */
export async function applySendRetention(opts: {
  userId: string;
  config: ClientConnectionConfig;
  infoHash: string | null | undefined;
  retention: SendRetention;
  watchListItemId?: string | null;
}): Promise<void> {
  const infoHash = opts.infoHash?.trim();
  if (!infoHash || opts.config.clientType !== "builtin") return;
  if (!streamingRetentionEnabled()) return;

  const purpose = sendRetentionToPurpose(opts.retention, opts.watchListItemId);
  if (purpose === "stream") {
    await markTorrentStreamOnly(opts.userId, infoHash);
    return;
  }
  await promoteTorrentToKept(opts.userId, infoHash);
}
