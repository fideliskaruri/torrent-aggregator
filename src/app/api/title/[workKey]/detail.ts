/**
 * The title-page payload, assembled from what the database already knows.
 *
 * ## Why this does not call the shared availability resolver
 *
 * `@/lib/browse/availability` matches a torrent to a title by *normalised
 * containment* — `normalizeTitle(torrent.name).includes(normalizeTitle(query))`
 * — which is right for a rail, where the query is a catalog title and a false
 * positive costs a slightly wrong chip. It is wrong for a page whose entire
 * subject is one work: `"dune"` is contained in *Children of Dune*, so a title
 * page for Dune would list another show's episodes and offer to play them.
 * That is the exact failure `work-identity.ts` exists to prevent, so matching
 * here goes through `workKeyMatches` on the identity derived from each release
 * name. Everything else — the four states, and the meaning of `null` — is the
 * contract from `@/lib/browse`, unchanged.
 *
 * ## What may be claimed, and from what evidence
 *
 * | Claim         | Evidence required                                          |
 * |---------------|------------------------------------------------------------|
 * | `ready`       | An `EngineTorrent` for this work at progress 1, not removed |
 * | `warm`        | The same, partially downloaded and not errored              |
 * | `fetchable`   | A cached search result *belonging to this work* that passes `isViable` |
 * | `unavailable` | A cached search for this title that contains no such result |
 * | `null`        | Anything else — nobody has checked                          |
 *
 * Per-episode rows can reach `ready`, `warm`, `fetchable` and `null` but never
 * `unavailable`: the search cache is keyed on the *show* title (episode tokens
 * normalise away), so one cached S05E14 query would otherwise mark every other
 * episode of the season as checked-and-missing. Absence from one query is not
 * a check. `fetchable` is safe in the other direction — a viable release for
 * S05E13 sitting in the cached pool is positive evidence about S05E13.
 *
 * ## Speed
 *
 * Six indexed reads and no network call. The page must render instantly from
 * local state; anything slower is an *action*, not a precondition.
 */
import prisma from "@/lib/prisma";
import type { AvailabilityState } from "@/lib/browse";
import { searchHref } from "@/components/browse/availability";
import { formatEpisodeLabel } from "@/lib/library/cursor";
import {
  isSeriesMediaType,
  normalizeMediaType,
  searchCategoryForMediaType,
  type MediaType,
} from "@/lib/metadata/media-type";
import { parseEpisode } from "@/lib/torrents/episodes";
import { isViable } from "@/lib/torrents/quality";
import type { SearchResponse } from "@/lib/torrents/types";
import {
  retentionStateForOrigin,
  type RetentionState,
} from "@/lib/streaming/retention";

import { normalizeTitle } from "@/lib/utils";
import {
  displayTitleFromWorkKey,
  workIdentityFor,
  workKeyFor,
  workKeyMatches,
} from "@/components/title/work-key";
import type {
  TitleDetailPayload,
  TitleEpisode,
  TitleSeason,
} from "@/components/title/types";
import {
  findCachedCatalogRow,
  resolveArtworkBestEffort,
  type CachedCatalogRow,
} from "../artwork";

/** Rows scanned per table. A single-user install; these are whole-table caps. */
const SCAN_LIMIT = 400;

/**
 * Most episodes rendered for one season.
 *
 * Long-running anime is absolute-numbered into the thousands, and a thousand
 * DOM rows is a hang, not a feature. The list is capped and says so.
 */
const EPISODE_CAP = 200;

export interface TitleDetailQuery {
  userId: string;
  workKey: string;
  /** Everything below is what the linking card knew; all optional. */
  title?: string | null;
  year?: number | null;
  mediaType?: string | null;
  season?: number | null;
}

interface LocalRelease {
  hash: string;
  name: string;
  progress: number;
  status: string;
  season: number | null;
  episode: number | null;
  isPack: boolean;
  isMultiSeason: boolean;
  /**
   * Why this file is on disk. A "stream"/"prewarm" cache holds only the pieces
   * playback touched, so its whole-file percentage is meaningless as progress
   * and alarming as copy ("42% downloaded" under a Play button). Only a real
   * download the user kept ("kept", or legacy "unknown") may report a fraction.
   */
  retentionState: RetentionState;
}

interface CachedRelease {
  season: number | null;
  episode: number | null;
  isPack: boolean;
  viable: boolean;
}

export async function buildTitleDetail(
  query: TitleDetailQuery,
): Promise<TitleDetailPayload> {
  const workKey = query.workKey.trim().toLowerCase();
  const { userId } = query;

  const [catalogRows, watchRows, engineRows, progressRows] = await Promise.all([
    prisma.catalogEntry.findMany({
      where: { workKey },
      orderBy: { refreshedAt: "desc" },
      take: 5,
    }),
    prisma.watchListItem.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: SCAN_LIMIT,
    }),
    prisma.engineTorrent.findMany({
      where: { userId, status: { not: "removed" } },
      orderBy: { updatedAt: "desc" },
      take: SCAN_LIMIT,
    }),
    prisma.playbackProgress.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: SCAN_LIMIT,
    }),
  ]);

  // `CatalogEntry.workKey` is written by the discovery/catalog pipeline, which
  // derives it independently. If that derivation ever differs from this one by
  // so much as a hyphen the exact lookup simply misses, and the page would
  // silently lose its artwork and blurb while everything else still worked —
  // the kind of defect that survives a green test run. So a miss re-checks the
  // recent catalog by *computing* each row's key here, which is the same
  // one-directional test used everywhere else and cannot merge two works.
  const catalog =
    catalogRows[0] ?? (await findCatalogByComputedKey(workKey));

  // ── Identity ────────────────────────────────────────────────────────────
  //
  // Every candidate row is keyed with the *same* derivation the URL used, and
  // compared. The key is never parsed back apart — a slug cannot be inverted.
  const watch =
    watchRows.find((w) => workKeyMatches(workKey, w.title, null)) ?? null;

  const localReleases: LocalRelease[] = [];
  for (const row of engineRows) {
    const identity = workIdentityFor(row.name);
    if (!workKeyMatches(workKey, identity.name, identity.year)) continue;
    const ep = parseEpisode(row.name);
    localReleases.push({
      hash: row.hash,
      name: row.name,
      progress: row.progress,
      status: row.status,
      season: ep.season ?? null,
      episode: ep.episode ?? null,
      isPack: ep.isSeasonPack === true,
      isMultiSeason: ep.isMultiSeason === true,
      retentionState: retentionStateForOrigin(row.origin),
    });
  }

  // Which playback rows belong to *this* work. Matching on `title` alone is the
  // latent bug behind "resume opened the wrong episode": a PlaybackProgress row
  // stores the episode label ("S01E01") or the movie name in `title`, so a
  // series row never matches the show's workKey and genuine progress is
  // silently dropped — the page then falls back to S01E01. The reliable signals
  // are the file itself (its infoHash is one of this work's live local
  // releases, which are already work-scoped) and the watchlist link, with the
  // title match kept as the movie/last-resort path.
  const localHashes = new Set(
    localReleases.map((r) => r.hash.trim().toLowerCase()),
  );
  const progress = progressRows.filter((p) =>
    progressMatchesWork(p, workKey, localHashes, watch?.id ?? null),
  );

  const releaseName = localReleases[0]?.name ?? null;
  const releaseIdentity = releaseName ? workIdentityFor(releaseName) : null;

  const title =
    firstNonEmpty(
      catalog?.title,
      watch?.title,
      query.title,
      releaseIdentity?.name,
      progress[0]?.title,
    ) || displayTitleFromWorkKey(workKey);

  const mediaType: MediaType | null =
    normalizeMediaType(catalog?.mediaType) ??
    normalizeMediaType(watch?.mediaType) ??
    normalizeMediaType(query.mediaType);

  const year =
    catalog?.year ??
    (Number.isFinite(query.year) ? (query.year as number) : null) ??
    releaseIdentity?.year ??
    null;

  // ── Series or film ──────────────────────────────────────────────────────
  //
  // A declared type wins where we have one; otherwise the releases decide,
  // because a release name states its own season/episode structure and a
  // missing catalog row does not make a show a film.
  const episodeEvidence =
    localReleases.some((r) => r.season != null || r.episode != null || r.isPack) ||
    progress.some((p) => p.season != null || p.episode != null) ||
    (watch?.cursorSeason != null && watch?.cursorEpisode != null);
  const isSeries =
    mediaType === "movie"
      ? false
      : isSeriesMediaType(mediaType) || episodeEvidence;

  // ── The search cache: the only place `fetchable` can come from ──────────
  const cached = await readCachedSearch(title);
  const cachedReleases = cached ? releasesForWork(cached, workKey) : [];
  const searchWasRun = cached !== null;

  // ── Catalog artwork and blurb ───────────────────────────────────────────
  const cachedCatalog =
    catalog?.posterUrl && catalog?.overview
      ? null
      : await findCachedCatalogRow(title, mediaType, year);

  const artwork = await resolveArtwork({
    title,
    year,
    mediaType,
    catalogPoster: catalog?.posterUrl ?? null,
    catalogBackdrop: catalog?.backdropUrl ?? null,
    cachedCatalog,
    progressPoster: progress.find((p) => p.posterUrl)?.posterUrl ?? null,
  });

  // ── Local availability, title level ─────────────────────────────────────
  const titleLocal = pickLocal(localReleases, null, null);
  const titleState = resolveTitleState(titleLocal, cachedReleases, searchWasRun);

  // ── Seasons ─────────────────────────────────────────────────────────────
  const seasons = isSeries
    ? buildSeasons(localReleases, cachedReleases, progress, watch)
    : [];

  // ── Resume ──────────────────────────────────────────────────────────────
  //
  // Computed before the season is picked, so both derive from the *same*
  // resume decision: the hero button ("Resume S02E06") and the season the page
  // opens on can never disagree. Emitted only when the file the progress row
  // names is still present locally.
  const resume = resolveResume(progress, localReleases);

  const selectedSeason = isSeries
    ? pickSeason(seasons, query.season, resume?.season ?? null, progress, watch)
    : null;

  const episodes =
    selectedSeason == null
      ? []
      : buildEpisodes({
          season: selectedSeason,
          localReleases,
          cachedReleases,
          progress,
          cursorSeason: watch?.cursorSeason ?? null,
          cursorEpisode: watch?.cursorEpisode ?? null,
        });

  const episodesTruncated =
    selectedSeason != null &&
    highestEpisode({
      season: selectedSeason,
      localReleases,
      cachedReleases,
      progress,
      cursorSeason: watch?.cursorSeason ?? null,
      cursorEpisode: watch?.cursorEpisode ?? null,
    }) > EPISODE_CAP;

  const known =
    catalog !== null ||
    watch !== null ||
    localReleases.length > 0 ||
    progress.length > 0 ||
    cachedReleases.length > 0 ||
    cachedCatalog !== null;

  return {
    workKey,
    title,
    year,
    mediaType,
    isSeries,
    // Same provenance rule as the artwork below: `WatchListItem.synopsis` and
    // `.rating` are written by the watchlist's name-similarity enrichment, so
    // they can describe a different work entirely. A blurb and a score are
    // claims as much as a poster is.
    overview: firstNonEmpty(catalog?.overview, cachedCatalog?.synopsis) || null,
    rating: catalog?.rating ?? cachedCatalog?.rating ?? null,
    posterUrl: artwork.posterUrl,
    backdropUrl: artwork.backdropUrl,
    // The primary release / first-air date, when a catalog row carries one.
    // Drives the future-gating visual on the title page (grayed, "Coming",
    // disabled). Unknown stays null and is never gated.
    releaseDate:
      (catalog?.releaseDate ?? cachedCatalog?.releaseDate)?.toISOString() ??
      null,

    availability: titleState,
    infoHash: titleLocal?.hash ?? null,
    downloadFraction: keptDownloadFraction(titleLocal),

    resume,
    seasons,
    season: selectedSeason,
    episodes,
    episodesTruncated,

    library: {
      inLibrary: watch !== null,
      watchListItemId: watch?.id ?? null,
      monitored: watch?.monitored ?? false,
      status: watch?.status ?? null,
      cursorSeason: watch?.cursorSeason ?? null,
      cursorEpisode: watch?.cursorEpisode ?? null,
      addPayload: {
        // The grabber compares media types with `===`, and the library needs
        // *some* type; an unknown one defaults in the open rather than being
        // hidden inside the shared module (see media-type.ts).
        mediaType: mediaType ?? (isSeries ? "tv" : "movie"),
        externalId: cachedCatalog?.externalId?.trim() || `work:${workKey}`,
        title,
        posterUrl: artwork.posterUrl,
        synopsis:
          firstNonEmpty(catalog?.overview, cachedCatalog?.synopsis) || null,
        rating: catalog?.rating ?? cachedCatalog?.rating ?? null,
      },
    },

    releasesHref: searchHref(title, searchCategoryForMediaType(mediaType)),
    known,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * The whole-file download percentage to advertise for a release, or null.
 *
 * A percentage is only meaningful for a file the user is *downloading* to keep:
 * a stream/prewarm cache holds only the pieces playback needed, so its fraction
 * is always low and reads as a stalled download. Streaming is not downloading —
 * the watch surfaces show state ("Buffering", "Playing"), never a percentage.
 */
function keptDownloadFraction(release: LocalRelease | null): number | null {
  if (!release) return null;
  if (release.retentionState === "stream" || release.retentionState === "prewarm") {
    return null;
  }
  return release.progress > 0 && release.progress < 1 ? release.progress : null;
}

/**
 * The best local release for a title, season or episode.
 *
 * "Best" is `ready` over `warm`, because a complete file plays and seeks while
 * a partial one only plays. A removed or errored row is not a candidate — a
 * Play button for a deleted download is the exact defect the availability
 * contract exists to forbid.
 */
function pickLocal(
  releases: LocalRelease[],
  season: number | null,
  episode: number | null,
): LocalRelease | null {
  const matching = releases.filter((r) => coversEpisode(r, season, episode));
  const ready = matching.find((r) => r.progress >= 1 && r.status !== "error");
  if (ready) return ready;
  const warm = matching.find(
    (r) => r.progress > 0 && r.progress < 1 && r.status !== "error",
  );
  return warm ?? null;
}

/** Does this local release contain the requested season/episode? */
function coversEpisode(
  release: LocalRelease,
  season: number | null,
  episode: number | null,
): boolean {
  if (season == null && episode == null) return true;

  // A multi-season pack covers everything under this work; a season pack
  // covers its own season only. Neither names an episode, and inventing one
  // would be a claim about a file we have not looked inside.
  if (release.isMultiSeason) return true;
  if (release.isPack) return release.season === season;

  if (season != null && release.season != null && release.season !== season) {
    return false;
  }
  // Absolute-numbered releases (`One Piece - 1170`) state no season. They are
  // displayed under the first season, which is where this treats them.
  if (season != null && release.season == null && season !== 1) return false;
  if (episode != null) return release.episode === episode;
  return true;
}

function localState(release: LocalRelease | null): AvailabilityState | null {
  if (!release) return null;
  if (release.progress >= 1) return "ready";
  if (release.progress > 0) return "warm";
  return null;
}

/**
 * Title-level state.
 *
 * Local first, because that check is cheap and certain. Then the cached
 * search: a viable release belonging to this work is `fetchable`; a search
 * that ran and produced none is the only thing that earns `unavailable`.
 */
function resolveTitleState(
  local: LocalRelease | null,
  cachedReleases: CachedRelease[],
  searchWasRun: boolean,
): AvailabilityState | null {
  const state = localState(local);
  if (state) return state;
  if (cachedReleases.some((r) => r.viable)) return "fetchable";
  if (searchWasRun) return "unavailable";
  return null;
}

/**
 * Per-episode state. Never `unavailable` — see the module header for why.
 */
function episodeState(
  local: LocalRelease | null,
  cachedReleases: CachedRelease[],
  season: number,
  episode: number,
): AvailabilityState | null {
  const state = localState(local);
  if (state) return state;

  const fetchable = cachedReleases.some(
    (r) =>
      r.viable &&
      ((r.episode === episode && (r.season == null || r.season === season)) ||
        (r.isPack && r.season === season)),
  );
  return fetchable ? "fetchable" : null;
}

// ---------------------------------------------------------------------------
// Seasons and episodes
// ---------------------------------------------------------------------------

function buildSeasons(
  localReleases: LocalRelease[],
  cachedReleases: CachedRelease[],
  progress: { season: number | null; episode: number | null }[],
  watch: { cursorSeason: number | null } | null,
): TitleSeason[] {
  const numbers = new Set<number>();
  for (const r of localReleases) {
    if (r.isMultiSeason) continue;
    if (r.season != null) numbers.add(r.season);
    else if (r.episode != null) numbers.add(1);
  }
  for (const r of cachedReleases) {
    if (r.season != null) numbers.add(r.season);
    else if (r.episode != null) numbers.add(1);
  }
  for (const p of progress) if (p.season != null) numbers.add(p.season);
  if (watch?.cursorSeason != null) numbers.add(watch.cursorSeason);

  return [...numbers]
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b)
    .map((season) => {
      const packRelease = localReleases.find(
        (r) => r.isPack && r.season === season && r.progress > 0,
      );
      const state = localState(packRelease ?? null);
      return {
        season,
        knownEpisodes: countKnownEpisodes(
          season,
          localReleases,
          cachedReleases,
          progress,
        ),
        pack:
          packRelease && state
            ? {
                name: packRelease.name,
                availability: state,
                infoHash: packRelease.hash,
                downloadFraction: keptDownloadFraction(packRelease),
              }
            : null,
      } satisfies TitleSeason;
    });
}

function countKnownEpisodes(
  season: number,
  localReleases: LocalRelease[],
  cachedReleases: CachedRelease[],
  progress: { season: number | null; episode: number | null }[],
): number {
  const numbers = new Set<number>();
  for (const r of localReleases) {
    if (r.episode == null) continue;
    if ((r.season ?? 1) !== season) continue;
    numbers.add(r.episode);
  }
  for (const r of cachedReleases) {
    if (r.episode == null) continue;
    if ((r.season ?? 1) !== season) continue;
    numbers.add(r.episode);
  }
  for (const p of progress) {
    if (p.episode == null) continue;
    if ((p.season ?? 1) !== season) continue;
    numbers.add(p.episode);
  }
  return numbers.size;
}

/**
 * Which season the page opens on.
 *
 * The one asked for, else the one being resumed, else the one being watched,
 * else the one the library is hunting, else the first. Resume is preferred over
 * a bare "watching" scan so the season the page opens on and the hero's
 * Resume button are the *same* decision — never a split where the button says
 * S02E06 but the list shows season 1.
 */
export function pickSeason(
  seasons: TitleSeason[],
  requested: number | null | undefined,
  resumeSeason: number | null,
  progress: { season: number | null; updatedAt: Date }[],
  watch: { cursorSeason: number | null } | null,
): number | null {
  if (seasons.length === 0) return null;
  const available = new Set(seasons.map((s) => s.season));

  if (requested != null && available.has(requested)) return requested;

  if (resumeSeason != null && available.has(resumeSeason)) return resumeSeason;

  const watching = progress.find((p) => p.season != null && available.has(p.season));
  if (watching?.season != null) return watching.season;

  if (watch?.cursorSeason != null && available.has(watch.cursorSeason)) {
    return watch.cursorSeason;
  }
  return seasons[0].season;
}

interface EpisodeBuildInput {
  season: number;
  localReleases: LocalRelease[];
  cachedReleases: CachedRelease[];
  progress: {
    season: number | null;
    episode: number | null;
    infoHash: string;
    filePath: string;
    positionSec: number;
    durationSec: number | null;
    completedAt: Date | null;
  }[];
  cursorSeason: number | null;
  cursorEpisode: number | null;
}

/**
 * The highest episode number we have evidence for in this season.
 *
 * Enumerating 1..N from it is not a guess: episode numbering is dense, so
 * knowing episode 14 exists is knowing 1–13 do. Knowing *nothing* yields 0 and
 * the list stays empty rather than inventing a first episode.
 */
function highestEpisode(input: EpisodeBuildInput): number {
  const { season } = input;
  let max = 0;
  for (const r of input.localReleases) {
    if (r.episode == null) continue;
    if ((r.season ?? 1) !== season) continue;
    max = Math.max(max, r.episode);
  }
  for (const r of input.cachedReleases) {
    if (r.episode == null) continue;
    if ((r.season ?? 1) !== season) continue;
    max = Math.max(max, r.episode);
  }
  for (const p of input.progress) {
    if (p.episode == null) continue;
    if ((p.season ?? 1) !== season) continue;
    max = Math.max(max, p.episode);
  }
  if (input.cursorSeason === season && input.cursorEpisode != null) {
    max = Math.max(max, input.cursorEpisode);
  }
  return max;
}

function buildEpisodes(input: EpisodeBuildInput): TitleEpisode[] {
  const { season } = input;
  const count = Math.min(highestEpisode(input), EPISODE_CAP);
  if (count <= 0) return [];

  const rows: TitleEpisode[] = [];
  for (let episode = 1; episode <= count; episode++) {
    const local = pickLocal(input.localReleases, season, episode);
    const state = episodeState(local, input.cachedReleases, season, episode);
    const watched = input.progress.find(
      (p) => (p.season ?? 1) === season && p.episode === episode,
    );

    const fraction =
      watched && watched.durationSec && watched.durationSec > 0
        ? Math.min(watched.positionSec / watched.durationSec, 1)
        : null;

    // A resume position is only offered for a file that still exists. Progress
    // rows outlive the torrents they describe — nothing deletes them — so the
    // info hash comes from the *engine* row, never from the progress row.
    const infoHash = local?.hash ?? null;

    rows.push({
      season,
      episode,
      label: formatEpisodeLabel(season, episode),
      availability: state,
      infoHash,
      filePath: infoHash && watched?.infoHash === infoHash ? watched.filePath : null,
      downloadFraction: keptDownloadFraction(local),
      watchedFraction: fraction,
      resumePositionSec:
        infoHash && watched?.infoHash === infoHash && !watched.completedAt
          ? watched.positionSec
          : null,
      watched: Boolean(watched?.completedAt),
      nextUp:
        input.cursorSeason === season && input.cursorEpisode === episode,
      fromPack: Boolean(local?.isPack || local?.isMultiSeason),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/**
 * Does a playback-progress row belong to this work?
 *
 * `PlaybackProgress.title` holds the *episode label* ("S01E01") for a series or
 * the movie name for a film, and there is no workKey column — so a title match
 * alone silently drops every series row and the page loses "resume where I left
 * off". The dependable signals are:
 *
 *  - **the file**: the row's `infoHash` is one of this work's live local
 *    releases (which are already scoped to the work by `workIdentityFor`), and
 *  - **the watchlist link**: the row's `watchListItemId` is this work's item.
 *
 * The title match is kept as the movie / last-resort path. Any one is enough.
 */
export function progressMatchesWork(
  row: {
    title: string | null;
    infoHash: string;
    watchListItemId: string | null;
  },
  workKey: string,
  localHashes: Set<string>,
  watchListItemId: string | null,
): boolean {
  if (row.infoHash && localHashes.has(row.infoHash.trim().toLowerCase())) {
    return true;
  }
  if (
    watchListItemId &&
    row.watchListItemId != null &&
    row.watchListItemId === watchListItemId
  ) {
    return true;
  }
  if (row.title && workKeyMatches(workKey, row.title, null)) return true;
  return false;
}

/**
 * Where playback should pick up, or null.
 *
 * Emitted only when the torrent the progress row names is still present. There
 * is no foreign key from `PlaybackProgress` to `EngineTorrent` and nothing
 * deletes progress when a download is removed, so trusting the progress row
 * alone is how a Play button for a deleted file reaches the screen.
 */
export function resolveResume(
  progress: {
    infoHash: string;
    filePath: string;
    positionSec: number;
    durationSec: number | null;
    completedAt: Date | null;
    season: number | null;
    episode: number | null;
  }[],
  localReleases: LocalRelease[],
): TitleDetailPayload["resume"] {
  const live = new Map(
    localReleases.map((r) => [r.hash.trim().toLowerCase(), r] as const),
  );

  for (const row of progress) {
    if (row.completedAt) continue;
    if (row.positionSec <= 0) continue;
    const release = live.get(row.infoHash.trim().toLowerCase());
    if (!release) continue;

    return {
      infoHash: release.hash,
      filePath: row.filePath || null,
      positionSec: row.positionSec,
      durationSec: row.durationSec,
      fraction:
        row.durationSec && row.durationSec > 0
          ? Math.min(row.positionSec / row.durationSec, 1)
          : null,
      season: row.season,
      episode: row.episode,
      label:
        row.season != null && row.episode != null
          ? formatEpisodeLabel(row.season, row.episode)
          : null,
    };
  }
  return null;
}

/**
 * The most recent catalog row whose *computed* key is this one.
 *
 * A fallback, not the primary path: the indexed `workKey` lookup answers first
 * and this only runs when it found nothing.
 */
async function findCatalogByComputedKey(workKey: string) {
  const rows = await prisma.catalogEntry.findMany({
    orderBy: { refreshedAt: "desc" },
    take: SCAN_LIMIT,
  });
  return (
    rows.find((row) => workKeyMatches(workKey, row.title, row.year)) ?? null
  );
}

// ---------------------------------------------------------------------------
// Search cache
// ---------------------------------------------------------------------------

/**
 * The most recent cached search for this title, stale rows included.
 *
 * Looked up by `normalizedQuery`, never by rebuilding `cacheKey`: that key is
 * a sha256 over the entire option set (category, limit, sources, filters and
 * the user's target resolution), so a consumer that rebuilds it from guessed
 * values misses 100% of the time — which is how `fetchable` and `unavailable`
 * were once unreachable states with every test still green.
 */
async function readCachedSearch(title: string): Promise<SearchResponse | null> {
  const key = normalizeTitle(title);
  if (!key) return null;
  try {
    const row = await prisma.searchCache.findFirst({
      where: { normalizedQuery: key },
      orderBy: { expiresAt: "desc" },
      select: { payload: true },
    });
    if (!row) return null;
    return JSON.parse(row.payload) as SearchResponse;
  } catch {
    // A corrupt or unreadable cache is "we have not checked", not a failure.
    return null;
  }
}

/**
 * The cached results that actually belong to this work.
 *
 * A search for "dune" returns *Children of Dune* and *Dune: Prophecy* too, so
 * every result is re-identified and keyed before it may say anything about
 * this page.
 */
function releasesForWork(
  response: SearchResponse,
  workKey: string,
): CachedRelease[] {
  const out: CachedRelease[] = [];
  for (const result of response.results ?? []) {
    const identity = workIdentityFor(result.title, result.metadata ?? null);
    if (!workKeyMatches(workKey, identity.name, identity.year)) continue;
    const ep = result.episode ?? parseEpisode(result.title);
    out.push({
      season: ep.season ?? null,
      episode: ep.episode ?? null,
      isPack: ep.isSeasonPack === true,
      viable: isViable(result),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

async function resolveArtwork(input: {
  title: string;
  year: number | null;
  mediaType: MediaType | null;
  catalogPoster: string | null;
  catalogBackdrop: string | null;
  cachedCatalog: CachedCatalogRow | null;
  progressPoster: string | null;
}): Promise<{ posterUrl: string | null; backdropUrl: string | null }> {
  // `WatchListItem.posterUrl` is deliberately not a source here. That column is
  // filled by the fuzzy enrichment in `POST /api/watchlist`, which matches on
  // name similarity alone: adding the invented film "The Quiet Cartographer"
  // stores the poster and synopsis of *The Quiet* (2005) against it. Borrowing
  // it would let this page state, full-bleed, a claim nothing ever checked.
  // The rows kept below all carry provenance: a catalog row keyed to this
  // work, a cached row that passed `catalogAgrees`, or artwork the player
  // recorded against a file of this work that was actually played.
  const posterUrl =
    input.catalogPoster ??
    input.cachedCatalog?.posterUrl ??
    input.progressPoster ??
    null;
  const backdropUrl =
    input.catalogBackdrop ?? input.cachedCatalog?.backdropUrl ?? null;

  if (posterUrl || backdropUrl) return { posterUrl, backdropUrl };

  // Nothing cached locally. One time-budgeted best-effort attempt, which
  // returns empty artwork rather than delaying the page if it cannot answer.
  const remote = await resolveArtworkBestEffort({
    title: input.title,
    year: input.year,
    mediaType: input.mediaType,
  });
  return {
    posterUrl: remote.posterUrl ?? null,
    backdropUrl: remote.backdropUrl ?? null,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function firstNonEmpty(
  ...values: (string | null | undefined)[]
): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** Exported for the grab route, which needs the same identity test. */
export { workKeyFor };
