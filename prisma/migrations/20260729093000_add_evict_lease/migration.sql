-- Additive, nullable eviction-lease columns on EngineTorrent (issue D, reviewer
-- round 2). They serialize an explicit user Download against a speculative
-- deletion sweep: a sweep CLAIMS a cache row by moving origin -> 'evicting' and
-- stamping "evictLease"; a Download STEALS the lease (clearing it) and the sweep
-- re-checks its token before unlinking, aborting if it lost. "evictFrom" records
-- the exact prior origin so a lease abandoned by a crash is recovered by age,
-- never inferred.
--
-- Both columns are NULL for every existing row and are only ever written for
-- rows the code itself moves into the brand-new 'evicting' state. No historical
-- row is read, reclassified, or backfilled. SQLite ADD COLUMN is metadata-only.

-- AlterTable
ALTER TABLE "EngineTorrent" ADD COLUMN "evictLease" TEXT;

-- AlterTable
ALTER TABLE "EngineTorrent" ADD COLUMN "evictFrom" TEXT;
