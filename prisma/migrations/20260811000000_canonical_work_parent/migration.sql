-- CreateTable
CREATE TABLE "Work" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workKey" TEXT NOT NULL,
    "canonicalTitle" TEXT NOT NULL,
    "year" INTEGER,
    "mediaType" TEXT NOT NULL,
    "aliasesJson" TEXT,
    "provider" TEXT,
    "providerId" TEXT,
    "posterUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- AlterTable
ALTER TABLE "WatchListItem" ADD COLUMN "workId" TEXT REFERENCES "Work" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EngineTorrent" ADD COLUMN "workId" TEXT REFERENCES "Work" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AcquisitionTarget" ADD COLUMN "workId" TEXT REFERENCES "Work" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CatalogEntry" ADD COLUMN "workId" TEXT REFERENCES "Work" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DownloadHistory" ADD COLUMN "workId" TEXT REFERENCES "Work" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlaybackProgress" ADD COLUMN "workId" TEXT REFERENCES "Work" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "Work_workKey_key" ON "Work"("workKey");
CREATE UNIQUE INDEX "Work_provider_providerId_mediaType_key" ON "Work"("provider", "providerId", "mediaType");
CREATE INDEX "Work_mediaType_idx" ON "Work"("mediaType");
CREATE INDEX "WatchListItem_workId_idx" ON "WatchListItem"("workId");
CREATE INDEX "EngineTorrent_workId_idx" ON "EngineTorrent"("workId");
CREATE INDEX "AcquisitionTarget_workId_idx" ON "AcquisitionTarget"("workId");
CREATE INDEX "CatalogEntry_workId_idx" ON "CatalogEntry"("workId");
CREATE INDEX "DownloadHistory_workId_idx" ON "DownloadHistory"("workId");
CREATE INDEX "PlaybackProgress_workId_idx" ON "PlaybackProgress"("workId");
