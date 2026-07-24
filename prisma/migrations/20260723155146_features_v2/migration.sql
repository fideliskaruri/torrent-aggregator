-- AlterTable
ALTER TABLE "WatchListItem" ADD COLUMN "latestReleaseAt" DATETIME;
ALTER TABLE "WatchListItem" ADD COLUMN "latestReleaseMagnet" TEXT;
ALTER TABLE "WatchListItem" ADD COLUMN "latestReleaseTitle" TEXT;
ALTER TABLE "WatchListItem" ADD COLUMN "nextEpisodeHint" TEXT;

-- CreateTable
CREATE TABLE "DownloadHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "magnet" TEXT,
    "torrentUrl" TEXT,
    "infoHash" TEXT,
    "source" TEXT,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DownloadHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutoRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'all',
    "minSeeders" INTEGER NOT NULL DEFAULT 10,
    "maxSizeBytes" BIGINT,
    "resolution" TEXT,
    "sources" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "lastMatchTitle" TEXT,
    "lastMatchMagnet" TEXT,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SearchCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cacheKey" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "DownloadHistory_userId_createdAt_idx" ON "DownloadHistory"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AutoRule_userId_enabled_idx" ON "AutoRule"("userId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "SearchCache_cacheKey_key" ON "SearchCache"("cacheKey");

-- CreateIndex
CREATE INDEX "SearchCache_expiresAt_idx" ON "SearchCache"("expiresAt");
