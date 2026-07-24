/**
 * Sync lookup of a live torrent by info-hash.
 * Do not use WebTorrent 3's client.get() without await — it returns a Promise
 * and looks like a torrent handle (truthy), which breaks destroy/pause/resume.
 */
export function findTorrentByHash<
  T extends { infoHash?: string | null },
>(torrents: readonly T[], hash: string): T | undefined {
  const h = (hash || "").toLowerCase().trim();
  if (!h || h.startsWith("pending-")) return undefined;
  for (const t of torrents) {
    const ih = (t.infoHash || "").toLowerCase();
    if (ih && ih === h) return t;
  }
  return undefined;
}
