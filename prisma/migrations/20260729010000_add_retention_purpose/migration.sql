-- Additive, nullable acquisition-intent column on the two records a Play can
-- otherwise pollute. NULL means "legacy / unknown", which every reader treats
-- as an ordinary download, so existing rows are unchanged and nothing new
-- becomes evictable. No data is rewritten: SQLite ADD COLUMN is metadata-only.

-- AlterTable
ALTER TABLE "GrabJob" ADD COLUMN "retention" TEXT;

-- AlterTable
ALTER TABLE "DownloadHistory" ADD COLUMN "retention" TEXT;
