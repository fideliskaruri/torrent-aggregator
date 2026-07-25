/**
 * Verify ClientSettings.upsert accepts externalClientType (Prisma client in sync).
 * Run: npx tsx scripts/test-settings-upsert.ts
 */
import prisma from "../src/lib/prisma";
import { LOCAL_USER_ID } from "../src/lib/auth-constants";

async function main() {
  const userId = LOCAL_USER_ID;
  const existing = await prisma.clientSettings.findUnique({ where: { userId } });
  console.log("before:", {
    clientType: existing?.clientType,
    externalClientType: (existing as { externalClientType?: string | null } | null)
      ?.externalClientType,
  });

  const settings = await prisma.clientSettings.upsert({
    where: { userId },
    create: {
      userId,
      clientType: "builtin",
      externalClientType: null,
      host: "http://127.0.0.1:8080",
      baseDownloadPath: existing?.baseDownloadPath ?? "D:\\Torrents",
      savePath: existing?.savePath ?? "D:\\Torrents",
      username: existing?.username,
      password: existing?.password,
      categories: existing?.categories,
      pathRules: existing?.pathRules,
    },
    update: {
      // touch only externalClientType to prove field is known
      externalClientType:
        (existing as { externalClientType?: string | null } | null)
          ?.externalClientType ?? "qbittorrent",
    },
  });

  console.log("upsert OK:", {
    clientType: settings.clientType,
    externalClientType: settings.externalClientType,
    baseDownloadPath: settings.baseDownloadPath,
  });

  // WatchListItem cursor fields too
  const cols = await prisma.watchListItem.findFirst({
    where: { userId },
    select: {
      id: true,
      title: true,
      fromSeason: true,
      cursorSeason: true,
      cursorEpisode: true,
      monitorMode: true,
    },
  });
  console.log("watchlist sample fields OK:", cols ?? "(no items)");
  console.log("PASS settings upsert");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

main().catch(async (e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
