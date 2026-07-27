/**
 * Activity-stream de-duplication.
 *
 * A grab job and a download-history entry for the **same torrent** (same
 * infoHash) represent one logical event, not two. The grab is the richer
 * record (has query, kind, savePath, category), so when both exist the grab
 * wins and the history entry is dropped.
 *
 * Identity is the canonical 40-hex-char infoHash, which is:
 *   1. stored directly on the record (`infoHash` column), or
 *   2. extracted from the `xt` parameter of the magnet URI (hex or base32).
 *
 * Two magnets that differ only in trackers (`tr`), display name (`dn`), or
 * other parameters are the **same torrent** and must be merged. A base32-
 * encoded btih and the equivalent hex btih also denote the same torrent.
 */

import {
  infoHashFromMagnet,
  normalizeInfoHash,
} from "@/lib/torrents/infohash";

export { infoHashFromMagnet };

export type ActivityItem = {
  id: string;
  type: "grab" | "history";
  title: string;
  status: string;
  message: string | null;
  source: string | null;
  kind: string | null;
  query: string | null;
  magnet: string | null;
  infoHash: string | null;
  savePath: string | null;
  category: string | null;
  createdAt: string;
};

/**
 * Resolve the canonical identity key for an activity item.
 *
 * Uses infoHash (from the record or extracted from the magnet) combined with
 * status, so a "sent" and a "failed" entry for the same torrent both show.
 * Returns null for items without any torrent identity (e.g. a failed grab
 * that never resolved a magnet).
 */
export function activityKey(item: ActivityItem): string | null {
  // Normalise the stored infoHash (could be hex or base32) then fall back to
  // extracting from the magnet URI.
  const hash =
    (item.infoHash ? normalizeInfoHash(item.infoHash) : null) ??
    infoHashFromMagnet(item.magnet);
  if (!hash) return null;
  return `${hash}|${item.status}`;
}

/**
 * De-duplicate an already-time-sorted (newest-first) merged activity stream.
 *
 * - Grab entries are preferred over history entries for the same torrent+status.
 * - Items without a torrent identity (null infoHash, no magnet) are never merged.
 * - Different statuses for the same torrent are kept (e.g. a "sent" grab and a
 *   "failed" retry are both visible).
 */
export function deduplicateActivity(
  merged: ActivityItem[],
  limit: number,
): ActivityItem[] {
  const seen = new Set<string>();
  const items: ActivityItem[] = [];

  for (const item of merged) {
    const key = activityKey(item);
    if (key) {
      // Grabs register their key first; later history entries with the same
      // key are dropped. Since the stream is newest-first and grabs are
      // interleaved, this naturally prefers the grab.
      if (item.type === "history" && seen.has(key)) continue;
      if (item.type === "grab") seen.add(key);
    }
    items.push(item);
    if (items.length >= limit) break;
  }

  return items;
}
