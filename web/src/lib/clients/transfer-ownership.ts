import type {
  TorrentClientType,
} from "./types";
import type {
  OwnedClientTorrent,
} from "@/lib/torrents/types";

/**
 * Keep last-known rows belonging to a client that failed this poll, while
 * replacing every successfully queried client's rows with the fresh answer.
 */
export function mergeOwnedTransferSnapshots(
  previous: readonly OwnedClientTorrent[],
  fresh: readonly OwnedClientTorrent[],
  unavailableClientTypes: readonly TorrentClientType[],
): OwnedClientTorrent[] {
  const unavailable = new Set(unavailableClientTypes);
  const merged = new Map<string, OwnedClientTorrent>();
  for (const torrent of previous) {
    if (unavailable.has(torrent.ownerClientType)) {
      merged.set(torrent.transferId, torrent);
    }
  }
  for (const torrent of fresh) merged.set(torrent.transferId, torrent);
  return [...merged.values()];
}
