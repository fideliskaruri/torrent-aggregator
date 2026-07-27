-- Cache what we have already proven about a torrent's on-disk data.
--
-- WebTorrent calls `_startDiscovery()` only from `_onStore()`, which runs only
-- after `_verifyPieces()` has hashed every piece. So on a rehydrate no tracker
-- announce fires, no DHT lookup runs and no peer is contacted until the whole
-- file has been re-hashed -- seconds of dead air before the swarm is even told
-- we exist, which is the bulk of the measured time-to-first-frame.
--
-- Storing the verified bitfield lets us hand that proof back at add time and
-- skip the redundant scan. It is only ever reused when the bitfield, the file
-- size and the mtime all still match: absent or mismatched evidence means we
-- verify as before. Unknown is never collapsed into "verified".
--
-- All four columns are additive and nullable, so existing rows keep working and
-- simply fall back to full verification until they are next verified.
ALTER TABLE "EngineTorrent" ADD COLUMN "torrentUrl" TEXT;
ALTER TABLE "EngineTorrent" ADD COLUMN "verifiedBitfield" TEXT;
ALTER TABLE "EngineTorrent" ADD COLUMN "verifiedFilesJson" TEXT;
ALTER TABLE "EngineTorrent" ADD COLUMN "verifiedAt" DATETIME;
