/**
 * Repairs library rows that were created without real catalog metadata.
 *
 * `scripts/seed-demo.mjs` invents placeholder externalIds ("seed-one-piece")
 * and supplies no artwork, so a seeded library renders as grey letter tiles
 * and cannot be looked up in TMDB / AniList at all. New rows no longer have
 * this problem (the watchlist POST resolves missing artwork itself), so this
 * is a one-time repair for rows created before that, not a permanent layer.
 *
 * Run: npx tsx scripts/backfill-metadata.mts [--dry]
 */
import { prisma } from "../src/lib/prisma";
import { searchAniList } from "../src/lib/metadata/anilist";
import { searchTmdb } from "../src/lib/metadata/tmdb";
import type { MediaMetadata } from "../src/lib/torrents/types";

const dry = process.argv.includes("--dry");

/** A real catalog id is numeric on both TMDB and AniList. */
function looksResolved(externalId: string): boolean {
  return /^\d+$/.test(externalId);
}

/**
 * The schema states externalId is "AniList id or TMDB id", with mediaType
 * telling you which. Resolving through the general enricher would break that
 * invariant — it arbitrates between both catalogs and can hand an anime row a
 * TMDB id — so each media type is resolved against the catalog it belongs to.
 */
/**
 * Compare titles with punctuation removed. Catalogs use typographic
 * apostrophes and colons that the stored title does not ("Dune Part Two" vs
 * "Dune: Part Two"), so a literal comparison rejects correct matches.
 */
function matchKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

async function resolveForRow(
  title: string,
  mediaType: string,
): Promise<MediaMetadata | null> {
  const wanted = matchKey(title);
  const candidates =
    mediaType === "anime"
      ? await searchAniList(title, 8)
      : (await searchTmdb(title, 8)).filter((c) => c.mediaType === mediaType);

  return candidates.find((c) => matchKey(c.title) === wanted) ?? null;
}

async function main() {
  const items = await prisma.watchListItem.findMany({
    select: {
      id: true,
      title: true,
      mediaType: true,
      externalId: true,
      posterUrl: true,
      userId: true,
    },
  });

  let repaired = 0;
  let skipped = 0;

  for (const item of items) {
    const needsId = !looksResolved(item.externalId);
    const needsArt = !item.posterUrl;
    if (!needsId && !needsArt) {
      skipped += 1;
      continue;
    }

    const resolved = await resolveForRow(item.title, item.mediaType);
    if (!resolved) {
      console.log(`  ? ${item.title} — no catalog match, left as-is`);
      skipped += 1;
      continue;
    }

    // The unique key is (userId, mediaType, externalId). Taking a real id can
    // collide with a row that already holds it, so check before moving.
    let nextExternalId = item.externalId;
    if (needsId) {
      const clash = await prisma.watchListItem.findUnique({
        where: {
          userId_mediaType_externalId: {
            userId: item.userId,
            mediaType: item.mediaType,
            externalId: resolved.externalId,
          },
        },
        select: { id: true },
      });
      if (!clash) nextExternalId = resolved.externalId;
    }

    const change = {
      externalId: nextExternalId,
      posterUrl: item.posterUrl ?? resolved.posterUrl ?? null,
      synopsis: resolved.synopsis ?? null,
      rating: resolved.rating ?? null,
    };

    console.log(
      `  ${dry ? "would fix" : "fixed"} ${item.title}: ` +
        `${item.externalId} -> ${change.externalId}` +
        `${change.posterUrl ? " +poster" : " (no poster available)"}`,
    );

    if (!dry) {
      await prisma.watchListItem.update({ where: { id: item.id }, data: change });
    }
    repaired += 1;
  }

  console.log(`\n${repaired} repaired, ${skipped} already fine.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
