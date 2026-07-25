import fs from "node:fs";
import path from "node:path";
import prisma from "@/lib/prisma";

export const DEFAULT_CATEGORIES = [
  "Anime",
  "Movies",
  "TV",
  "Music",
  "Games",
  "Software",
  "Books",
  "Other",
];

/** Portable download root: DOWNLOAD_DIR env or ./downloads under cwd. */
export function defaultDownloadDir(): string {
  const fromEnv = process.env.DOWNLOAD_DIR?.trim();
  const root = fromEnv
    ? path.resolve(fromEnv)
    : path.resolve(process.cwd(), "downloads");
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    /* best-effort */
  }
  return root;
}

/**
 * One-app first run: ensure ClientSettings exist with built-in as the default.
 *
 * Built-in is the *default*, not a lock-in: qBittorrent and Transmission can be
 * chosen as the primary client. An earlier version rewrote any external primary
 * back to builtin on every read, which made the choice impossible to keep and
 * turned the Client page's offline framing and its "switch to built-in"
 * recovery button into dead code. Recovering from an unreachable external
 * primary is that button's job, not this function's.
 *
 * Soft backfill: baseDownloadPath when missing.
 */
export async function ensureDefaultClientSettings(userId: string) {
  const existing = await prisma.clientSettings.findUnique({
    where: { userId },
  });

  if (!existing) {
    const baseDownloadPath = defaultDownloadDir();
    return prisma.clientSettings.create({
      data: {
        userId,
        clientType: "builtin",
        externalClientType: null,
        // Placeholder for optional external — builtin ignores host
        host: "http://127.0.0.1:8080",
        baseDownloadPath,
        category: "TV",
        categories: JSON.stringify(DEFAULT_CATEGORIES),
        pathRules: null,
      },
    });
  }

  const data: {
    baseDownloadPath?: string;
  } = {};

  // Soft backfill download root
  if (!existing.baseDownloadPath?.trim()) {
    data.baseDownloadPath = defaultDownloadDir();
  }

  if (Object.keys(data).length === 0) {
    return existing;
  }

  try {
    return await prisma.clientSettings.update({
      where: { userId },
      data,
    });
  } catch {
    return existing;
  }
}
