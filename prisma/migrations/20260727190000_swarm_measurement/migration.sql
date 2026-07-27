-- CreateTable
CREATE TABLE "SwarmMeasurement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "infoHash" TEXT NOT NULL,
    "peersConnected" INTEGER NOT NULL DEFAULT 0,
    "peersUnchoked" INTEGER NOT NULL DEFAULT 0,
    "bytesReceived" BIGINT NOT NULL DEFAULT 0,
    "elapsedMs" INTEGER NOT NULL DEFAULT 0,
    "effectiveBps" REAL NOT NULL DEFAULT 0,
    "requiredBps" REAL NOT NULL DEFAULT 0,
    "verdict" TEXT NOT NULL,
    "measuredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SwarmMeasurement_infoHash_key" ON "SwarmMeasurement"("infoHash");

-- CreateIndex
CREATE INDEX "SwarmMeasurement_expiresAt_idx" ON "SwarmMeasurement"("expiresAt");
