-- Chronological download queue for kept transfers.
--
-- A kept add no longer goes straight into WebTorrent: only a few transfer at
-- once and the rest are persisted as status "queued" with no live torrent at
-- all, which is what keeps peer connections and per-torrent piece caches off
-- the heap. These two columns carry the ordering and the manual override.
--
-- Both are nullable, so existing rows are untouched: they have no queue
-- position (they sort after numbered episodes of their work) and are not
-- forced. The startup plan re-applies the cap to rows already marked
-- "downloading", so an existing database converges without a data migration.
ALTER TABLE "EngineTorrent" ADD COLUMN "queueKey" TEXT;
ALTER TABLE "EngineTorrent" ADD COLUMN "forcedAt" DATETIME;
