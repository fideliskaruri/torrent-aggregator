/**
 * Exercise real send path with builtin client (no HTTP session).
 * Uses first user + a tiny public magnet / Family Guy search top result.
 * Run: npx tsx scripts/test-builtin-send.ts
 */
import prisma from "../src/lib/prisma";
import {
  getUserClientConfig,
  sendToClient,
} from "../src/lib/clients";
import { searchTorrents } from "../src/lib/torrents/aggregator";
import { resolveSmartSendTarget } from "../src/lib/download/smart-target";
import { resolveHuntCursor, afterSuccessfulGrab } from "../src/lib/library/cursor";

async function main() {
  const user = await prisma.user.findFirst();
  if (!user) throw new Error("no user in DB — sign in once first");
  console.log("user:", user.id, user.email ?? user.name);

  const config = await getUserClientConfig(user.id);
  if (!config) throw new Error("no client config");
  console.log("client:", {
    clientType: config.clientType,
    externalClientType: config.externalClientType,
    base: config.baseDownloadPath,
  });

  // Simulate library hunt for Family Guy from S09
  const item = {
    title: "Family Guy",
    mediaType: "tv",
    fromSeason: 9,
    fromEpisode: 1,
    cursorSeason: 9,
    cursorEpisode: 1,
    lastEpisode: null as string | null,
    nextEpisodeHint: null as string | null,
  };
  const hunt = resolveHuntCursor(item);
  console.log("hunt:", hunt);

  const search = await searchTorrents({
    query: hunt.query,
    category: "tv",
    limit: 10,
    enrich: false,
    skipCache: true,
    filters: {
      hasMagnet: true,
      minSeeders: 1,
      season: hunt.cursor?.season,
      episode: hunt.cursor?.episode,
    },
  });
  console.log("search hits:", search.totalCount);

  const best = search.results.find((t) => t.magnet && (t.seeders ?? 0) > 0);
  if (!best?.magnet) {
    // Nothing to send because the public indexers are blocked or empty, not
    // because the send path is broken. Skip rather than cry wolf.
    console.log(
      "SKIP: no seeded magnet available —",
      (search.sources || [])
        .map((s) => `${s.id}:${s.count}${s.error ? " " + s.error : ""}`)
        .join(", "),
    );
    process.exit(0);
  }
  console.log("sending:", best.title.slice(0, 80), "seeds", best.seeders);

  const target = resolveSmartSendTarget(config, {
    name: best.title,
    source: best.source,
    searchCategory: "tv",
  });
  console.log("target path:", target.savePath, "cat:", target.category);

  const result = await sendToClient(config, {
    magnet: best.magnet,
    name: best.title,
    category: target.category,
    savePath: target.savePath,
  });
  console.log("send result:", result);

  if (!result.ok) {
    throw new Error(`send failed: ${result.message}`);
  }

  const advanced = afterSuccessfulGrab(item.title, hunt.cursor, best.title);
  console.log("cursor advance:", advanced);

  // Upsert a library item as automation would
  const wl = await prisma.watchListItem.upsert({
    where: {
      userId_mediaType_externalId: {
        userId: user.id,
        mediaType: "tv",
        externalId: "test-family-guy-s09",
      },
    },
    create: {
      userId: user.id,
      mediaType: "tv",
      externalId: "test-family-guy-s09",
      title: "Family Guy",
      monitored: true,
      fromSeason: 9,
      fromEpisode: 1,
      cursorSeason: advanced.cursorSeason,
      cursorEpisode: advanced.cursorEpisode,
      lastEpisode: advanced.lastEpisode,
      nextEpisodeHint: advanced.nextEpisodeHint,
      latestReleaseTitle: best.title,
      latestReleaseMagnet: best.magnet,
      status: "watching",
    },
    update: {
      fromSeason: 9,
      fromEpisode: 1,
      cursorSeason: advanced.cursorSeason,
      cursorEpisode: advanced.cursorEpisode,
      lastEpisode: advanced.lastEpisode,
      nextEpisodeHint: advanced.nextEpisodeHint,
      latestReleaseTitle: best.title,
      latestReleaseMagnet: best.magnet,
      monitored: true,
    },
  });
  console.log("watchlist row:", {
    id: wl.id,
    fromSeason: wl.fromSeason,
    cursor: `${wl.cursorSeason}x${wl.cursorEpisode}`,
    last: wl.lastEpisode,
    next: wl.nextEpisodeHint,
  });

  console.log("PASS builtin send + library cursor persist");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

main().catch(async (e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
