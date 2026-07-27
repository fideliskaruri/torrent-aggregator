-- CreateTable
CREATE TABLE "PlaybackProgress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "infoHash" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "positionSec" REAL NOT NULL DEFAULT 0,
    "durationSec" REAL,
    "completedAt" DATETIME,
    "title" TEXT NOT NULL,
    "season" INTEGER,
    "episode" INTEGER,
    "watchListItemId" TEXT,
    "posterUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlaybackProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediaProbe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "infoHash" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "container" TEXT,
    "durationSec" REAL,
    "videoCodec" TEXT,
    "videoProfile" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "colorTransfer" TEXT,
    "audioCodec" TEXT,
    "audioChannels" INTEGER,
    "audioLayout" TEXT,
    "streamsJson" TEXT,
    "probedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "PlaybackProgress_userId_updatedAt_idx" ON "PlaybackProgress"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "PlaybackProgress_userId_completedAt_idx" ON "PlaybackProgress"("userId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlaybackProgress_userId_infoHash_filePath_key" ON "PlaybackProgress"("userId", "infoHash", "filePath");

-- CreateIndex
CREATE UNIQUE INDEX "MediaProbe_infoHash_filePath_key" ON "MediaProbe"("infoHash", "filePath");

-- CreateIndex
CREATE INDEX "DownloadHistory_userId_status_idx" ON "DownloadHistory"("userId", "status");

-- CreateIndex
CREATE INDEX "RunLock_acquiredAt_idx" ON "RunLock"("acquiredAt");
