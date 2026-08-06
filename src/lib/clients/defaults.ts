import { homedir } from "node:os";
import { join } from "node:path";
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

/**
 * A suggested download folder for the first-run settings page.
 *
 * This is a UI hint only — it is never written to the DB automatically.
 * The user must confirm it before any download uses it. We use the OS home
 * directory so the suggestion is a real, writable path on every platform
 * (~/Downloads/TorrentFlow on Unix, %USERPROFILE%\Downloads\TorrentFlow on
 * Windows). A server working directory or test fixture must never be used
 * here because the DB row is created before setup completes.
 */
export function defaultDownloadDir(): string {
  return join(homedir(), "Downloads", "TorrentFlow");
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
 * Folder and storage limits are deliberately not backfilled. Both require an
 * explicit owner decision during setup.
 */
export async function ensureDefaultClientSettings(userId: string) {
  const existing = await prisma.clientSettings.findUnique({
    where: { userId },
  });

  if (!existing) {
    return prisma.clientSettings.create({
      data: {
        userId,
        clientType: "builtin",
        externalClientType: null,
        // Placeholder for optional external — builtin ignores host
        host: "http://127.0.0.1:8080",
        baseDownloadPath: null,
        maxStorageBytes: null,
        storageCapConfigured: null,
        // No default label. Every send is categorised from the release's own
        // identity, so seeding "TV" here only lets uncategorised content be
        // asserted as a TV series and written into the real TV/ folder that
        // season logic then trusts.
        category: null,
        categories: JSON.stringify(DEFAULT_CATEGORIES),
        pathRules: null,
      },
    });
  }
  return existing;
}
