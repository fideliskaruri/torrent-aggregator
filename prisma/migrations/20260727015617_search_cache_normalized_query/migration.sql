-- AlterTable
ALTER TABLE "SearchCache" ADD COLUMN "normalizedQuery" TEXT;

-- CreateIndex
CREATE INDEX "SearchCache_normalizedQuery_expiresAt_idx" ON "SearchCache"("normalizedQuery", "expiresAt");
