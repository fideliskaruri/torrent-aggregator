-- CreateTable
CREATE TABLE "GrabJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "magnet" TEXT,
    "infoHash" TEXT,
    "source" TEXT,
    "savePath" TEXT,
    "category" TEXT,
    "kind" TEXT,
    "externalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GrabJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ClientSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "clientType" TEXT NOT NULL DEFAULT 'builtin',
    "externalClientType" TEXT,
    "host" TEXT NOT NULL DEFAULT 'http://127.0.0.1:8080',
    "username" TEXT,
    "password" TEXT,
    "category" TEXT,
    "savePath" TEXT,
    "baseDownloadPath" TEXT,
    "maxStorageBytes" BIGINT,
    "categories" TEXT,
    "pathRules" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ClientSettings" ("baseDownloadPath", "categories", "category", "clientType", "createdAt", "host", "id", "password", "pathRules", "savePath", "updatedAt", "userId", "username") SELECT "baseDownloadPath", "categories", "category", "clientType", "createdAt", "host", "id", "password", "pathRules", "savePath", "updatedAt", "userId", "username" FROM "ClientSettings";
DROP TABLE "ClientSettings";
ALTER TABLE "new_ClientSettings" RENAME TO "ClientSettings";
CREATE UNIQUE INDEX "ClientSettings_userId_key" ON "ClientSettings"("userId");
CREATE TABLE "new_WatchListItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "posterUrl" TEXT,
    "synopsis" TEXT,
    "rating" REAL,
    "status" TEXT NOT NULL DEFAULT 'watching',
    "monitored" BOOLEAN NOT NULL DEFAULT true,
    "lastChecked" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEpisode" TEXT,
    "fromSeason" INTEGER,
    "fromEpisode" INTEGER DEFAULT 1,
    "cursorSeason" INTEGER,
    "cursorEpisode" INTEGER,
    "cursorMisses" INTEGER NOT NULL DEFAULT 0,
    "monitorMode" TEXT NOT NULL DEFAULT 'ongoing',
    "latestReleaseTitle" TEXT,
    "latestReleaseAt" DATETIME,
    "latestReleaseMagnet" TEXT,
    "nextEpisodeHint" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WatchListItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WatchListItem" ("createdAt", "externalId", "id", "lastChecked", "lastEpisode", "latestReleaseAt", "latestReleaseMagnet", "latestReleaseTitle", "mediaType", "nextEpisodeHint", "posterUrl", "rating", "status", "synopsis", "title", "updatedAt", "userId") SELECT "createdAt", "externalId", "id", "lastChecked", "lastEpisode", "latestReleaseAt", "latestReleaseMagnet", "latestReleaseTitle", "mediaType", "nextEpisodeHint", "posterUrl", "rating", "status", "synopsis", "title", "updatedAt", "userId" FROM "WatchListItem";
DROP TABLE "WatchListItem";
ALTER TABLE "new_WatchListItem" RENAME TO "WatchListItem";
CREATE INDEX "WatchListItem_userId_idx" ON "WatchListItem"("userId");
CREATE UNIQUE INDEX "WatchListItem_userId_mediaType_externalId_key" ON "WatchListItem"("userId", "mediaType", "externalId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "GrabJob_userId_createdAt_idx" ON "GrabJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GrabJob_userId_status_idx" ON "GrabJob"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RunLock_userId_scope_key" ON "RunLock"("userId", "scope");
