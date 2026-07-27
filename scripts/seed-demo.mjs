/**
 * Seeds a realistic, *populated* app so screenshots and manual QA show the
 * product as a user with a history sees it.
 *
 * Why this exists in its present form: the earlier version only created
 * watchlist items and rules, so every personal rail on the home page
 * (Continue Watching, Ready to Play, Next Up, Recently Added) stayed empty
 * after seeding. Reviewing a "seeded" build therefore still showed an empty
 * home page, and that emptiness was read as a design problem rather than a
 * missing fixture. A seed that does not light up the rails is not a seed.
 *
 * Rail → table mapping this must satisfy (see src/lib/browse/rails.ts):
 *   Continue Watching → PlaybackProgress with completedAt = null
 *   Ready to Play     → EngineTorrent with progress = 1
 *   Next Up           → WatchListItem cursor fields
 *   My Library        → WatchListItem
 *   Recently Added    → EngineTorrent by createdAt
 * Posters for the torrent-derived rails are resolved through CachedMetadata,
 * so that table is seeded too — otherwise the cards render as bare text tiles
 * and a populated page still looks broken.
 *
 * Writes go through Prisma directly rather than the HTTP API: the seed must
 * work before a server is up, and the progress/engine rows have no public
 * write route at all.
 *
 * Usage:  node scripts/seed-demo.mjs [--reset]
 *   --reset  remove previously seeded rows first (seeded rows only)
 */
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import path from "node:path";
import "dotenv/config";

const LOCAL_USER_ID = "local";
const LOCAL_USER_NAME = "You";
const RESET = process.argv.includes("--reset");

/** Marks every row this script creates so --reset can undo exactly its own work. */
const SEED_TAG = "seed-";

function createPrisma() {
  const raw = process.env.DATABASE_URL || "file:./dev.db";
  let url = raw;
  if (raw.startsWith("file:")) {
    const fp = raw.slice(5);
    if (!path.isAbsolute(fp)) {
      url = `file:${path
        .resolve(process.cwd(), fp.replace(/^\.\//, ""))
        .replace(/\\/g, "/")}`;
    }
  }
  return new PrismaClient({ adapter: new PrismaLibSql({ url }) });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Release names are deliberately real scene names, not clean titles. The whole
 * work-identity layer exists to turn these into something watchable, and a
 * fixture of pre-cleaned titles would exercise none of it — which is how the
 * "five separate Dunes" grouping defect survived earlier review.
 */
const WATCHING = [
  {
    key: "severance",
    title: "Severance",
    mediaType: "tv",
    tmdbQuery: "Severance",
    tmdbType: "tv",
    release: "Severance.S02E04.2160p.ATVP.WEB-DL.DDP5.1.Atmos.HDR.H.265-FLUX",
    season: 2,
    episode: 4,
    positionSec: 1170,
    durationSec: 2640,
  },
  {
    key: "the-bear",
    title: "The Bear",
    mediaType: "tv",
    tmdbQuery: "The Bear",
    tmdbType: "tv",
    release: "The.Bear.S03E06.1080p.BluRay.x265.DDP5.1-GalaxyTV",
    season: 3,
    episode: 6,
    positionSec: 640,
    durationSec: 1980,
  },
  {
    key: "dune-two",
    title: "Dune Part Two",
    mediaType: "movie",
    tmdbQuery: "Dune Part Two",
    tmdbType: "movie",
    release:
      "Dune.Part.Two.2024.2160p.BluRay.REMUX.HDR.DV.TrueHD.7.1.Atmos-FraMeSToR",
    season: null,
    episode: null,
    positionSec: 4320,
    durationSec: 9960,
  },
];

/** Finished — must NOT appear in Continue Watching. Proves the completion filter. */
const COMPLETED = [
  {
    key: "arrival",
    title: "Arrival",
    mediaType: "movie",
    tmdbQuery: "Arrival",
    tmdbType: "movie",
    release: "Arrival.2016.1080p.BluRay.x264.DTS-HD.MA.7.1-SWTYBLZ",
    positionSec: 6780,
    durationSec: 6840,
  },
];

/** Downloaded and sitting on disk → Ready to Play. */
const READY = [
  {
    key: "prophecy",
    title: "Dune Prophecy",
    mediaType: "tv",
    tmdbQuery: "Dune Prophecy",
    tmdbType: "tv",
    release:
      "Dune.Prophecy.S01E01.The.Hidden.Hand.2160p.MAX.WEB-DL.DDP5.1.Atmos.HDR.H.265-NTb",
    sizeBytes: 9_300_000_000,
  },
  {
    key: "frieren",
    title: "Frieren Beyond Journey's End",
    mediaType: "anime",
    tmdbQuery: "Frieren Beyond Journey's End",
    tmdbType: "tv",
    release: "[SubsPlease] Sousou no Frieren - 28 (1080p) [F1D2A9C0].mkv",
    sizeBytes: 1_400_000_000,
  },
  {
    key: "shogun",
    title: "Shogun",
    mediaType: "tv",
    tmdbQuery: "Shogun",
    tmdbType: "tv",
    release: "Shogun.2024.S01.COMPLETE.1080p.DSNP.WEB-DL.DDP5.1.H.264-NTb",
    sizeBytes: 24_000_000_000,
  },
];

/** Still downloading → Recently Added, and proves a non-1 progress renders. */
const DOWNLOADING = [
  {
    key: "silo",
    title: "Silo",
    mediaType: "tv",
    tmdbQuery: "Silo",
    tmdbType: "tv",
    release: "Silo.S02E09.1080p.ATVP.WEB-DL.DDP5.1.Atmos.H.264-FLUX",
    sizeBytes: 3_100_000_000,
    progress: 0.42,
  },
];

/** Monitored series → My Library and Next Up. */
const LIBRARY = [
  {
    externalId: `${SEED_TAG}severance`,
    mediaType: "tv",
    title: "Severance",
    fromSeason: 2,
    fromEpisode: 1,
    cursorSeason: 2,
    cursorEpisode: 5,
    monitorMode: "ongoing",
    tmdbQuery: "Severance",
    tmdbType: "tv",
  },
  {
    externalId: `${SEED_TAG}the-bear`,
    mediaType: "tv",
    title: "The Bear",
    fromSeason: 3,
    fromEpisode: 1,
    cursorSeason: 3,
    cursorEpisode: 7,
    monitorMode: "ongoing",
    tmdbQuery: "The Bear",
    tmdbType: "tv",
  },
  {
    externalId: `${SEED_TAG}one-piece`,
    mediaType: "anime",
    title: "One Piece",
    fromSeason: 21,
    fromEpisode: 1085,
    cursorSeason: 21,
    cursorEpisode: 1122,
    monitorMode: "ongoing",
    tmdbQuery: "One Piece",
    tmdbType: "tv",
  },
  {
    externalId: `${SEED_TAG}frieren`,
    mediaType: "anime",
    title: "Frieren Beyond Journey's End",
    fromSeason: 1,
    fromEpisode: 1,
    cursorSeason: 1,
    cursorEpisode: 29,
    monitorMode: "backfill",
    tmdbQuery: "Frieren",
    tmdbType: "tv",
  },
  {
    externalId: `${SEED_TAG}dune-two`,
    mediaType: "movie",
    title: "Dune Part Two",
    monitorMode: "on_demand",
    tmdbQuery: "Dune Part Two",
    tmdbType: "movie",
  },
];

const RULES = [
  {
    name: "4K movies, well seeded",
    query: "2160p",
    category: "movies",
    minSeeders: 20,
    resolution: "2160p",
    maxSizeBytes: 20_000_000_000,
    enabled: true,
  },
  {
    name: "Weekly anime, 1080p",
    query: "1080p",
    category: "anime",
    minSeeders: 10,
    resolution: "1080p",
    enabled: true,
  },
  {
    name: "Archived rule (disabled)",
    query: "720p",
    category: "tv",
    minSeeders: 5,
    enabled: false,
  },
];

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

const TMDB_KEY = (process.env.TMDB_API_KEY || "").trim();
/**
 * A short key is a placeholder, not a credential. Treating a 2-character value
 * as "configured" is exactly how this app ran with zero artwork while looking
 * correctly configured, so length is checked rather than presence.
 */
const TMDB_USABLE = TMDB_KEY.length >= 20;

async function tmdbArtwork(query, type) {
  if (!TMDB_USABLE) return null;
  try {
    const url =
      `https://api.themoviedb.org/3/search/${type}` +
      `?api_key=${encodeURIComponent(TMDB_KEY)}&query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const json = await res.json();
    const hit = (json.results || [])[0];
    if (!hit) return null;
    return {
      externalId: String(hit.id),
      title: hit.title || hit.name || query,
      posterUrl: hit.poster_path
        ? `https://image.tmdb.org/t/p/w500${hit.poster_path}`
        : null,
      backdropUrl: hit.backdrop_path
        ? `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}`
        : null,
      synopsis: hit.overview || null,
      rating: typeof hit.vote_average === "number" ? hit.vote_average : null,
      year:
        Number(
          String(hit.release_date || hit.first_air_date || "").slice(0, 4),
        ) || null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Deterministic 40-hex so re-running updates rather than duplicates.
 *
 * The salt exists because an earlier revision seeded magnets, which the live
 * engine adopted; those hashes are now held in memory by any long-running dev
 * server and get their progress persisted back as 0 on every poll. Seeding
 * into a distinct hash namespace means a fixture can never be confused with a
 * torrent the engine is actually tracking.
 */
function fakeHash(seed) {
  let h = "";
  let x = 0;
  const salted = `tf-demo-v2:${seed}`;
  for (let i = 0; i < salted.length; i++) {
    x = (x * 31 + salted.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < 5; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    h += x.toString(16).padStart(8, "0");
  }
  return h.slice(0, 40);
}

async function main() {
  const prisma = createPrisma();
  const log = (...a) => console.log(...a);

  try {
    await prisma.user.upsert({
      where: { id: LOCAL_USER_ID },
      update: {},
      create: { id: LOCAL_USER_ID, name: LOCAL_USER_NAME },
    });

    if (RESET) {
      const hashes = [
        ...WATCHING,
        ...COMPLETED,
        ...READY,
        ...DOWNLOADING,
      ].map((s) => fakeHash(s.key));
      await prisma.playbackProgress.deleteMany({
        where: { userId: LOCAL_USER_ID, infoHash: { in: hashes } },
      });
      await prisma.engineTorrent.deleteMany({
        where: { userId: LOCAL_USER_ID, hash: { in: hashes } },
      });
      await prisma.watchListItem.deleteMany({
        where: { userId: LOCAL_USER_ID, externalId: { startsWith: SEED_TAG } },
      });
      log("reset: removed previously seeded rows");
    }

    if (!TMDB_USABLE) {
      log(
        `WARN TMDB_API_KEY is ${TMDB_KEY.length} chars — too short to be real.\n` +
          "     Seeding without artwork: cards will render as text tiles.\n",
      );
    }

    // 1) Artwork cache. Everything downstream reads posters from here.
    const all = [...WATCHING, ...COMPLETED, ...READY, ...DOWNLOADING, ...LIBRARY];
    const artByTitle = new Map();
    const seen = new Set();
    for (const item of all) {
      const q = item.tmdbQuery;
      if (!q || seen.has(q)) continue;
      seen.add(q);
      const art = await tmdbArtwork(q, item.tmdbType || "movie");
      if (!art) {
        log(`  --  artwork miss: ${q}`);
        continue;
      }
      artByTitle.set(q, art);
      const cacheKey = `${SEED_TAG}tmdb:${item.tmdbType}:${q}`;
      const fields = {
        title: art.title,
        posterUrl: art.posterUrl,
        backdropUrl: art.backdropUrl,
        synopsis: art.synopsis,
        rating: art.rating,
        year: art.year,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
      };
      await prisma.cachedMetadata.upsert({
        where: { cacheKey },
        update: fields,
        create: {
          cacheKey,
          source: "tmdb",
          mediaType: item.mediaType === "anime" ? "anime" : item.tmdbType,
          externalId: art.externalId,
          ...fields,
        },
      });
      log(`  ok  artwork: ${art.title}${art.posterUrl ? "" : " (no poster)"}`);
    }

    // 2) Torrents on disk / in flight.
    //
    // `magnet` is deliberately left null. The built-in engine rehydrates every
    // EngineTorrent row that HAS a magnet into the live WebTorrent client on
    // the first list/add (`rehydrateFromDb`, gated on `magnet: { not: null }`),
    // then persists real progress back. Seeding a magnet for a hash no swarm
    // has ever heard of therefore makes the engine adopt the row, park it at
    // "metaDL" forever, and overwrite progress with 0 — which silently emptied
    // the Ready to Play rail minutes after a successful seed. A fixture must
    // not pretend to be a live swarm. Because these rows are intentionally not
    // engine-backed, availability now downgrades them to `fetchable`; an empty
    // demo "Ready to Play" rail is expected and correct.
    for (const t of [...READY, ...DOWNLOADING, ...WATCHING, ...COMPLETED]) {
      const hash = fakeHash(t.key);
      const progress = t.progress ?? 1;
      const status = progress >= 1 ? "seeding" : "downloading";
      await prisma.engineTorrent.upsert({
        where: { userId_hash: { userId: LOCAL_USER_ID, hash } },
        update: { name: t.release, progress, status, magnet: null },
        create: {
          userId: LOCAL_USER_ID,
          hash,
          name: t.release,
          magnet: null,
          category: t.mediaType,
          status,
          progress,
          sizeBytes: BigInt(t.sizeBytes ?? 2_000_000_000),
          origin: "user",
        },
      });
      log(`  ok  torrent: ${t.release.slice(0, 60)}`);
    }

    // 3) Playback progress — the Continue Watching rail.
    for (const w of WATCHING) {
      const hash = fakeHash(w.key);
      const art = artByTitle.get(w.tmdbQuery);
      const filePath = `${w.release}.mkv`;
      await prisma.playbackProgress.upsert({
        where: {
          userId_infoHash_filePath: {
            userId: LOCAL_USER_ID,
            infoHash: hash,
            filePath,
          },
        },
        update: {
          positionSec: w.positionSec,
          durationSec: w.durationSec,
          completedAt: null,
          posterUrl: art?.posterUrl ?? null,
        },
        create: {
          userId: LOCAL_USER_ID,
          infoHash: hash,
          filePath,
          positionSec: w.positionSec,
          durationSec: w.durationSec,
          title: w.title,
          season: w.season,
          episode: w.episode,
          posterUrl: art?.posterUrl ?? null,
        },
      });
      const pct = Math.round((w.positionSec / w.durationSec) * 100);
      log(`  ok  watching: ${w.title} @ ${pct}%`);
    }

    for (const c of COMPLETED) {
      const hash = fakeHash(c.key);
      const filePath = `${c.release}.mkv`;
      await prisma.playbackProgress.upsert({
        where: {
          userId_infoHash_filePath: {
            userId: LOCAL_USER_ID,
            infoHash: hash,
            filePath,
          },
        },
        update: { completedAt: new Date(), positionSec: c.positionSec },
        create: {
          userId: LOCAL_USER_ID,
          infoHash: hash,
          filePath,
          positionSec: c.positionSec,
          durationSec: c.durationSec,
          completedAt: new Date(),
          title: c.title,
          posterUrl: artByTitle.get(c.tmdbQuery)?.posterUrl ?? null,
        },
      });
      log(`  ok  completed: ${c.title} (must not show in Continue Watching)`);
    }

    // 4) Library / monitoring.
    for (const item of LIBRARY) {
      const art = artByTitle.get(item.tmdbQuery);
      const data = {
        title: item.title,
        posterUrl: art?.posterUrl ?? null,
        synopsis: art?.synopsis ?? null,
        rating: art?.rating ?? null,
        fromSeason: item.fromSeason ?? null,
        fromEpisode: item.fromEpisode ?? null,
        cursorSeason: item.cursorSeason ?? null,
        cursorEpisode: item.cursorEpisode ?? null,
        monitorMode: item.monitorMode,
        monitored: true,
      };
      await prisma.watchListItem.upsert({
        where: {
          userId_mediaType_externalId: {
            userId: LOCAL_USER_ID,
            mediaType: item.mediaType,
            externalId: item.externalId,
          },
        },
        update: data,
        create: {
          userId: LOCAL_USER_ID,
          mediaType: item.mediaType,
          externalId: item.externalId,
          ...data,
        },
      });
      log(`  ok  library: ${item.title}`);
    }

    // 5) Rules — matched by name so re-running does not duplicate.
    for (const rule of RULES) {
      const existing = await prisma.autoRule.findFirst({
        where: { userId: LOCAL_USER_ID, name: rule.name },
      });
      if (existing) {
        log(`  ok  rule exists: ${rule.name}`);
        continue;
      }
      await prisma.autoRule.create({
        data: {
          userId: LOCAL_USER_ID,
          name: rule.name,
          query: rule.query,
          category: rule.category,
          minSeeders: rule.minSeeders,
          resolution: rule.resolution ?? null,
          maxSizeBytes: rule.maxSizeBytes ? BigInt(rule.maxSizeBytes) : null,
          enabled: rule.enabled,
        },
      });
      log(`  ok  rule: ${rule.name}`);
    }

    // Report what the home page should now show, so a silent no-op is visible.
    const [inProgress, ready, downloading, library, rules, art] =
      await Promise.all([
        prisma.playbackProgress.count({
          where: { userId: LOCAL_USER_ID, completedAt: null },
        }),
        prisma.engineTorrent.count({
          where: { userId: LOCAL_USER_ID, progress: 1 },
        }),
        prisma.engineTorrent.count({
          where: { userId: LOCAL_USER_ID, progress: { lt: 1 } },
        }),
        prisma.watchListItem.count({ where: { userId: LOCAL_USER_ID } }),
        prisma.autoRule.count({ where: { userId: LOCAL_USER_ID } }),
        prisma.cachedMetadata.count({ where: { posterUrl: { not: null } } }),
      ]);

    log("\n--- home page should now show ---");
    log(`  Continue Watching : ${inProgress} in progress`);
    log(`  Ready to Play     : ${ready} finished torrents`);
    log(`  Recently Added    : ${ready + downloading} torrents`);
    log(`  My Library        : ${library} monitored items`);
    log(`  Rules             : ${rules}`);
    log(`  Artwork rows      : ${art} with a poster`);

    if (inProgress === 0 || ready === 0 || library === 0) {
      log("\nFAIL a rail would still be empty — the seed did not do its job");
      process.exitCode = 1;
    } else if (art === 0) {
      log("\nWARN seeded, but with no artwork at all (check TMDB_API_KEY)");
    } else {
      log("\nPASS every personal rail has data");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
