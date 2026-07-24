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
 * One-app first run: ensure ClientSettings with built-in as primary.
 *
 * Migration: users who previously set qBittorrent/Transmission as *primary*
 * are moved to primary=builtin with credentials kept as optional external
 * ("Send to my client"). Stops Client page dying when qBit is closed.
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
    clientType?: string;
    externalClientType?: string | null;
  } = {};

  // Soft backfill download root
  if (!existing.baseDownloadPath?.trim()) {
    data.baseDownloadPath = defaultDownloadDir();
  }

  // Promote external-as-primary → builtin primary + optional external
  // Only when they never set externalClientType (legacy rows).
  const primary = (existing.clientType || "builtin").toLowerCase();
  const hasExternalField =
    existing.externalClientType != null &&
    existing.externalClientType.trim() !== "";

  if (
    (primary === "qbittorrent" || primary === "transmission") &&
    !hasExternalField
  ) {
    data.clientType = "builtin";
    data.externalClientType = primary;
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
