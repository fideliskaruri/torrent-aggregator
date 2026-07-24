-- Durable state for the built-in BitTorrent engine (survives process restart).
CREATE TABLE IF NOT EXISTS "EngineTorrent" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EngineTorrent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "EngineTorrent_userId_hash_key" ON "EngineTorrent"("userId", "hash");
CREATE INDEX IF NOT EXISTS "EngineTorrent_userId_status_idx" ON "EngineTorrent"("userId", "status");
