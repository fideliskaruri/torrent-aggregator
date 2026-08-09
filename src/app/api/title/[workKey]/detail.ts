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
import {
  acquisitionTransferFromRow,
  resolveAcquisitionTransfer,
  type AcquisitionTransfer,
} from "./acquisition-target";
import type { AvailabilityState } from "@/lib/browse";
import { formatEpisodeLabel } from "@/lib/library/cursor";
import {
  fileConfirmedMissing,
  localFilePresence,
} from "@/lib/library/local-file-presence";
import {
  isSeriesMediaType,
  type MediaType,
} from "@/lib/metadata/media-type";
import { parseEpisode } from "@/lib/torrents/episodes";
import { packEpisodeFiles } from "@/lib/torrents/pack-episode-files";
import { heldFilesFromVerifiedJson } from "@/lib/library/deletion-plan";
import { isViable } from "@/lib/torrents/quality";
import {
  persistedTorrentHasInvalidMedia,
  persistedTorrentIsDownloaded,
} from "@/lib/clients/builtin-engine-lifecycle";
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
  TitleEpisodeTransfer,
  TitleSeason,
} from "@/components/title/types";
import { resolveTitleIntent } from "@/components/title/title-intent";
import { bucketTargetsByScope } from "./acquisition-scopes";
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
  /**
   * A season the user picked by hand on a previous visit to this title, read
   * from the durable `tf_season` cookie by the server page component (never
   * by this route directly — see `src/lib/title/remembered-season.ts`). Beats
   * a stale watch cursor / default in `pickSeason`, never resume/progress.
   */
  rememberedSeason?: number | null;
  providerIdentity?: import("./provider-identity").TitleProviderIdentity | null;
}

export interface LocalRelease {
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
  /**
   * The filesystem says the recorded file is gone — the owner deleted it
   * outside the app. Nothing deletes `EngineTorrent` when that happens, so the
   * row survives and would keep offering Play/Resume for a file that cannot be
   * opened. Rows are kept (they still scope playback history to this work) but
   * may not make a local claim. `unknown` presence is not `missing`; see
   * `library/local-file-presence.ts`.
   */
  fileMissing: boolean;
}

/**
 * May this row assert "we have this locally"? Every Play/Resume/pack surface
 * asks here rather than testing the flag itself, so a new surface cannot
 * quietly forget the check.
 */
function canMakeLocalClaim(release: LocalRelease): boolean {
  return !release.fileMissing;
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
  const providerIdentity = query.providerIdentity ?? null;
  const providerMetadata = providerIdentity?.metadata ?? null;

  const [catalogRows, watchRows, engineRows, progressRows, targetRows] = await Promise.all([
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
    prisma.acquisitionTarget.findMany({
      where: { userId, workKey },
      orderBy: { updatedAt: "desc" },
      take: SCAN_LIMIT,
    }),
  ]);

  const engineByHash = new Map(
    engineRows.map((row) => [row.hash.trim().toLowerCase(), row]),
  );
  const missingLinkedHashes = [
    ...new Set(
      targetRows
        .map((target) => target.infoHash?.trim().toLowerCase() ?? "")
        .filter((hash) => hash && !engineByHash.has(hash)),
    ),
  ];
  if (missingLinkedHashes.length > 0) {
    const linkedRows = await prisma.engineTorrent.findMany({
      where: {
        userId,
        hash: { in: missingLinkedHashes },
        status: { not: "removed" },
      },
    });
    for (const row of linkedRows) {
      engineRows.push(row);
      engineByHash.set(row.hash.trim().toLowerCase(), row);
    }
  }
  // Three maps, not one flattened view.
  //
  // The write path (`route.ts`) records targets at `title`, `season` and
  // `episode` scope. This read used to ask for `scope: "episode"` only, so a
  // movie you had just sent, or a season pack mid-download, came back with no
  // transfer at all — and the page, seeing nothing in flight, offered Download
  // again beside a torrent the Client was actively fetching.
  //
  // They stay separate because they are separate claims. A season pack at 40%
  // says nothing about whether episode 3 is playable, and copying its progress
  // onto every episode row would manufacture exactly the false certainty the
  // episode contract forbids. Each scope is reconciled against the engine on
  // its own and read back only by the control that owns it.
  //
  // The bucketing itself lives in `acquisition-scopes.ts` so the rule is
  // testable without a database — the original defect was a `where` clause,
  // which no offline test could ever have caught.
  const buckets = bucketTargetsByScope(targetRows);
  const episodeTransfers = new Map<string, AcquisitionTransfer>();
  const seasonTransfers = new Map<number, AcquisitionTransfer>();
  let titleTransfer: AcquisitionTransfer | null = null;
  const targetUpdates: Promise<unknown>[] = [];

  const reconcile = (target: (typeof targetRows)[number]): AcquisitionTransfer => {
    const persisted = acquisitionTransferFromRow(target);
    const engine = target.infoHash
      ? engineByHash.get(target.infoHash.trim().toLowerCase()) ?? null
      : null;
    const invalidMedia = engine ? persistedTorrentHasInvalidMedia(engine) : false;
    const resolved = resolveAcquisitionTransfer(
      persisted,
      engine
        ? {
            hash: engine.hash,
            status: invalidMedia ? "error" : engine.status,
            progress: engine.progress,
          }
        : null,
      engine ? (invalidMedia ? "absent" : localFilePresence(engine)) : "unknown",
    );
    if (
      resolved.status !== persisted.status ||
      resolved.progress !== persisted.progress ||
      resolved.infoHash !== persisted.infoHash ||
      resolved.filePath !== persisted.filePath ||
      resolved.error !== persisted.error
    ) {
      targetUpdates.push(
        prisma.acquisitionTarget.update({
          where: { id: target.id },
          data: {
            status: resolved.status,
            progress: resolved.progress,
            infoHash: resolved.infoHash,
            filePath: resolved.filePath,
            error: resolved.error,
          },
        }),
      );
    }
    return resolved;
  };

  if (buckets.title) titleTransfer = reconcile(buckets.title);
  for (const [season, target] of buckets.seasons) {
    seasonTransfers.set(season, reconcile(target));
  }
  for (const [key, target] of buckets.episodes) {
    episodeTransfers.set(key, reconcile(target));
  }
  // Malformed rows still get reconciled: a stale `downloading` claim must not
  // outlive the torrent just because its scope columns are inconsistent. They
  // are simply never read back as a transfer for any control.
  for (const target of buckets.malformed) reconcile(target);
  if (targetUpdates.length > 0) await Promise.all(targetUpdates);

  // `CatalogEntry.workKey` is written by the discovery/catalog pipeline, which
  // derives it independently. If that derivation ever differs from this one by
  // so much as a hyphen the exact lookup simply misses, and the page would
  // silently lose its artwork and blurb while everything else still worked —
  // the kind of defect that survives a green test run. So a miss re-checks the
  // recent catalog by *computing* each row's key here, which is the same
  // one-directional test used everywhere else and cannot merge two works.
  const catalogCandidate =
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
    const invalidMedia = persistedTorrentHasInvalidMedia(row);
    localReleases.push({
      hash: row.hash,
      name: row.name,
      progress: row.progress,
      status: invalidMedia ? "error" : row.status,
      season: ep.season ?? null,
      episode: ep.episode ?? null,
      isPack: ep.isSeasonPack === true,
      isMultiSeason: ep.isMultiSeason === true,
      retentionState: retentionStateForOrigin(row.origin),
      fileMissing: invalidMedia || fileConfirmedMissing(localFilePresence(row)),
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

  const intent = resolveTitleIntent({
    workKey,
    selection: {
      title: providerMetadata?.title ?? query.title,
      year: providerMetadata?.year ?? query.year,
      mediaType: providerMetadata?.mediaType ?? query.mediaType,
      aliases: providerMetadata?.aliases,
    },
    catalog: catalogCandidate
      ? {
          title: catalogCandidate.title,
          year: catalogCandidate.year,
          mediaType: catalogCandidate.mediaType,
        }
      : null,
    watch: watch
      ? {
          title: watch.title,
          mediaType: watch.mediaType,
        }
      : null,
    release: releaseIdentity
      ? {
          title: releaseIdentity.name,
          year: releaseIdentity.year,
          mediaType: releaseIdentity.isSeries ? "tv" : "movie",
        }
      : null,
  });
  const catalog = intent.catalogAccepted ? catalogCandidate : null;
  const title =
    intent.title ??
    firstNonEmpty(progress[0]?.title) ??
    displayTitleFromWorkKey(workKey);
  const mediaType: MediaType | null = intent.mediaType;
  const year = intent.year;

  // ── Series or film ──────────────────────────────────────────────────────
  //
  // A declared type wins where we have one; otherwise the releases decide,
  // because a release name states its own season/episode structure and a
  // missing catalog row does not make a show a film.
  const episodeEvidence =
    localReleases.some((r) => r.season != null || r.episode != null || r.isPack) ||
    progress.some((p) => p.season != null || p.episode != null) ||
    (watch?.cursorSeason != null && watch?.cursorEpisode != null);
  const isSeries = providerIdentity
    ? providerIdentity.isSeries
    : mediaType === "movie"
      ? false
      : isSeriesMediaType(mediaType) || episodeEvidence;

  // ── The search cache: the only place `fetchable` can come from ──────────
  const cached = await readCachedSearch(title);
  const cachedReleases = cached ? releasesForWork(cached, workKey) : [];
  const searchWasRun = cached !== null;

  // ── Catalog artwork and blurb ───────────────────────────────────────────
  const cachedCatalog =
    providerMetadata || (catalog?.posterUrl && catalog?.overview)
      ? null
      : await findCachedCatalogRow(title, mediaType, year);

  const artwork = await resolveArtwork({
    title,
    year,
    mediaType,
    catalogPoster: providerMetadata?.posterUrl ?? catalog?.posterUrl ?? null,
    catalogBackdrop:
      providerMetadata?.backdropUrl ?? catalog?.backdropUrl ?? null,
    cachedCatalog,
    progressPoster: progress.find((p) => p.posterUrl)?.posterUrl ?? null,
  });

  // ── Local availability, title level ─────────────────────────────────────
  const titleLocal = pickLocal(localReleases, null, null);
  const titleState = resolveTitleState(titleLocal, cachedReleases, searchWasRun);

  // ── Seasons ─────────────────────────────────────────────────────────────
  const seasons = isSeries
    ? buildSeasons(localReleases, cachedReleases, progress, watch, seasonTransfers)
    : [];

  // ── Resume ──────────────────────────────────────────────────────────────
  //
  // Computed before the season is picked, so both derive from the *same*
  // resume decision: the hero button ("Resume S02E06") and the season the page
  // opens on can never disagree. Emitted only when the file the progress row
  // names is still present locally.
  const resume = resolveResume(progress, localReleases);

  const selectedSeason = isSeries
    ? pickSeason(
        seasons,
        query.season,
        resume?.season ?? null,
        progress,
        watch,
        query.rememberedSeason ?? null,
      )
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
          transfers: episodeTransfers,
          packCoverage:
            selectedSeason == null
              ? new Map()
              : buildPackCoverage(localReleases, engineByHash, selectedSeason),
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
      transfers: episodeTransfers,
      packCoverage: buildPackCoverage(
        localReleases,
        engineByHash,
        selectedSeason,
      ),
    }) > EPISODE_CAP;

  const known =
    catalog !== null ||
    providerIdentity !== null ||
    watch !== null ||
    localReleases.length > 0 ||
    progress.length > 0 ||
    cachedReleases.length > 0 ||
    cachedCatalog !== null;

  return {
    workKey,
    title,
    // Alternate names (AniList romaji/native, etc.) minus the canonical title,
    // so the episode grab can search anime under the name indexers carry.
    aliases: (providerMetadata?.aliases ?? []).filter(
      (a) => a && a.trim().toLowerCase() !== title.trim().toLowerCase(),
    ),
    year,
    mediaType,
    isSeries,
    // Same provenance rule as the artwork below: `WatchListItem.synopsis` and
    // `.rating` are written by the watchlist's name-similarity enrichment, so
    // they can describe a different work entirely. A blurb and a score are
    // claims as much as a poster is.
    overview:
      firstNonEmpty(
        providerMetadata?.synopsis,
        catalog?.overview,
        cachedCatalog?.synopsis,
      ) || null,
    rating:
      providerMetadata?.rating ?? catalog?.rating ?? cachedCatalog?.rating ?? null,
    posterUrl: artwork.posterUrl,
    backdropUrl: artwork.backdropUrl,
    // The primary release / first-air date, when a catalog row carries one.
    // Drives the future-gating visual on the title page (grayed, "Coming",
    // disabled). Unknown stays null and is never gated.
    releaseDate:
      providerMetadata?.releaseDate ??
      (catalog?.releaseDate ?? cachedCatalog?.releaseDate)?.toISOString() ??
      null,

    availability: titleState,
    infoHash: titleLocal?.hash ?? null,
    downloadFraction: keptDownloadFraction(titleLocal),

    resume,
    // Title scope only. A film the user sent, or a whole-work grab — never a
    // roll-up of season or episode targets.
    transfer: titleTransfer,
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
        externalId:
          (providerIdentity?.verified ? providerIdentity.externalId : null) ??
          cachedCatalog?.externalId?.trim() ??
          `work:${workKey}`,
        title,
        posterUrl: artwork.posterUrl,
        synopsis:
          firstNonEmpty(
            providerMetadata?.synopsis,
            catalog?.overview,
            cachedCatalog?.synopsis,
          ) || null,
        rating:
          providerMetadata?.rating ??
          catalog?.rating ??
          cachedCatalog?.rating ??
          null,
      },
    },

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
 * Is this local row a real download still in flight?
 *
 * True only for a kept file the user is actually acquiring and that has not
 * finished: a stream/prewarm cache is reclaimable scratch whose byte fraction
 * is not download progress, an errored row is not progressing, and a complete
 * file (progress >= 1) is done. `isInFlightLocal` accepts a just-queued 0% row
 * (nothing fetched yet but the grab is live); `isDownloadingLocal` is the
 * stricter variant that also requires visible progress.
 */
function isInFlightLocal(release: LocalRelease): boolean {
  if (release.retentionState === "stream" || release.retentionState === "prewarm") {
    return false;
  }
  if (release.status === "error") return false;
  return release.progress >= 0 && release.progress < 1;
}

function isDownloadingLocal(release: LocalRelease): boolean {
  return isInFlightLocal(release) && release.progress > 0;
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
  const matching = releases.filter(
    (r) => canMakeLocalClaim(r) && coversEpisode(r, season, episode),
  );
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
  seasonTransfers: Map<number, AcquisitionTransfer>,
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
        (r) =>
          canMakeLocalClaim(r) && r.isPack && r.season === season && r.progress > 0,
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
        // Season-scoped only. `pack` above describes a file we hold; this
        // describes a grab the user asked for, which may still be queued and
        // hold nothing at all. They are not interchangeable.
        transfer: seasonTransfers.get(season) ?? null,
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
 * The one asked for, else the one the user last picked by hand, else the one
 * being resumed, else the one being watched, else the one the library is
 * hunting, else the first.
 *
 * A manual pick governs which episode LIST the user was browsing, and must
 * win over resume/progress here: resume describes *actual playback
 * progress*, but this page-open decision is about what the user chose to
 * look at, and Resume stays available as its own separate action/button
 * regardless of which season this function opens the list on — it is never
 * reduced or hidden by picking a different season to display. Without this,
 * an old resume/progress row for a season far behind what the user is
 * actually rewatching (the exact owner repro: pick Season 2, an unrelated
 * stale progress row for Season 9 wins) silently overrides the user's own
 * manual choice on the very next visit.
 */
export function pickSeason(
  seasons: TitleSeason[],
  requested: number | null | undefined,
  resumeSeason: number | null,
  progress: { season: number | null; updatedAt: Date }[],
  watch: { cursorSeason: number | null } | null,
  rememberedSeason: number | null = null,
): number | null {
  if (seasons.length === 0) return null;
  const available = new Set(seasons.map((s) => s.season));

  // Honour an explicit request even when we hold no local files for it. The
  // client's season picker lists every season the provider knows about, so a
  // request for one we have nothing for is legitimate — the client merges the
  // provider's episodes over our (empty) local set. Returning a *different*
  // season than was asked for is the bug behind the title page's flashing
  // episode list: the requested season never matched the answered season, so
  // every background poll read as a season change and swapped in skeletons.
  if (requested != null && requested >= 1) return requested;

  // A remembered manual pick is validated the same way an explicit request is:
  // any positive season number is legitimate, because the client's season
  // picker lists provider seasons we hold no local files for. Gating it on the
  // local `available` set silently discarded provider-only picks (the owner
  // repro: remembered Season 2 dropped, stale resume Season 9 wins).
  if (rememberedSeason != null && rememberedSeason >= 1) return rememberedSeason;

  if (resumeSeason != null && available.has(resumeSeason)) return resumeSeason;

  const watching = progress.find((p) => p.season != null && available.has(p.season));
  if (watching?.season != null) return watching.season;

  if (watch?.cursorSeason != null && available.has(watch.cursorSeason)) {
    return watch.cursorSeason;
  }
  return seasons[0].season;
}

export interface EpisodeBuildInput {
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
  transfers: Map<string, AcquisitionTransfer>;
  /**
   * Episodes a completed (ready/warm) covering pack holds on disk, mapped to
   * the exact file inside it. A fallback only: an episode with its own file or
   * its own acquisition never reads this. See {@link buildPackCoverage}.
   */
  packCoverage: Map<number, PackCoverage>;
}

/** One episode's file inside a pack we already hold on disk. */
export interface PackCoverage {
  /** The pack's own availability — `ready` when fully present, else `warm`. */
  availability: AvailabilityState;
  infoHash: string;
  filePath: string;
}

interface PackCoverageEngine {
  progress: number;
  status: string;
  verifiedBitfield: string | null;
  verifiedFilesJson: string | null;
}

/**
 * Which episodes of `season` a completed covering pack puts on disk, and where.
 *
 * Covering packs are the season pack for this season and any multi-season /
 * whole-series pack, restricted to ones that may make a local claim and are
 * actually present (`progress > 0`, not errored) — the same evidence
 * `buildSeasons` uses for `seasons[].pack`. The engine must also carry its
 * authoritative completed bitfield plus verified file fingerprints; a
 * full-length sparse allocation alone is never enough. Each pack's exact
 * episode files are then mapped by {@link packEpisodeFiles}, which drops
 * featurettes, samples and non-video junk that would otherwise parse to
 * phantom episodes.
 *
 * The season pack wins over a multi-season pack, and a more complete pack over
 * a less complete one, so an episode is attributed to the strongest evidence.
 * Never over-claims: partial packs contribute nothing here. Playback may still
 * verify a specifically requested file against the live piece bitfield, but
 * the title payload cannot infer that from aggregate progress or file length.
 */
export function buildPackCoverage(
  localReleases: LocalRelease[],
  engineByHash: Map<string, PackCoverageEngine>,
  season: number,
): Map<number, PackCoverage> {
  const covering = localReleases
    .filter(
      (r) =>
        canMakeLocalClaim(r) &&
        r.progress > 0 &&
        r.status !== "error" &&
        ((r.isPack && r.season === season) || r.isMultiSeason),
    )
    .sort((a, b) => {
      // Season pack before a multi-season pack: a file we can attribute to this
      // exact season is stronger than one buried in a whole-series grab.
      const aMulti = a.isMultiSeason ? 1 : 0;
      const bMulti = b.isMultiSeason ? 1 : 0;
      if (aMulti !== bMulti) return aMulti - bMulti;
      // Then the more complete pack (ready before warm).
      return b.progress - a.progress;
    });

  const coverage = new Map<number, PackCoverage>();
  for (const pack of covering) {
    const state = localState(pack);
    if (!state) continue;
    const engine = engineByHash.get(pack.hash.trim().toLowerCase());
    if (!engine || !persistedTorrentIsDownloaded(engine)) continue;
    const files = heldFilesFromVerifiedJson(engine.verifiedFilesJson).map(
      (f) => ({ path: f.path, size: f.sizeBytes }),
    );
    if (files.length === 0) continue;
    for (const [episode, filePath] of packEpisodeFiles(files, season)) {
      if (coverage.has(episode)) continue; // a stronger pack already covered it
      coverage.set(episode, {
        availability: state,
        infoHash: pack.hash,
        filePath,
      });
    }
  }
  return coverage;
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
  for (const key of input.transfers.keys()) {
    const [targetSeason, targetEpisode] = key.split(":").map(Number);
    if (targetSeason === season && targetEpisode > 0) {
      max = Math.max(max, targetEpisode);
    }
  }
  for (const episode of input.packCoverage.keys()) {
    if (episode > 0) max = Math.max(max, episode);
  }
  if (input.cursorSeason === season && input.cursorEpisode != null) {
    max = Math.max(max, input.cursorEpisode);
  }
  return max;
}

export function buildEpisodes(input: EpisodeBuildInput): TitleEpisode[] {
  const { season } = input;
  const count = Math.min(highestEpisode(input), EPISODE_CAP);
  if (count <= 0) return [];

  const rows: TitleEpisode[] = [];
  for (let episode = 1; episode <= count; episode++) {
    const watched = input.progress.find(
      (p) => (p.season ?? 1) === season && p.episode === episode,
    );
    let transfer = input.transfers.get(`${season}:${episode}`) ?? null;
    const linkedHash =
      transfer?.infoHash ?? watched?.infoHash ?? null;
    const local = linkedHash
      ? pickLocalByHash(input.localReleases, linkedHash)
      : pickUnpackedEpisodeLocal(input.localReleases, season, episode);
    const state =
      transfer?.status === "downloaded"
        ? "ready"
        : transfer?.status === "downloading" && transfer.progress > 0
          ? "warm"
          : episodeState(local, input.cachedReleases, season, episode);

    const fraction =
      watched && watched.durationSec && watched.durationSec > 0
        ? Math.min(watched.positionSec / watched.durationSec, 1)
        : null;

    // A resume position is only offered for a file that still exists. Progress
    // rows outlive the torrents they describe — nothing deletes them — so the
    // info hash comes from the *engine* row, never from the progress row.
    let availability = state;
    let infoHash = transfer?.infoHash ?? local?.hash ?? null;
    let filePath =
      transfer?.filePath ??
      (infoHash && watched?.infoHash === infoHash ? watched.filePath : null);
    let fromPack = Boolean(
      transfer?.infoHash && local && (local.isPack || local.isMultiSeason),
    );

    // Pack coverage. A completed covering pack holds this episode's file, so it
    // makes the row playable (ready + the pack hash + the mapped file) and its
    // Download becomes a tick. It wins over the episode's *own incomplete* grab:
    // downloading one episode and then the whole season leaves that single
    // redundant, and the finished pack is the file that actually exists — so a
    // stuck "looking for peers" single must not keep the row spinning when the
    // pack already delivered it. Only the episode's own *completed* file (a
    // downloaded transfer or a local file) ties the pack and is kept as-is. A
    // pack still downloading holds no file yet, so it only marks the row
    // covered-in-flight, and never over an episode's own acquisition.
    // Only the episode's own *complete* file ties the pack. `state` already is
    // the episode's own availability (downloaded transfer or a real local
    // file); a stuck single grab that has fetched nothing yet is a `local`
    // release but not a file, so testing `local != null` here wrongly kept the
    // row spinning. A ready pack supersedes any own-incomplete state.
    const ownComplete = state === "ready";
    const cover = input.packCoverage.get(episode);
    if (!ownComplete && cover) {
      availability = cover.availability;
      infoHash = cover.infoHash;
      filePath = cover.filePath;
      fromPack = true;
      // Present the row as downloaded via the pack; the redundant single grab
      // falls away from the display (Downloaded, not "downloading 0%").
      transfer = {
        status: "downloaded",
        progress: 1,
        infoHash: cover.infoHash,
        filePath: cover.filePath,
        error: null,
      };
    }

    // A season download grabs each episode as its own release but writes no
    // per-episode acquisition row — the only trace is the live engine torrent.
    // Without this, a season grab leaves every covered episode looking
    // un-started: the still shows a progress bar (from keptDownloadFraction)
    // while the glyph reads the null `transfer` and prints a plain, still-
    // clickable Download icon. Surface the in-flight file as the episode's own
    // transfer so the card reads "Downloading NN%" and its control disables,
    // exactly like a single-episode Download — including the just-queued 0%
    // moment, so the row reacts the instant the season grab returns.
    //
    // Guarded to a real, still-running download: stream/prewarm caches are
    // excluded (their fraction is not download progress — see
    // keptDownloadFraction), a completed file is left to the ready/Play path,
    // and a pack's own row is handled by the coverage branches above.
    if (!transfer) {
      const downloading =
        local && isDownloadingLocal(local)
          ? local
          : !local
            ? pickDownloadingEpisodeLocal(input.localReleases, season, episode)
            : null;
      if (downloading) {
        transfer = {
          status: "downloading",
          progress: downloading.progress,
          infoHash: downloading.hash,
          filePath: null,
          error: null,
        };
        infoHash = downloading.hash;
        // Mirror the acquisition-row path: only a started download is `warm`;
        // a 0% grab has nothing to play yet, so availability stays as computed.
        if (downloading.progress > 0) availability = "warm";
      }
    }

    rows.push({
      season,
      episode,
      label: formatEpisodeLabel(season, episode),
      availability,
      infoHash,
      filePath,
      downloadFraction:
        transfer?.status === "downloading"
          ? transfer.progress
          : keptDownloadFraction(local),
      watchedFraction: fraction,
      resumePositionSec:
        infoHash && watched?.infoHash === infoHash && !watched.completedAt
          ? watched.positionSec
          : null,
      watched: Boolean(watched?.completedAt),
      nextUp:
        input.cursorSeason === season && input.cursorEpisode === episode,
      fromPack,
      transfer,
    });
  }

  function pickLocalByHash(
    releases: LocalRelease[],
    infoHash: string,
  ): LocalRelease | null {
    const normalized = infoHash.trim().toLowerCase();
    return (
      releases.find(
        (release) =>
          canMakeLocalClaim(release) &&
          release.hash.trim().toLowerCase() === normalized,
      ) ?? null
    );
  }

  function pickUnpackedEpisodeLocal(
    releases: LocalRelease[],
    season: number,
    episode: number,
  ): LocalRelease | null {
    return pickLocal(
      releases.filter((release) => !release.isPack && !release.isMultiSeason),
      season,
      episode,
    );
  }

  // Like pickUnpackedEpisodeLocal but includes a just-queued 0% download.
  // `pickLocal` deliberately requires progress > 0 (a 0% row is not `warm` and
  // cannot be played), which is right for availability but wrong for "is this
  // episode being fetched right now?" — a season single sits at 0% for a beat
  // before its first bytes, and the card must already say so.
  function pickDownloadingEpisodeLocal(
    releases: LocalRelease[],
    season: number,
    episode: number,
  ): LocalRelease | null {
    return (
      releases.find(
        (release) =>
          !release.isPack &&
          !release.isMultiSeason &&
          canMakeLocalClaim(release) &&
          isInFlightLocal(release) &&
          coversEpisode(release, season, episode),
      ) ?? null
    );
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
    localReleases
      .filter(canMakeLocalClaim)
      .map((r) => [r.hash.trim().toLowerCase(), r] as const),
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
