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
 * There is no safe download-folder default.
 *
 * A server working directory, test fixture, or environment inherited from an
 * end-to-end run is not a durable media library. Keep this compatibility
 * helper explicit and side-effect free: first-run setup must collect the path.
 */
export function defaultDownloadDir(): string {
  return "";
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
