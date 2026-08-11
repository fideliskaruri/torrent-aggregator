import path from "node:path";
import prisma from "@/lib/prisma";
import {
  diskFileLengthByPath,
  isCompletedProgress,
  resolveCompletedPersistedDiskFile,
  type PersistedDiskFile,
} from "@/lib/clients/disk-fastpath";
import { isInsideRoot, libraryRoots } from "@/lib/download/path-containment";
import {
  isSupportedMediaAssetFileName,
  isSupportedVideoFileName,
} from "@/lib/torrents/filters";

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

type RecordedFingerprint = {
  path: string;
  size: number;
  mtimeMs: number;
};

function recordedFingerprints(row: CompletedMediaRow): RecordedFingerprint[] {
  if (!row.savePath?.trim() || !row.verifiedFilesJson?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.verifiedFilesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const files: RecordedFingerprint[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      path?: unknown;
      size?: unknown;
      mtimeMs?: unknown;
    };
    if (typeof record.path !== "string" || !path.isAbsolute(record.path))
      continue;
    if (
      typeof record.size !== "number" ||
      !Number.isFinite(record.size) ||
      record.size < 0 ||
      typeof record.mtimeMs !== "number" ||
      !Number.isFinite(record.mtimeMs)
    ) {
      continue;
    }
    files.push({
      path: path.resolve(record.path),
      size: Math.trunc(record.size),
      mtimeMs: record.mtimeMs,
    });
  }
  return files;
}

async function completedFilesFromRow(
  row: CompletedMediaRow,
): Promise<CompletedMediaFile[]> {
  if (!isCompletedProgress(row.progress)) return [];
  const root = path.resolve(row.savePath ?? "");
  const files: CompletedMediaFile[] = [];
  for (const fingerprint of recordedFingerprints(row)) {
    const relativePath = path
      .relative(root, fingerprint.path)
      .replace(/\\/g, "/");
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath)
    ) {
      continue;
    }
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
    if (length != null) files.push({ ...file, relativePath });
  }
  return files;
}

function commonDirectory(filePaths: string[]): string | null {
  if (filePaths.length === 0) return null;
  let common = path.dirname(filePaths[0]);
  for (const filePath of filePaths.slice(1)) {
    while (!isInsideRoot(filePath, common)) {
      const parent = path.dirname(common);
      if (parent === common) return null;
      common = parent;
    }
  }
  return common;
}

function sameResolvedPath(left: string | null, right: string): boolean {
  if (!left?.trim()) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function samePathLeaf(left: string | null, right: string): boolean {
  if (!left?.trim()) return false;
  const a = path.basename(path.resolve(left));
  const b = path.basename(path.resolve(right));
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

export async function completedManifestFromTrustedRecordedPaths(
  row: CompletedMediaRow,
  trustedRoots: string[],
): Promise<CompletedMediaManifest | null> {
  if (!isCompletedProgress(row.progress) || trustedRoots.length === 0)
    return null;
  const fingerprints = recordedFingerprints(row);
  if (fingerprints.length === 0) return null;
  const rootPath = commonDirectory(fingerprints.map((file) => file.path));
  if (!rootPath || !trustedRoots.some((root) => isInsideRoot(rootPath, root))) {
    return null;
  }
  if (
    !sameResolvedPath(row.savePath, rootPath) &&
    !samePathLeaf(row.savePath, rootPath)
  ) {
    return null;
  }

  const files: CompletedMediaFile[] = [];
  for (const fingerprint of fingerprints) {
    const trustedRoot = trustedRoots.find((root) =>
      isInsideRoot(fingerprint.path, root),
    );
    if (!trustedRoot) return null;
    const length = await diskFileLengthByPath(
      fingerprint.path,
      fingerprint.size,
      fingerprint.mtimeMs,
      trustedRoot,
    );
    if (length == null) return null;
    const relativePath = path
      .relative(rootPath, fingerprint.path)
      .replace(/\\/g, "/");
    if (!isSupportedMediaAssetFileName(relativePath)) continue;
    files.push({
      path: fingerprint.path,
      rootPath,
      length,
      mtimeMs: fingerprint.mtimeMs,
      relativePath,
    });
  }

  return files.some((file) => isSupportedVideoFileName(file.relativePath))
    ? { infoHash: row.hash, files }
    : null;
}

async function trustedLibraryRoots(userId: string): Promise<string[]> {
  const settings = await prisma.clientSettings.findUnique({
    where: { userId },
    select: {
      baseDownloadPath: true,
      savePath: true,
      pathRules: true,
    },
  });
  let pathRules: Record<string, string> | null = null;
  if (settings?.pathRules) {
    try {
      const parsed = JSON.parse(settings.pathRules) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        pathRules = Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    } catch {
      pathRules = null;
    }
  }
  return libraryRoots({
    baseDownloadPath: settings?.baseDownloadPath,
    savePath: settings?.savePath,
    pathRules,
  });
}

async function recoverTrustedRecordedManifest(
  userId: string,
  row: CompletedMediaRow,
): Promise<CompletedMediaManifest | null> {
  const manifest = await completedManifestFromTrustedRecordedPaths(
    row,
    await trustedLibraryRoots(userId),
  );
  const recoveredRoot = manifest?.files[0]?.rootPath;
  if (
    manifest &&
    recoveredRoot &&
    !sameResolvedPath(row.savePath, recoveredRoot)
  ) {
    await prisma.engineTorrent.updateMany({
      where: {
        userId,
        hash: row.hash,
        savePath: row.savePath,
        verifiedFilesJson: row.verifiedFilesJson,
      },
      data: { savePath: recoveredRoot },
    });
  }
  return manifest;
}

export async function completedManifestFromRow(
  row: CompletedMediaRow,
): Promise<CompletedMediaManifest | null> {
  const files = await completedFilesFromRow(row);
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
  if (!row) return null;
  const current = await completedManifestFromRow(row);
  if (current) return current;
  const recorded = await recoverTrustedRecordedManifest(userId, row);
  return recorded;
}

export async function resolveCompletedMediaFile(
  userId: string,
  infoHash: string,
  requestedPath: string,
): Promise<CompletedMediaFile | null> {
  const row = await completedRow(userId, infoHash);
  if (!row) return null;
  const requested = requestedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const currentFiles = await completedFilesFromRow(row);
  const current = currentFiles.find((file) =>
    process.platform === "win32"
      ? file.relativePath.toLowerCase() === requested.toLowerCase()
      : file.relativePath === requested,
  );
  if (current) return current;
  const recorded = await recoverTrustedRecordedManifest(userId, row);
  if (recorded) {
    return (
      recorded.files.find((file) =>
        process.platform === "win32"
          ? file.relativePath.toLowerCase() === requested.toLowerCase()
          : file.relativePath === requested,
      ) ?? null
    );
  }
  return null;
}
