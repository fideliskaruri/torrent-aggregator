/**
 * The rails a brand-new install has on day zero.
 *
 * Every rail this app shipped with was personal — Continue Watching, Ready to
 * Play, Next Up, My Library, Recently Added — and every one of them required
 * the user to have already done something. So the home page of a fresh install
 * was blank, and it covered for that with a heading reading "What this page
 * becomes" over a diagram of dashed rectangles. A catalog that explains what
 * it will one day contain is not a catalog.
 *
 * These three rows are what makes the page a product on first launch:
 *
 *   Trending now             — this week's film chart, from TMDB
 *   Popular series           — this week's television chart, from TMDB
 *   Because you're watching X — TMDB's own recommendations for the seed
 *
 * ## Two rules this file is built around
 *
 * **It reads; it does not compute.** Every row here is one indexed query
 * against `CatalogEntry`. The catalog is fetched on a timer by
 * `@/lib/catalog/refresh`, never during a render, because a rail that resolves
 * anything per tile is how a catalog page starts feeling like a search engine.
 *
 * **`availability` is `null`, and `null` is not `"unavailable"`.** A trending
 * title is not on disk and no indexer search has been run for it, so no claim
 * can be made either way — and that stays true even for the rows the torrent
 * charts *did* have a seeder count for, because a chart entry is not a
 * verified download. `null` is the honest answer and the card layer already
 * renders it as a neutral, clickable "Check" that leads to search. Writing
 * `"unavailable"` here would tell the user that this week's most watched film
 * cannot be had — a claim nobody made and nobody checked.
 */
import { readCatalogRows, type CatalogRow } from "@/lib/catalog/store";
import { ensureCatalogFresh, refreshRelatedForSeed } from "@/lib/catalog/refresh";
import { readWatchSeed, type CatalogSeed } from "@/lib/catalog/seed";
import { normalizeMediaType } from "@/lib/metadata/media-type";
import { isSlopTitle } from "@/lib/metadata/slop";
import type { Rail, RailItem } from "./types";

/** How many cards a discovery rail shows. */
export const DISCOVERY_RAIL_SIZE = 24;

export const TRENDING_RAIL_ID = "trending-now";
export const POPULAR_RAIL_ID = "popular-series";
export const BECAUSE_RAIL_ID = "because-you-are-watching";

/**
 * Build the discovery rails. Never throws.
 *
 * A catalog problem — a dead network on a cold install, an unreadable table,
 * a feed that changed shape — must cost the page its discovery rows and
 * nothing else. The personal rails are assembled from the local database and
 * have no business failing because apibay is down.
 */
export async function buildDiscoveryRails(userId: string): Promise<Rail[]> {
  try {
    await ensureCatalogFresh();
  } catch (err) {
    console.error("[discovery] catalog refresh unavailable", err);
  }

  const [trending, popular] = await Promise.all([
    safeRows("trending"),
    safeRows("popular"),
  ]);

  const rails: Rail[] = [];

  const because = await buildBecauseRail(userId, newestOf([...trending, ...popular]));
  if (because) rails.push(because);

  if (trending.length > 0) {
    rails.push({
      id: TRENDING_RAIL_ID,
      title: "Trending now",
      items: trending.map(toRailItem),
    });
  }

  if (popular.length > 0) {
    rails.push({
      id: POPULAR_RAIL_ID,
      title: "Popular series",
      items: popular.map(toRailItem),
    });
  }

  return rails;
}

/**
 * "Because you're watching X", or nothing at all.
 *
 * Only ever rendered when there genuinely is an X: the seed comes from the
 * user's own `PlaybackProgress` / `WatchListItem` rows, and no seed means no
 * row. Fabricating one — naming a popular title the user has never opened —
 * would be a lie the UI has no way to look wrong about.
 */
async function buildBecauseRail(
  userId: string,
  baseRefreshedAt: Date | null,
): Promise<Rail | null> {
  let seed: CatalogSeed | null = null;
  try {
    seed = await readWatchSeed(userId);
  } catch (err) {
    console.error("[discovery] seed unavailable", err);
    return null;
  }
  if (!seed) return null;

  let rows = await safeRelatedRows(seed.title);

  // The partition is derived from the trending/popular rows, so it is stale the
  // moment those are rewritten — and missing entirely the first time a user
  // starts watching something new.
  const outdated =
    (baseRefreshedAt !== null && newestOf(rows) !== null &&
      newestOf(rows)!.getTime() < baseRefreshedAt.getTime());

  if (rows.length === 0) {
    // Nothing at all to show. Worth a bounded wait — the rebuild caps its own
    // network time and falls back to cache — because the alternative is a
    // missing row rather than a slightly stale one.
    try {
      await refreshRelatedForSeed(seed);
      rows = await safeRelatedRows(seed.title);
    } catch (err) {
      console.error("[discovery] related build failed", err);
    }
  } else if (outdated) {
    // Stale but serveable: render what is here and rebuild behind the page.
    // Same stale-while-revalidate discipline the catalog itself uses, and the
    // reason a browse read never waits on TMDB in the common case.
    void refreshRelatedForSeed(seed).catch((err) => {
      console.error("[discovery] related rebuild failed", err);
    });
  }

  if (rows.length === 0) return null;

  return {
    id: BECAUSE_RAIL_ID,
    title: `Because you're watching ${seed.title}`,
    items: rows.map(toRailItem),
  };
}

/**
 * One catalog row as a card.
 *
 * Every field the card layer can act on is either a fact from the row or
 * `null`. There is no info hash because nothing is on disk, no progress
 * because nothing has been watched, and no availability because nothing has
 * been searched for.
 */
export function toRailItem(row: CatalogRow): RailItem {
  return {
    id: `catalog-${row.id}`,
    title: row.title,
    // The release year, when the catalog knows one. TMDB does for almost
    // everything; a work reverse-engineered from release names often does not,
    // and an invented year under a poster is a fact nobody checked.
    subtitle: row.year ? String(row.year) : null,
    posterUrl: row.posterUrl,
    backdropUrl: row.backdropUrl,
    // The synopsis, when the catalog has one. The hero leads with this and
    // falls back to a short status clause only when it is absent, so leaving
    // the field unfilled — as this function did — meant nearly every title
    // was described by mechanical copy about the downloader rather than by
    // what the film is about.
    overview: row.overview,
    // Not a claim. See the module header: nobody has searched for this, so
    // `null` ("not determined") is the only honest answer, and the card layer
    // turns it into a neutral, clickable affordance rather than a dead control.
    availability: null,
    // The catalog's stored release / first-air date, as an ISO `YYYY-MM-DD`
    // string. TMDB's trending charts are full of next-year titles ("Toy Story
    // 5", "Avengers: Doomsday"); carrying the date lets the card layer gray them
    // and label "Coming {date}" via release-status.ts instead of offering a dead
    // Play. Null (unknown) is never gated.
    releaseDate: row.releaseDate ? row.releaseDate.toISOString().slice(0, 10) : null,
    progressFraction: null,
    resumePositionSec: null,
    infoHash: null,
    filePath: null,
    watchListItemId: null,
    // Normalised through the shared module so the card's search link lands in
    // a category that can actually contain what was clicked.
    mediaType: normalizeMediaType(row.mediaType),
    season: null,
    episode: null,
  };
}

async function safeRows(
  source: "trending" | "popular",
): Promise<CatalogRow[]> {
  try {
    const rows = await readCatalogRows(source, null, DISCOVERY_RAIL_SIZE);
    // Last-resort guard: a placeholder that predates the slop filter on the
    // write path must not survive a read. See @/lib/metadata/slop.
    return rows.filter((row) => !isSlopTitle(row.title));
  } catch (err) {
    console.error(`[discovery] ${source} rows unavailable`, err);
    return [];
  }
}

async function safeRelatedRows(seedTitle: string): Promise<CatalogRow[]> {
  try {
    const rows = await readCatalogRows("related", seedTitle, DISCOVERY_RAIL_SIZE);
    return rows.filter((row) => !isSlopTitle(row.title));
  } catch (err) {
    console.error("[discovery] related rows unavailable", err);
    return [];
  }
}

/** The most recent `refreshedAt` in a set of rows, or null when there are none. */
function newestOf(rows: readonly CatalogRow[]): Date | null {
  let newest: Date | null = null;
  for (const row of rows) {
    if (!newest || row.refreshedAt.getTime() > newest.getTime()) {
      newest = row.refreshedAt;
    }
  }
  return newest;
}
