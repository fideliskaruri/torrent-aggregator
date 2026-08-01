-- CreateTable
CREATE TABLE "AcquisitionTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "workKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "season" INTEGER,
    "episode" INTEGER,
    "preferredResolution" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" REAL NOT NULL DEFAULT 0,
    "infoHash" TEXT,
    "filePath" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AcquisitionTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AcquisitionTarget_userId_targetKey_key" ON "AcquisitionTarget"("userId", "targetKey");

-- CreateIndex
CREATE INDEX "AcquisitionTarget_userId_workKey_scope_idx" ON "AcquisitionTarget"("userId", "workKey", "scope");

-- CreateIndex
CREATE INDEX "AcquisitionTarget_userId_infoHash_idx" ON "AcquisitionTarget"("userId", "infoHash");

-- CreateIndex
CREATE INDEX "AcquisitionTarget_userId_status_idx" ON "AcquisitionTarget"("userId", "status");
