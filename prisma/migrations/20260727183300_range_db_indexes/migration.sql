CREATE INDEX "CachedMetadata_updatedAt_idx" ON "CachedMetadata"("updatedAt");

CREATE INDEX "CatalogEntry_source_seedTitle_rank_idx" ON "CatalogEntry"("source", "seedTitle", "rank");
