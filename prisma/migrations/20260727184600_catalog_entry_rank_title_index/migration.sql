DROP INDEX "CatalogEntry_source_seedTitle_rank_idx";

CREATE INDEX "CatalogEntry_source_seedTitle_rank_title_idx" ON "CatalogEntry"("source", "seedTitle", "rank", "title");
