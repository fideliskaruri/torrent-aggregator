import path from "node:path";
import prisma from "@/lib/prisma";
import {
  diskFileLengthByPath,
  resolveCompletedPersistedDiskFile,
  type PersistedDiskFile,
} from "@/lib/clients/disk-fastpath";
import { isSupportedVideoFileName } from "@/lib/torrents/filters";

export type CompletedMediaFile = PersistedDiskFile & {
  relativePath: string;
};

export type CompletedMediaManifest = {
  infoHash: string;
  files: CompletedMediaFile[];
};

type CompletedMediaRow = {
  hash: string;
  progress: number;
  savePath: string | null;
  verifiedFilesJson: string | null;
};

function recordedRelativePaths(row: CompletedMediaRow): string[] {
  if (!row.savePath?.trim() || !row.verifiedFilesJson?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.verifiedFilesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const root = path.resolve(row.savePath);
  const paths = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const absolute = (entry as { path?: unknown }).path;
    if (typeof absolute !== "string" || !path.isAbsolute(absolute)) continue;
    const relative = path.relative(root, path.resolve(absolute));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    paths.add(relative.replace(/\\/g, "/"));
  }
  return [...paths];
}

export async function completedManifestFromRow(
  row: CompletedMediaRow,
): Promise<CompletedMediaManifest | null> {
  const files: CompletedMediaFile[] = [];
  for (const relativePath of recordedRelativePaths(row)) {
    const file = resolveCompletedPersistedDiskFile(
      row.progress,
      row.savePath,
      row.verifiedFilesJson,
      relativePath,
    );
    if (!file) continue;
    const length = await diskFileLengthByPath(
      file.path,
      file.length,
      file.mtimeMs,
      file.rootPath,
    );
    if (length == null) continue;
    files.push({ ...file, relativePath });
  }
  return files.some((file) => isSupportedVideoFileName(file.relativePath))
    ? { infoHash: row.hash, files }
    : null;
}

async function completedRow(
  userId: string,
  infoHash: string,
): Promise<CompletedMediaRow | null> {
  return prisma.engineTorrent.findFirst({
    where: {
      userId,
      hash: infoHash.toLowerCase(),
      progress: { gte: 0.9999 },
      status: { notIn: ["removed", "error", "missingFiles"] },
      verifiedBitfield: { not: null },
      verifiedFilesJson: { not: null },
    },
    select: {
      hash: true,
      progress: true,
      savePath: true,
      verifiedFilesJson: true,
    },
    orderBy: { updatedAt: "desc" },
  });
}

export async function getCompletedMediaManifest(
  userId: string,
  infoHash: string,
): Promise<CompletedMediaManifest | null> {
  const row = await completedRow(userId, infoHash);
  return row ? completedManifestFromRow(row) : null;
}

export async function resolveCompletedMediaFile(
  userId: string,
  infoHash: string,
  requestedPath: string,
): Promise<CompletedMediaFile | null> {
  const row = await completedRow(userId, infoHash);
  if (!row) return null;
  if (!recordedRelativePaths(row).some(isSupportedVideoFileName)) return null;
  const file = resolveCompletedPersistedDiskFile(
    row.progress,
    row.savePath,
    row.verifiedFilesJson,
    requestedPath,
  );
  if (!file) return null;
  const length = await diskFileLengthByPath(
    file.path,
    file.length,
    file.mtimeMs,
    file.rootPath,
  );
  return length == null
    ? null
    : { ...file, relativePath: requestedPath.replace(/\\/g, "/") };
}
