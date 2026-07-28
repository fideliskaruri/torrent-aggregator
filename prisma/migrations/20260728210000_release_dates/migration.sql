-- Persist a primary release / first-air date so the catalog can gray out and
-- label unreleased titles ("Coming {date}") instead of offering a dead play or
-- download action for something that does not exist yet.
--
-- Both columns are additive and nullable: existing rows keep working and are
-- simply treated as "date unknown" (never gated) until a metadata fetch
-- backfills the date. Unknown is never collapsed into "released" or "unreleased".
ALTER TABLE "CachedMetadata" ADD COLUMN "releaseDate" DATETIME;
ALTER TABLE "CatalogEntry" ADD COLUMN "releaseDate" DATETIME;
