-- Store transfer facts as data so UI copy is composed at render time.
ALTER TABLE "DownloadHistory" ADD COLUMN "context" TEXT;
ALTER TABLE "DownloadHistory" ADD COLUMN "category" TEXT;
ALTER TABLE "DownloadHistory" ADD COLUMN "savePath" TEXT;
ALTER TABLE "DownloadHistory" ADD COLUMN "clientType" TEXT;
ALTER TABLE "DownloadHistory" ADD COLUMN "sendKind" TEXT;
