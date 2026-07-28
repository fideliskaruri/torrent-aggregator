/**
 * Rail builders for the Netflix-style browse payload.
 *
 * Each builder produces one rail. Empty rails are omitted, not rendered blank.
 * The whole payload is assembled by `buildBrowsePayload` in one round trip.
 */
import prisma from "@/lib/prisma";
import {
  resolveAvailabilityBatch,
  resolveLocalAvailabilityBatch,
} from "./availability";
import { buildDiscoveryRails } from "./discovery";
import { resolveArtworkForReleases, type Artwork } from "./artwork";
import { collapseReleasesByWork, UNKNOWN_WORK_TITLE } from "./collapse";
import { workIdentity } from "@/lib/torrents/work-identity";
import { parseEpisode } from "@/lib/torrents/episodes";
import { getBuiltinTorrentPresenceForAvailability } from "@/lib/clients/builtin-engine";
import type {
  Rail,
  RailItem,
  BrowsePayload,
  AvailabilityState,
} from "./types";

// ---------------------------------------------------------------------------
// Continue Watching
// ---------------------------------------------------------------------------

interface ContinueWatchingProgressRow {
  id: string;
  infoHash: string;
  filePath: string;
  positionSec: number;
  durationSec: number | null;
  title: string;
  season: number | null;
  episode: number | null;
  posterUrl: string | null;
  watchListItemId: string | null;
  updatedAt: Date;
}

interface ContinueWatchingTorrentRow {
  hash: string;
  name: string;
  progress: number;
  status: string;
}

interface ContinueWatchingWatchItemRow {
  id: string;
  title: string;
  posterUrl: string | null;
  mediaType: string | null;
}

interface ContinueWatchingWork {
  workKey: string;
  title: string;
  releaseName: string;
  artworkName: string;
  releaseCount: number;
  progress: ContinueWatchingProgressRow;
  torrent: ContinueWatchingTorrentRow | undefined;
  watchItem: ContinueWatchingWatchItemRow | undefined;
}

/**
 * In-progress episodes/movies: PlaybackProgress rows where completedAt is null,
 * most recent first. Each item carries percent-complete and resume position.
 */
async function buildContinueWatching(userId: string): Promise<Rail | null> {
  const rows = await prisma.playbackProgress.findMany({
    where: { userId, completedAt: null },
    orderBy: { updatedAt: "desc" },
    // Read wider than the rendered rail: multiple files from one work collapse
    // to one card, and a rail should not become sparse just because the viewer
    // sampled several episodes from the same show.
    take: 60,
  });

  if (rows.length === 0) return null;

  const watchListItemIds = [
    ...new Set(
      rows
        .map((r) => r.watchListItemId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];

  // Resolve the real availability of each row's torrent and the catalog/library
  // work it came from when playback recorded one.
  //
  // This rail used to hardcode `availability: "warm"`. `PlaybackProgress` has
  // no foreign key to `EngineTorrent` and nothing deletes progress rows when a
  // torrent is removed, so a deleted download kept rendering as "partially
  // downloaded" with a resume position and a Play button that could not play —
  // the one thing the availability rule (see the header of ./availability.ts)
  // forbids. Every other rail resolves state from `EngineTorrent`; so does
  // this one now. `null` when there is no engine row is the honest answer and
  // the UI already renders it as a neutral affordance.
  const hashes = [...new Set(rows.map((r) => r.infoHash.trim().toLowerCase()))];
  const [torrents, watchItems] = await Promise.all([
    prisma.engineTorrent.findMany({
      where: { userId, hash: { in: hashes } },
      select: { hash: true, name: true, progress: true, status: true },
    }),
    watchListItemIds.length > 0
      ? prisma.watchListItem.findMany({
          where: { userId, id: { in: watchListItemIds } },
          select: { id: true, title: true, posterUrl: true, mediaType: true },
        })
      : Promise.resolve([]),
  ]);

  // `PlaybackProgress.title` is supplied by the player and can be just the file
  // label (`S01E02`). Prefer the linked library/catalog work when present, use
  // the torrent release for release-backed rows, enrich missing posters through
  // the same artwork resolver as the other personal rails, and drop entries
  // that still cannot name a work. A shorter clean rail beats a row of
  // "Unknown title" letter tiles.
  const works = continueWatchingWorksFromRows(rows, torrents, watchItems).slice(0, 20);
  const artwork = await resolveArtworkForReleases(works.map((w) => w.artworkName));

  return continueWatchingRailFromWorks(userId, works, artwork);
}

function continueWatchingWorksFromRows(
  rows: readonly ContinueWatchingProgressRow[],
  torrents: readonly ContinueWatchingTorrentRow[],
  watchItems: readonly ContinueWatchingWatchItemRow[],
): ContinueWatchingWork[] {
  const byHash = new Map(torrents.map((t) => [t.hash.trim().toLowerCase(), t]));
  const byWatchItem = new Map(watchItems.map((w) => [w.id, w]));

  const collapsed = collapseReleasesByWork(
    rows.map((r) => {
      const hash = r.infoHash.trim().toLowerCase();
      const torrent = byHash.get(hash);
      const watchItem = r.watchListItemId
        ? byWatchItem.get(r.watchListItemId)
        : undefined;
      const releaseName = torrent?.name ?? progressIdentityName(r, watchItem);
      const workTitle = watchItem?.title?.trim() || undefined;
      return {
        name: releaseName,
        workTitle,
        sortAt: r.updatedAt,
        hasArtwork: r.posterUrl != null || watchItem?.posterUrl != null,
        prefer: workTitle != null,
        value: { progress: r, torrent, watchItem, releaseName },
      };
    }),
  );

  return collapsed
    .filter((work) => work.title !== UNKNOWN_WORK_TITLE)
    .map((work) => ({
      workKey: work.workKey,
      title: work.title,
      releaseName: work.name,
      artworkName:
        work.value.watchItem?.title?.trim() || work.value.releaseName || work.title,
      releaseCount: work.releaseCount,
      progress: work.value.progress,
      torrent: work.value.torrent,
      watchItem: work.value.watchItem,
    }));
}

function continueWatchingRailFromWorks(
  userId: string,
  works: readonly ContinueWatchingWork[],
  artwork: readonly Artwork[],
): Rail | null {
  const items: RailItem[] = works.map((work, i) => {
    const r = work.progress;
    const art = artwork[i];
    return {
      id: r.id,
      title: work.title,
      subtitle: formatEpisodeSubtitle(r.season, r.episode),
      posterUrl:
        r.posterUrl ?? work.watchItem?.posterUrl ?? art?.posterUrl ?? null,
      backdropUrl: art?.backdropUrl ?? null,
      availability: engineAvailability(userId, work.torrent),
      progressFraction:
        r.durationSec && r.durationSec > 0
          ? Math.min(r.positionSec / r.durationSec, 1)
          : null,
      resumePositionSec: r.positionSec,
      infoHash: r.infoHash,
      filePath: r.filePath,
      watchListItemId: r.watchListItemId,
      mediaType: work.watchItem?.mediaType ?? null,
      season: r.season,
      episode: r.episode,
    };
  });

  if (items.length === 0) return null;
  return { id: "continue-watching", title: "Continue Watching", items };
}

function progressIdentityName(
  row: ContinueWatchingProgressRow,
  watchItem: ContinueWatchingWatchItemRow | undefined,
): string {
  const title = watchItem?.title?.trim();
  const episode = formatEpisodeSubtitle(row.season, row.episode);
  if (title && episode) return `${title} ${episode}`;
  if (title) return title;
  return row.title;
}

/**
 * Map an EngineTorrent row to an availability state, or `null` when the
 * torrent is gone. `null` means "we cannot say", which is deliberately not the
 * same as `unavailable` — see ./availability.ts.
 */
function engineAvailability(
  userId: string,
  t: { hash: string; progress: number; status: string } | undefined,
): AvailabilityState | null {
  if (!t || t.status === "removed") return null;
  if (t.progress === 1) {
    const presence = getBuiltinTorrentPresenceForAvailability(userId, t.hash);
    if (presence === "present") return "ready";
    if (presence === "absent") return "fetchable";
    return null;
  }
  if (t.progress > 0 && t.status !== "error") return "warm";
  return null;
}

// ---------------------------------------------------------------------------
// Ready to Play
// ---------------------------------------------------------------------------

/**
 * Local torrents whose bytes have started arriving, collapsed by work so a
 * season pack is one card, not 24, and two releases of one show do not
 * duplicate.
 *
 * A partial torrent is still a playable local torrent in this app: the built-in
 * engine prioritizes the selected file's edges for streaming. Keep that state
 * honest by surfacing it as `warm`, never by pretending it is `ready`.
 *
 * Poster enrichment goes through the one artwork resolver (see ./artwork.ts),
 * the same one the discovery rails use. A miss is still `null` and the card
 * layer still draws its tinted tile, but a miss is now rare rather than the
 * designed-for common case.
 */
async function buildReadyToPlay(userId: string): Promise<Rail | null> {
  const rows = await prisma.engineTorrent.findMany({
    where: {
      userId,
      progress: { gt: 0 },
      status: { notIn: ["removed", "error"] },
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  const torrents = rows.filter(readyToPlayTorrentCanSurface);

  if (torrents.length === 0) return null;

  // Collapse through the shared work rule, not a local "coarse" key. The local
  // key kept dots, tracker prefixes and release suffixes in the bucket, so the
  // same show could render as `Rick.and.Morty...` and `www.UIndex.org - Rick and
  // Morty...` side by side even though `workIdentity()` already knew they were
  // one series.
  const cards = collapseReleasesByWork(
    torrents.map((t) => ({
      name: t.name,
      sortAt: t.updatedAt,
      prefer: readyRepresentativePreference(t.name),
      value: t,
    })),
  ).slice(0, 20);
  const artwork = await resolveArtworkForReleases(
    cards.map((g) => g.name),
  );

  const items: RailItem[] = [];
  for (const [i, work] of cards.entries()) {
    const torrent = work.value;
    const art = artwork[i];
    items.push({
      id: torrent.id,
      // Show the *work*, not the release. A card reading
      // "Children.of.Dune.S01.COMPLETE.720p.BluRay.x264-GalaxyTV" is a filename;
      // "Children of Dune" is a thing you can decide to watch. The scene name is
      // still the source of truth for identity — it is just not what a browse
      // rail should put in front of someone.
      title: work.title,
      subtitle: readyToPlaySubtitle(work.releaseCount, torrent.progress),
      posterUrl: art?.posterUrl ?? null,
      backdropUrl: art?.backdropUrl ?? null,
      availability: engineAvailability(userId, torrent),
      progressFraction: null,
      resumePositionSec: null,
      infoHash: torrent.hash,
      filePath: null,
      watchListItemId: null,
      mediaType: null,
      season: null,
      episode: null,
    });
  }

  return readyToPlayRailFromItems(items);
}

export function readyToPlayTorrentCanSurface(t: {
  progress: number;
  status: string;
}): boolean {
  return t.progress > 0 && t.status !== "removed" && t.status !== "error";
}

function readyToPlaySubtitle(
  releaseCount: number,
  progress: number,
): string | null {
  const parts: string[] = [];
  if (progress > 0 && progress < 1) {
    parts.push(`Downloading ${Math.max(1, Math.round(progress * 100))}%`);
  }
  if (releaseCount > 1) parts.push(`${releaseCount} files`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Ready-to-Play collapses a season pack and single up-next episodes into one
 * work card. Keep the pack as the playable representative: it is the row that
 * can open any episode in the season, while a prewarmed single is only one file.
 */
export function readyRepresentativePreference(name: string): boolean {
  const parsed = parseEpisode(name);
  return parsed.isSeasonPack === true;
}

function readyToPlayRailFromItems(items: RailItem[]): Rail | null {
  // `fetchable` here means the rehydrated engine definitively lacks the hash, so
  // it is not local. `warm` stays: partial local torrents are playable and the
  // card labels them as still downloading. `null` means cold-start / still
  // checking; keep the card so the rail does not vanish for content the DB says
  // the user completed.
  const readyItems = items.filter((item) => item.availability !== "fetchable");

  if (readyItems.length === 0) return null;

  return { id: "ready-to-play", title: "Ready to Play", items: readyItems };
}

// ---------------------------------------------------------------------------
// Next Up
// ---------------------------------------------------------------------------

/**
 * For monitored watchlist items, the next episode implied by cursor position,
 * with its availability state resolved (full: local + search cache).
 */
async function buildNextUp(userId: string): Promise<Rail | null> {
  const watchItems = await prisma.watchListItem.findMany({
    where: {
      userId,
      monitored: true,
      cursorSeason: { not: null },
      cursorEpisode: { not: null },
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  if (watchItems.length === 0) return null;

  const queries = watchItems.map((w) => ({
    title: w.title,
    season: w.cursorSeason,
    episode: w.cursorEpisode,
    mediaType: w.mediaType,
  }));

  const availabilities = await resolveAvailabilityBatch(userId, queries);

  const items: RailItem[] = [];
  for (let i = 0; i < watchItems.length; i++) {
    const w = watchItems[i];
    const avail = availabilities[i];

    items.push({
      id: `next-${w.id}`,
      title: w.title,
      subtitle: formatEpisodeSubtitle(w.cursorSeason, w.cursorEpisode),
      posterUrl: w.posterUrl,
      backdropUrl: null,
      availability: avail.state,
      progressFraction: avail.progress ?? null,
      resumePositionSec: null,
      infoHash: avail.infoHash ?? null,
      filePath: null,
      watchListItemId: w.id,
      mediaType: w.mediaType,
      season: w.cursorSeason,
      episode: w.cursorEpisode,
    });
  }

  if (items.length === 0) return null;

  return { id: "next-up", title: "Next Up", items };
}

// ---------------------------------------------------------------------------
// My Library
// ---------------------------------------------------------------------------

/**
 * The full watchlist, most recently updated first.
 *
 * Resolves ready/warm cheaply from EngineTorrent (one indexed query for the
 * batch). The expensive fetchable determination is left as `unknown` — the
 * user's own downloaded content must never falsely show as unavailable.
 */
async function buildMyLibrary(userId: string): Promise<Rail | null> {
  const items = await prisma.watchListItem.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 30,
  });

  if (items.length === 0) return null;

  // Cheap local-only availability: ready/warm from EngineTorrent, unknown otherwise
  const queries = items.map((w) => ({
    title: w.title,
    mediaType: w.mediaType,
  }));
  const availabilities = await resolveLocalAvailabilityBatch(userId, queries);

  const railItems: RailItem[] = items.map((w, i) => ({
    id: w.id,
    title: w.title,
    subtitle: w.lastEpisode ?? w.status,
    posterUrl: w.posterUrl,
    backdropUrl: null,
    availability: availabilities[i].state,
    progressFraction: availabilities[i].progress ?? null,
    resumePositionSec: null,
    infoHash: availabilities[i].infoHash ?? null,
    filePath: null,
    watchListItemId: w.id,
    mediaType: w.mediaType,
    season: null,
    episode: null,
  }));

  return { id: "my-library", title: "My Library", items: railItems };
}

// ---------------------------------------------------------------------------
// Recently Added
// ---------------------------------------------------------------------------

/**
 * Recent successful grabs from DownloadHistory, one card per *work*.
 *
 * These were successfully sent to a client, but we don't know their current
 * download state without checking EngineTorrent. Uses local-only availability
 * to show ready/warm when possible, `unknown` otherwise.
 *
 * ## One card per work, not per grab
 *
 * `DownloadHistory` records releases, and a user who grabs the 1080p and the
 * 2160p print of one film has two rows describing one thing they can watch.
 * Rendering both spends two of twenty slots on the same film and pushes a
 * different film off the end of the rail. `Ready to Play` has always collapsed
 * for the same reason; this rail now agrees with it, through the shared rule
 * in ./collapse.ts. Identity is the full `workIdentity()` key, so *Dune*
 * (1984) and *Dune* (2021) stay two cards.
 */
async function buildRecentlyAdded(userId: string): Promise<Rail | null> {
  // Read wider than the rail is long: collapsing removes rows, and a rail that
  // shrinks because someone grabbed two prints of one film is the same defect
  // in the other direction.
  const history = await prisma.downloadHistory.findMany({
    where: { userId, status: "sent" },
    orderBy: { createdAt: "desc" },
    take: 60,
  });

  if (history.length === 0) return null;

  // `DownloadHistory` has no artwork column, so no member can win on artwork
  // and the rule reduces to "newest survives" — which is what preserves the
  // `createdAt desc` ordering the query asked for.
  const works = collapseReleasesByWork(
    history.map((h) => ({ name: h.title, sortAt: h.createdAt, value: h })),
  ).slice(0, 20);

  const queries = works.map((w) => ({ title: w.value.title }));
  const [availabilities, artwork] = await Promise.all([
    resolveLocalAvailabilityBatch(userId, queries),
    resolveArtworkForReleases(works.map((w) => w.name)),
  ]);

  const items: RailItem[] = works.map((work, i) => {
    const h = work.value;
    const wi = workIdentity(h.title);
    const ep = parseEpisode(h.title);
    const art = artwork[i];
    return {
      id: h.id,
      title: work.title,
      // Only a collapsed group says anything worth saying here; a single grab
      // of an episode already says it in its own subtitle.
      subtitle:
        work.releaseCount > 1
          ? `${work.releaseCount} releases`
          : formatEpisodeSubtitle(
              wi.isSeries ? (ep.season ?? null) : null,
              wi.isSeries ? (ep.episode ?? null) : null,
            ),
      posterUrl: art?.posterUrl ?? null,
      backdropUrl: art?.backdropUrl ?? null,
      availability: availabilities[i].state,
      progressFraction: availabilities[i].progress ?? null,
      resumePositionSec: null,
      infoHash: h.infoHash ?? availabilities[i].infoHash ?? null,
      filePath: null,
      watchListItemId: null,
      mediaType: null,
      season: null,
      episode: null,
    };
  });

  return { id: "recently-added", title: "Recently Added", items };
}

// ---------------------------------------------------------------------------
// Payload assembler
// ---------------------------------------------------------------------------

/**
 * Build the complete browse payload in one round trip.
 *
 * All rails are fetched concurrently. Empty rails are filtered out.
 *
 * ## Order: personal first, discovery beneath
 *
 * Continue Watching is the most valuable row in the product and must never be
 * pushed below a chart of things the user has never heard of. So the five
 * personal rails keep their order and their place at the top, and the
 * discovery rails — which read a background-refreshed cache and require
 * nothing of the user — fill the page underneath them.
 *
 * On a brand-new install the personal rails are all empty and filtered out, so
 * the discovery rails *are* the page. That is the whole point of them: every
 * rail this app had required the user to have already done something, so a
 * fresh install rendered nothing and covered for it with an essay about what
 * the page would one day become.
 *
 * A discovery failure cannot take the personal rails down with it —
 * `buildDiscoveryRails` returns `[]` rather than throwing — and a personal-rail
 * failure still propagates, because that one means the local database is
 * unreadable and the page must say so.
 */
export async function buildBrowsePayload(
  userId: string,
): Promise<BrowsePayload> {
  const [personalResults, discoveryRails] = await Promise.all([
    Promise.all([
      buildContinueWatching(userId),
      buildReadyToPlay(userId),
      buildNextUp(userId),
      buildMyLibrary(userId),
      buildRecentlyAdded(userId),
    ]),
    buildDiscoveryRails(userId),
  ]);

  const rails = [
    ...personalResults.filter((r): r is Rail => r !== null),
    ...discoveryRails,
  ].filter((rail) => rail.items.length > 0);

  return {
    rails,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEpisodeSubtitle(
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (season != null && episode != null) {
    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }
  if (season != null) return `Season ${season}`;
  if (episode != null) return `Episode ${episode}`;
  return null;
}

export {
  continueWatchingRailFromWorks as _continueWatchingRailFromWorks,
  continueWatchingWorksFromRows as _continueWatchingWorksFromRows,
  readyToPlayRailFromItems as _readyToPlayRailFromItems,
};
