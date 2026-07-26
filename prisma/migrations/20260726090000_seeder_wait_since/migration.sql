-- Tracks when the current cursor episode first hit the thin-swarm gate, so
-- automation can eventually grab a low-seeder-but-alive release instead of
-- deferring it forever. NULL = not currently waiting. No backfill: existing
-- rows correctly start as "not waiting".
ALTER TABLE "WatchListItem" ADD COLUMN "seederWaitSince" DATETIME;
