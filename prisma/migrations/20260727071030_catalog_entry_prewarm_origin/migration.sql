-- CreateTable
CREATE TABLE "CatalogEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "mediaType" TEXT NOT NULL,
    "posterUrl" TEXT,
    "backdropUrl" TEXT,
    "overview" TEXT,
    "rating" REAL,
    "source" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "seedTitle" TEXT,
    "seeders" INTEGER NOT NULL DEFAULT 0,
    "bestRelease" TEXT,
    "refreshedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EngineTorrent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "magnet" TEXT,
    "savePath" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'downloading',
    "progress" REAL NOT NULL DEFAULT 0,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'user',
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EngineTorrent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_EngineTorrent" ("category", "createdAt", "error", "hash", "id", "magnet", "name", "progress", "savePath", "sizeBytes", "status", "updatedAt", "userId") SELECT "category", "createdAt", "error", "hash", "id", "magnet", "name", "progress", "savePath", "sizeBytes", "status", "updatedAt", "userId" FROM "EngineTorrent";
DROP TABLE "EngineTorrent";
ALTER TABLE "new_EngineTorrent" RENAME TO "EngineTorrent";
CREATE INDEX "EngineTorrent_userId_status_idx" ON "EngineTorrent"("userId", "status");
CREATE INDEX "EngineTorrent_userId_origin_lastUsedAt_idx" ON "EngineTorrent"("userId", "origin", "lastUsedAt");
CREATE UNIQUE INDEX "EngineTorrent_userId_hash_key" ON "EngineTorrent"("userId", "hash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CatalogEntry_source_rank_idx" ON "CatalogEntry"("source", "rank");

-- CreateIndex
CREATE INDEX "CatalogEntry_refreshedAt_idx" ON "CatalogEntry"("refreshedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogEntry_workKey_source_seedTitle_key" ON "CatalogEntry"("workKey", "source", "seedTitle");
