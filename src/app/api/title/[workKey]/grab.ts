/**
 * The one-click **Download** behind the title page.
 *
 * The whole point of the title page is that getting something is one press,
 * not a trip to a table of release names. That means the server picks the
 * release, and the only interesting question is how it avoids picking the
 * wrong film.
 *
 * Episodes already have a correct implementation — `grabSingleEpisode` in
 * `@/lib/library/ondemand`, which searches `Show SxxEyy`, matches the exact
 * season/episode, resolves the save path, checks the disk budget and advances
 * the library hunt cursor when the grab happens to be the episode automation
 * was waiting for. That is reused wholesale; a second copy would drift.
 *
 * Films have no such path (`grabSingleEpisode` requires a season and an
 * episode ≥ 1), so this module runs the same `runGrabPipeline` with a
 * film-shaped candidate selector. The selector is the part that matters:
 * results are re-identified through `workIdentityFor` and keyed, so a page for
 * *Dune* can never grab *Children of Dune* — the failure the work-identity
 * module exists to prevent, and one a raw title search reproduces every time.
 */
import { getUserClientConfig } from "@/lib/clients";
import { findLiveBuiltinTorrent } from "@/lib/clients/builtin-engine";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { grabSingleEpisode } from "@/lib/library/ondemand";
import { checkSendStorage } from "@/lib/library/storage-gate";
import { runGrabPipeline } from "@/lib/grab/pipeline";
import { logAcquisitionDecision } from "@/lib/observability/acquisition-diagnostics";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
import { searchAniList } from "@/lib/metadata/anilist";
import { searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { parseEpisode } from "@/lib/torrents/episodes";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { matchesTargetEpisode } from "@/lib/torrents/pack-preference";
import { rankResults } from "@/lib/torrents/ranking";
import {
  meetsResolutionFloor,
  normalizeResolutionFloor,
} from "@/lib/torrents/quality";
import type { TorrentResult } from "@/lib/torrents/types";
import { workIdentityFor, workKeyMatches } from "@/components/title/work-key";
import { applySendRetention, sendRetentionToPurpose } from "@/lib/streaming/send-retention";
import type {
  TitleGrabRequest,
  TitleGrabResponse,
  TitleSeasonEpisodeTransfer,
  TitleSeasonGrabResponse,
} from "@/components/title/types";
import type {
  SeasonGrabEpisodeReport,
  SeasonGrabReport,
} from "@/components/title/season-grab-state";
import prisma from "@/lib/prisma";
import { normalizeTitle } from "@/lib/utils";
import type { MediaMetadata } from "@/lib/torrents/types";

export const SERIES_TITLE_SCOPE_MESSAGE =
  "Series title acquisition needs an episode — choose or find one first.";

export interface TitleGrabInput extends TitleGrabRequest {
  userId: string;
  workId: string;
  workKey: string;
  /** Resolved server-side; the client is never trusted for identity. */
  resolvedTitle: string;
  resolvedYear: number | null;
  resolvedMediaType: string | null;
  /**
   * Verified provider aliases (AniList romaji/native, etc.), resolved
   * server-side alongside the title. Threaded into the episode grab so anime is
   * acquirable under the name indexers carry, not only its English label
   * (BUG-010). Empty for works without aliases.
   */
  resolvedAliases: readonly string[];
  isSeries: boolean;
  watchListItemId: string | null;
}

export interface TitleGrabDeps {
  reuseStreamingEpisode?: (
    input: TitleGrabInput,
    target: { season: number; episode: number },
  ) => Promise<TitleGrabResponse | null>;
  grabWholeWork?: (input: TitleGrabInput) => Promise<TitleGrabResponse>;
  episodeSearchIdentity?: {
    mediaType: string;
    aliases: string[];
  };
  /** Awaited between the episode's search and its send. */
  beforeSend?: () => Promise<void>;
}

export async function grabForTitle(
  input: TitleGrabInput,
  deps: TitleGrabDeps = {},
): Promise<TitleGrabResponse> {
  const season = toPositiveInt(input.season);
  const episode = toPositiveInt(input.episode);
  const reuseEpisode = deps.reuseStreamingEpisode ?? reuseStreamingEpisode;
  const grabWholeWorkImpl = deps.grabWholeWork ?? grabWholeWork;

  if (season != null && episode != null) {
    const reused = await reuseEpisode(input, { season, episode });
    if (reused) return reused;

    const searchIdentity =
      deps.episodeSearchIdentity ??
      (await resolveEpisodeSearchIdentity(input));
    const request: Parameters<typeof grabSingleEpisode>[0] = {
      userId: input.userId,
      workId: input.workId,
      showTitle: input.resolvedTitle,
      // A row we are hunting episode-by-episode is a series by construction;
      // this states that default in the open rather than hiding it in the
      // shared media-type module (see the comment there).
      mediaType: searchIdentity.mediaType,
      season,
      episode,
      aliases: searchIdentity.aliases,
      watchListItemId: input.watchListItemId,
      retention: input.retention ?? "keep",
      overrideStorageCap: input.overrideStorageCap === true,
      preferredResolution: input.preferredResolution ?? null,
      beforeSend: deps.beforeSend,
    };
    const result = await grabSingleEpisode(request);
    return {
      ok: result.ok,
      message: result.message,
      title: result.title ?? null,
      savePath: result.savePath ?? null,
      infoHash: result.infoHash ?? null,
      storage: result.storage ?? null,
      queued: result.queued === true,
      queuePosition: result.queuePosition ?? null,
    };
  }

  if (input.isSeries) {
    return { ok: false, message: SERIES_TITLE_SCOPE_MESSAGE };
  }

  return grabWholeWorkImpl(input);
}

type AnimeLookup = (
  query: string,
  limit?: number,
) => Promise<MediaMetadata[]>;

/**
 * Recover AniList aliases for an episode search.
 *
 * Two shapes need this. A TMDB-backed page describes anime as plain TV, and an
 * anime page can arrive with no aliases at all (an unverified provider link, a
 * catalog row with only its English label). Returning empty aliases in either
 * case leaves the exact-episode ladder searching a name no indexer carries.
 *
 * Recovery is guarded, never generous: an AniList result may influence
 * acquisition only when one of its names matches the resolved title exactly
 * and its year does not contradict the resolved year. This keeps same-name
 * catalog collisions out while letting indexer names such as "Tensei Shitara
 * Slime Datta Ken" enter the ladder. A recovered anime never changes the media
 * type of a work already resolved as anime, and a failed lookup degrades to
 * exactly what was known before.
 */
export async function resolveEpisodeSearchIdentity(
  input: Pick<
    TitleGrabInput,
    | "resolvedTitle"
    | "resolvedYear"
    | "resolvedMediaType"
    | "resolvedAliases"
  >,
  lookup: AnimeLookup = searchAniList,
): Promise<{ mediaType: string; aliases: string[] }> {
  const existing = uniqueNames(input.resolvedAliases, input.resolvedTitle);
  const known = {
    mediaType: input.resolvedMediaType ?? "tv",
    aliases: existing,
  };
  // AniList-backed pages already carry the names its indexers use. TMDB-backed
  // anime is different: TMDB may provide only a native-script alias, which is
  // a real alias but does not replace the Romaji name used by fansub releases.
  // Keep the cheap fast path for known anime, but let TV-shaped provider
  // identities perform the guarded AniList recovery even when TMDB supplied
  // one or more aliases.
  if (known.mediaType === "anime" && existing.length > 0) return known;
  if (!input.resolvedTitle.trim()) return known;

  let matches: MediaMetadata[];
  try {
    matches = await lookup(input.resolvedTitle, 5);
  } catch {
    return known;
  }

  const wantedTitle = normalizeTitle(input.resolvedTitle);
  const anime = matches.find((candidate) => {
    if (candidate.mediaType !== "anime") return false;
    if (
      input.resolvedYear != null &&
      candidate.year != null &&
      candidate.year !== input.resolvedYear
    ) {
      return false;
    }
    return [candidate.title, ...(candidate.aliases ?? [])].some(
      (name) => normalizeTitle(name) === wantedTitle,
    );
  });
  if (!anime) return known;

  return {
    mediaType: "anime",
    aliases: uniqueNames(
      [anime.title, ...(anime.aliases ?? [])],
      input.resolvedTitle,
    ),
  };
}

function uniqueNames(
  names: readonly string[],
  canonicalTitle: string,
): string[] {
  const canonical = normalizeTitle(canonicalTitle);
  const seen = new Set<string>();
  return names.flatMap((name) => {
    const trimmed = name.trim();
    const normalized = normalizeTitle(trimmed);
    if (!trimmed || normalized === canonical || seen.has(normalized)) return [];
    seen.add(normalized);
    return [trimmed];
  });
}

export interface TitleSeasonGrabInput extends TitleGrabInput {
  season: number;
  episodes: number[];
  /** Retained for request compatibility; episode fan-out never selects packs. */
  seasonComplete?: boolean;
}

/**
 * Run episode downloads independently, like pressing Download on each card.
 *
 * A season action is still one HTTP request for the UI, but it must not have a
 * second candidate-selection implementation. Each episode gets the exact same
 * `grabForTitle` path as an individual card, while one failure remains local
 * to that episode.
 *
 * Episodes used to run strictly one at a time, so a single dead episode — a
 * ladder that searched every rung and found nothing, or an add that waited out
 * its metadata timeout — blocked every later episode and the whole request with
 * it. Searches now run through a small pool, but the adds are committed in
 * episode order: an episode's send waits until every earlier episode has
 * either sent, failed, or overrun `orderWaitMs`, so E3/E4 cannot take the free
 * transfer slots ahead of E1/E2 just because their searches answered first.
 */
export const SEASON_FANOUT_CONCURRENCY = 4;

export interface SeasonEpisodeFanoutResult {
  transfers: TitleSeasonEpisodeTransfer[];
  coveredEpisodes: number[];
  storage: TitleGrabResponse["storage"];
  retryAfterSeconds: number | null;
}

/** How long a later episode waits for an earlier one to search + send. */
export const SEASON_ORDER_WAIT_MS = 60_000;
/** How long an earlier episode's send holds later ones (admission is fast). */
export const SEASON_SEND_HOLD_MS = 10_000;

export interface SeasonFanoutOptions {
  concurrency?: number;
  orderWaitMs?: number;
  sendHoldMs?: number;
}

export async function fanOutSeasonEpisodes(
  episodes: readonly number[],
  grabEpisode: (
    episode: number,
    hooks: { beforeSend: () => Promise<void> },
  ) => Promise<TitleGrabResponse>,
  options: SeasonFanoutOptions | number = {},
): Promise<SeasonEpisodeFanoutResult> {
  const opts = typeof options === "number" ? { concurrency: options } : options;
  const concurrency = opts.concurrency ?? SEASON_FANOUT_CONCURRENCY;
  const orderWaitMs = opts.orderWaitMs ?? SEASON_ORDER_WAIT_MS;
  const sendHoldMs = opts.sendHoldMs ?? SEASON_SEND_HOLD_MS;
  const wanted = uniquePositiveInts(episodes);
  // `passed[i]` resolves once episode i no longer holds later episodes back:
  // its send finished (or held for `sendHoldMs`), it failed without sending,
  // or it never reached a send at all.
  const passResolvers: Array<() => void> = [];
  const passed = wanted.map(
    () =>
      new Promise<void>((resolve) => {
        passResolvers.push(resolve);
      }),
  );
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  const beforeSendFor = (index: number) => async () => {
    const earlier = passed.slice(0, index);
    // A dead or stalled earlier search must not block this one forever.
    await Promise.race([Promise.all(earlier), sleep(orderWaitMs)]);
    void sleep(sendHoldMs).then(() => passResolvers[index]());
  };
  const transfers: Array<TitleSeasonEpisodeTransfer | null> = Array.from(
    { length: wanted.length },
    () => null,
  );
  let storage: TitleGrabResponse["storage"] = null;
  let retryAfterSeconds: number | null = null;

  const runOne = async (index: number, episode: number): Promise<void> => {
    try {
      const result = await grabEpisode(episode, {
        beforeSend: beforeSendFor(index),
      });
      if (result.storage && !storage) storage = result.storage;
      if (result.retryAfterSeconds != null) {
        retryAfterSeconds = Math.max(
          retryAfterSeconds ?? 0,
          result.retryAfterSeconds,
        );
      }
      transfers[index] = result.ok
        ? {
            episode,
            // "Queued" is a real, honest outcome now, not a slower kind of
            // downloading: nothing is transferring for this episode yet.
            status: result.queued ? "queued" : "downloading",
            infoHash: result.infoHash ?? null,
            error: null,
          }
        : {
            episode,
            status: "failed",
            infoHash: null,
            error: result.message,
          };
    } catch (err) {
      transfers[index] = {
        episode,
        status: "failed",
        infoHash: null,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      passResolvers[index]();
    }
  };

  // A fixed pool of workers pulling from one shared cursor: each finished
  // episode frees its slot immediately, so a slow one costs one worker rather
  // than the whole season.
  const slots = Math.max(1, Math.min(concurrency, wanted.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: slots }, async () => {
      while (next < wanted.length) {
        const index = next++;
        await runOne(index, wanted[index]);
      }
    }),
  );
  for (const timer of timers) clearTimeout(timer);

  const settled = transfers.filter(
    (transfer): transfer is TitleSeasonEpisodeTransfer => transfer != null,
  );
  return {
    transfers: settled,
    coveredEpisodes: settled
      .filter(
        (transfer) =>
          transfer.status === "downloading" || transfer.status === "queued",
      )
      .map((transfer) => transfer.episode)
      .sort((a, b) => a - b),
    storage,
    retryAfterSeconds,
  };
}
export async function grabSeasonForTitle(
  input: TitleSeasonGrabInput,
): Promise<TitleSeasonGrabResponse> {
  const season = toPositiveInt(input.season);
  const episodes = uniquePositiveInts(input.episodes);
  if (season == null || episodes.length === 0) {
    return {
      ok: false,
      message: "No known episodes to plan for this season",
      episodeTransfers: [],
    };
  }

  const episodeSearchIdentity = await resolveEpisodeSearchIdentity(input);
  const fanout = await fanOutSeasonEpisodes(episodes, (episode, hooks) =>
    grabForTitle(
      {
        ...input,
        season,
        episode,
      },
      { episodeSearchIdentity, beforeSend: hooks.beforeSend },
    ),
  );
  const covered = new Set(fanout.coveredEpisodes);
  const episodeReports: SeasonGrabEpisodeReport[] = episodes.map((episode) => {
    const transfer = fanout.transfers.find((item) => item.episode === episode);
    return covered.has(episode)
      ? { episode, status: "covered" as const }
      : {
          episode,
          status: "missing" as const,
          reason:
            transfer?.error ??
            fanout.storage?.message ??
            "No release found for this episode",
        };
  });

  const report: SeasonGrabReport = {
    season,
    totalEpisodes: episodes.length,
    coveredEpisodes: fanout.coveredEpisodes.length,
    strategy: "singles",
    coverageConfirmed: true,
    episodes: episodeReports,
    planReason:
      "Each episode used the same acquisition path as its individual Download button.",
  };
  const episodeTransfers = fanout.transfers;

  // Nothing was sent to the client — no release could be taken for any wanted
  // episode. Reporting ok:true here (with "0 of N episodes") is the false
  // success that made the user press Download season twice: a green toast, an
  // AcquisitionTarget written as "downloading" with no hash, and no download.
  // Say so, and keep the report so the UI can still show which episodes missed.
  if (fanout.coveredEpisodes.length === 0) {
    if (fanout.storage) {
      return {
        ok: false,
        message: fanout.storage.message,
        report,
        storage: fanout.storage,
        retryAfterSeconds: fanout.retryAfterSeconds ?? undefined,
        episodeTransfers,
      };
    }
    return {
      ok: false,
      message:
        fanout.retryAfterSeconds != null
          ? `No episode downloads started. Retry in ${fanout.retryAfterSeconds} seconds.`
          : "No episode downloads started — try again shortly.",
      report,
      retryAfterSeconds: fanout.retryAfterSeconds ?? undefined,
      episodeTransfers,
    };
  }

  return {
    ok: true,
    message: `${fanout.coveredEpisodes.length} of ${episodes.length} episodes started`,
    report,
    episodeTransfers,
    retryAfterSeconds: fanout.retryAfterSeconds ?? undefined,
  };
}

export function exactSeasonEpisodeTransfers(
  episodes: readonly number[],
  items: readonly {
    kind: "pack" | "single";
    episode?: number;
    status: "sent" | "failed" | "skipped" | "already_active";
    message: string;
    infoHash: string | null;
  }[],
  failureByEpisode: ReadonlyMap<number, string>,
  packFailure: string | null,
  storageMessage: string | null,
): TitleSeasonEpisodeTransfer[] {
  const singles = new Map<number, (typeof items)[number]>();
  for (const item of items) {
    if (item.kind === "single" && item.episode != null) {
      singles.set(item.episode, item);
    }
  }

  return episodes.map((episode) => {
    const item = singles.get(episode);
    if (
      item &&
      (item.status === "sent" || item.status === "already_active") &&
      item.infoHash
    ) {
      return {
        episode,
        status: "downloading",
        infoHash: item.infoHash,
        error: null,
      };
    }
    const error =
      failureByEpisode.get(episode) ??
      item?.message ??
      packFailure ??
      storageMessage ??
      "No exact episode release was found.";
    return {
      episode,
      status: "failed",
      infoHash: null,
      error,
    };
  });
}

/**
 * A film, or a whole series where no episode was named.
 *
 * Mirrors `grabSingleEpisode`'s pipeline options exactly, minus the episode
 * filter and the cursor advance: same explicit-user semantics (no dedupe gate,
 * no viability gate — the user asked for this by name), same storage-budget
 * check, same smart save-path resolution.
 */
async function grabWholeWork(
  input: TitleGrabInput,
): Promise<TitleGrabResponse> {
  const title = input.resolvedTitle.trim();
  if (!title) {
    return { ok: false, message: "Nothing to search for" };
  }

  const mediaType = input.resolvedMediaType;
  // Films fall back to "all" rather than "movies": a category guess that is
  // wrong returns nothing at all, whereas an unfiltered search still finds the
  // release and the identity check below still rejects the wrong work.
  const searchCategory = searchCategoryForMediaType(mediaType) ?? "all";

  const config = await getUserClientConfig(input.userId);
  if (!config) {
    return { ok: false, message: "No client configured" };
  }

  const minimumResolution =
    (input.retention ?? "keep") === "keep"
      ? normalizeResolutionFloor(input.preferredResolution)
      : null;

  // Held so the failure message can say *why* nothing was picked. Only counts
  // and source ids are ever derived from it — never a magnet or a path.
  let lastSearchResults: readonly TorrentResult[] = [];

  const result = await runGrabPipeline({
    userId: input.userId,
    workId: input.workId,
    search: {
      query: title,
      category: searchCategory,
      limit: 20,
      enrich: false,
      skipCache: true,
      background: false,
      filters: { hasMagnet: true, minSeeders: 1 },
    },
    config,
    fallbackTitle: title,
    grabJobKind: "ondemand",
    externalId: input.watchListItemId,
    purpose: sendRetentionToPurpose(input.retention, input.watchListItemId),
    minimumResolution,
    downloadHistoryPrefix: "Title page",
    // `checkStorageBudget` below honours the override, but the engine runs its
    // own storage check when the payload reaches it. Both have to know, or a
    // confirmed over-cap film passes the gate here and is refused there — the
    // movie-only half of the storage-override bug (episode/season paths already
    // carry this; this whole-work path was the one that dropped it).
    addPayload: { overrideStorageCap: input.overrideStorageCap === true },
    noMatchMessage: (count, sources) =>
      filmNoMatchMessage({
        title,
        minimumResolution,
        count,
        sources,
        rejection: summarizeFilmRejection(
          lastSearchResults,
          input.workKey,
          minimumResolution,
        ),
      }),

    selectCandidate(results) {
      lastSearchResults = results;
      const picked = selectWorkCandidate(
        results,
        input.workKey,
        input.isSeries,
        input.preferredResolution,
        title,
        searchCategory,
        minimumResolution,
      );
      // The one decision that has been wrong in the field: a corrupted work key
      // made every correct release read as a different film, and the only
      // symptom was "no release". Counts and reason codes make that visible
      // without naming a release, a hash or a path.
      const rejection = summarizeFilmRejection(
        results,
        input.workKey,
        minimumResolution,
      );
      logAcquisitionDecision(config, picked ? "candidate_selected" : "candidate_none", {
        stage: "select",
        scope: "title",
        category: searchCategory,
        source: picked?.source ?? null,
        resultCount: results.length,
        candidateCount: picked ? 1 : 0,
        rejectedIdentity: rejection.otherWork,
        rejectedQuality: rejection.belowFloor,
        rejectedSeeders: rejection.unseeded,
        minResolution: minimumResolution,
        overrideStorageCap: input.overrideStorageCap === true,
      });
      return picked;
    },

    async checkStorageBudget(candidate, target) {
      const root =
        config.baseDownloadPath?.trim() ||
        target.savePath ||
        config.savePath?.trim() ||
        process.cwd();
      // Same gate as every other send: Play reclaims the stream cache before it
      // refuses, Download obeys the cap but offers an informed override. A film
      // is not a special case — using the bare assert here made Play refusable
      // on exactly the path a film takes.
      const space = await checkSendStorage({
        userId: input.userId,
        config,
        root,
        incomingBytes: candidate.sizeBytes ?? null,
        retention: input.retention ?? "keep",
        protectHashes: candidate.infoHash ? [candidate.infoHash] : undefined,
        overrideCap: input.overrideStorageCap === true,
      });
      // Which root was chosen, never the root itself: a save path is user data.
      logAcquisitionDecision(config, "storage_gate", {
        stage: "storage",
        scope: "title",
        status: space.ok ? "allowed" : "refused",
        pathMode: storageRootMode(config, target.savePath),
        overrideStorageCap: input.overrideStorageCap === true,
      });
      return space.ok
        ? { ok: true as const }
        : { ok: false as const, message: space.message, storage: space.override };
    },

    resolveTarget(cfg, candidate) {
      const target = resolveSmartSendTarget(cfg, {
        name: candidate.title,
        source: candidate.source,
        searchCategory,
        metadata: catalogMetadata({
          mediaType: mediaType ?? (input.isSeries ? "tv" : "movie"),
          title,
        }),
      });
      logAcquisitionDecision(config, "target_resolved", {
        stage: "target",
        scope: "title",
        category: target.category,
        strategy: target.smart.confidence,
        pathMode: target.kind,
        source: candidate.source,
      });
      return { category: target.category, savePath: target.savePath };
    },
  });

  logAcquisitionDecision(config, "grab_result", {
    stage: "send",
    scope: "title",
    status: result.status,
    source: result.candidate?.source ?? null,
    category: searchCategory,
    clientType: config.clientType ?? null,
    minResolution: minimumResolution,
    offline: result.offline === true,
  });

  if (result.status === "sent" || result.status === "already_active") {
    await applySendRetention({
      userId: input.userId,
      config,
      infoHash: normalizeInfoHash(result.candidate?.infoHash),
      retention: input.retention ?? "keep",
      watchListItemId: input.watchListItemId,
    });
  }

  return {
    // An already-active grab is a success from the caller's point of view:
    // the release IS downloading. Reporting ok:false would tell the user the
    // grab failed while the torrent runs in the background.
    ok: result.status === "sent" || result.status === "already_active",
    message: result.message,
    title: result.candidate?.title ?? null,
    savePath: result.target?.savePath ?? null,
    infoHash: normalizeInfoHash(result.candidate?.infoHash),
    storage: result.storage ?? null,
  };
}

/**
 * Which configured root the storage gate measured, as a code.
 *
 * A save path is user data — it names their disk layout — so the diagnostic
 * reports *which rule won*, never the path. That is the fact needed to explain
 * a refusal ("it measured the client's root, not your base path"), and it is
 * low-cardinality enough to be safe in a log line.
 */
export function storageRootMode(
  config: { baseDownloadPath?: string | null; savePath?: string | null },
  targetSavePath: string | null | undefined,
): "base" | "target" | "client" | "cwd" {
  if (config.baseDownloadPath?.trim()) return "base";
  if (targetSavePath) return "target";
  if (config.savePath?.trim()) return "client";
  return "cwd";
}

/** Per-source outcome of the search that just ran, as the pipeline reports it. */
export interface GrabSourceOutcome {
  id: string;
  count: number;
  error?: string;
}

/** Why the film selector rejected everything it was given. Counts only. */
export interface FilmRejectionSummary {
  total: number;
  noMagnet: number;
  unseeded: number;
  belowFloor: number;
  otherWork: number;
  packOrEpisode: number;
}

/**
 * Count the reasons a film search produced no candidate.
 *
 * "No release" is the one sentence this path can say, and it has been wrong
 * twice over: once when the indexer was unreachable, and once when the work
 * key itself was corrupted by a release suffix so every correct result was
 * read as a different film. Counting the rejections makes both visible in the
 * message the user actually sees, and does it without exposing a magnet, a
 * path or any credential — ids and integers only.
 *
 * Mirrors {@link selectWorkCandidate}'s order so the numbers describe the run
 * that really happened rather than a second, differently-shaped opinion.
 */
export function summarizeFilmRejection(
  results: readonly TorrentResult[],
  workKey: string,
  minimumResolution?: number | null,
): FilmRejectionSummary {
  const summary: FilmRejectionSummary = {
    total: results.length,
    noMagnet: 0,
    unseeded: 0,
    belowFloor: 0,
    otherWork: 0,
    packOrEpisode: 0,
  };
  for (const r of results) {
    if (!r.magnet) {
      summary.noMagnet += 1;
      continue;
    }
    if ((r.seeders ?? 0) <= 0) {
      summary.unseeded += 1;
      continue;
    }
    if (!meetsResolutionFloor(r.title, minimumResolution ?? null)) {
      summary.belowFloor += 1;
      continue;
    }
    const identity = workIdentityFor(r.title, r.metadata ?? null);
    if (!workKeyMatches(workKey, identity.name, identity.year)) {
      summary.otherWork += 1;
      continue;
    }
    const ep = r.episode ?? parseEpisode(r.title);
    if (ep.isSeasonPack || ep.isMultiSeason || ep.episode != null) {
      summary.packOrEpisode += 1;
    }
  }
  return summary;
}

/**
 * "Every source failed" is not "there is no release".
 *
 * Returns a sentence only when *nothing* was actually searched — one working
 * source that returned nothing is a real, honest empty answer and must keep
 * saying so. Never quietly upgraded to a claim about peers or availability,
 * which this layer has no evidence about.
 */
export function sourceOutageMessage(
  sources?: readonly GrabSourceOutcome[],
): string | null {
  if (!sources?.length) return null;
  const failed = sources.filter((s) => Boolean(s.error?.trim()));
  if (failed.length !== sources.length) return null;
  const names = failed.map((s) => s.id).join(", ");
  return `Could not reach any torrent source (${names}) — nothing was searched, so this is an outage, not a missing release. Try again in a moment.`;
}

/**
 * The failure sentence for a film grab, with the reason attached.
 *
 * The old message named a count and nothing else, so an unreachable indexer,
 * a quality floor nothing cleared and a corrupted work key were all reported
 * as "No seeded torrent for X" — three different problems, one dead end.
 */
export function filmNoMatchMessage(input: {
  title: string;
  minimumResolution?: number | null;
  count: number;
  sources?: readonly GrabSourceOutcome[];
  rejection?: FilmRejectionSummary | null;
}): string {
  const outage = sourceOutageMessage(input.sources);
  if (outage) return `${outage} (${input.title})`;

  const floor = input.minimumResolution
    ? `${input.minimumResolution}p-or-higher `
    : "";
  if (!input.count) {
    return `No seeded ${floor}torrent for ${input.title}`;
  }

  const r = input.rejection;
  const because: string[] = [];
  if (r) {
    if (r.otherWork) because.push(`${r.otherWork} were a different work`);
    if (r.belowFloor && input.minimumResolution) {
      because.push(
        `${r.belowFloor} below ${input.minimumResolution}p or of unknown quality`,
      );
    }
    if (r.packOrEpisode) because.push(`${r.packOrEpisode} were packs or episodes`);
    if (r.unseeded) because.push(`${r.unseeded} had no seeders`);
  }
  const why = because.length ? ` — ${because.join(", ")}` : "";
  return `No ${floor}release for ${input.title} in ${input.count} results${why}`;
}

/**
 * The best result that genuinely belongs to this work.
 *
 * Two rules, in order:
 *
 *  1. **Identity.** `workIdentityFor` + `workKeyMatches` on every result. A raw
 *     title search for "Dune" returns *Children of Dune*, *Dune: Prophecy* and
 *     *Dune: Part Two*; only the exact work may be grabbed. This is the same
 *     one-directional test the page itself uses, so what the user was shown
 *     and what gets grabbed cannot disagree.
 *  2. **Shape.** For a film, a season pack or an episode is the wrong thing
 *     entirely, so those are dropped. For a series with no episode named, a
 *     pack is exactly right and is preferred.
 *
 * Results arrive already ranked by the aggregator, so "first survivor" is
 * "best survivor" — this filters, it does not re-rank.
 */
export function selectWorkCandidate(
  results: TorrentResult[],
  workKey: string,
  isSeries: boolean,
  preferredResolution?: number | null,
  query = workKey,
  category: string | null | undefined = "all",
  minimumResolution: number | null | undefined = preferredResolution,
): TorrentResult | null {
  const ordered =
    preferredResolution == null
      ? results
      : rankResults(
          [...results],
          query,
          preferredResolution,
          category,
        );
  const usable = ordered.filter(
    (r) =>
      r.magnet &&
      (r.seeders ?? 0) > 0 &&
      meetsResolutionFloor(r.title, minimumResolution),
  );

  const mine = usable.filter((r) => {
    const identity = workIdentityFor(r.title, r.metadata ?? null);
    return workKeyMatches(workKey, identity.name, identity.year);
  });
  if (mine.length === 0) return null;

  if (!isSeries) {
    const film = mine.find((r) => {
      const ep = r.episode ?? parseEpisode(r.title);
      return !ep.isSeasonPack && !ep.isMultiSeason && ep.episode == null;
    });
    return film ?? null;
  }

  const pack = mine.find((r) => {
    const ep = r.episode ?? parseEpisode(r.title);
    return ep.isSeasonPack || ep.isMultiSeason || ep.isBatch;
  });
  return pack ?? mine[0];
}

export interface ReusableLocalEpisode {
  hash: string;
  name: string;
  status: string;
  origin: string;
}

/**
 * Select a server-known live stream allocation that exactly satisfies an
 * episode keep. Client-provided hashes never enter this function.
 */
export function selectReusableLocalEpisode<T extends ReusableLocalEpisode>(
  rows: readonly T[],
  target: {
    season: number;
    episode: number;
    workKey?: string | null;
    minimumResolution?: number | null;
  },
  isLive: (hash: string) => boolean = () => true,
): T | null {
  for (const row of rows) {
    if (row.origin !== "stream") continue;
    if (row.status !== "downloading" && row.status !== "seeding") continue;
    const hash = normalizeInfoHash(row.hash);
    if (!hash || !isLive(hash)) continue;
    const release = {
      title: row.name,
      magnet: `magnet:?xt=urn:btih:${hash}`,
    } as TorrentResult;
    if (!matchesTargetEpisode(release, target)) continue;
    if (target.workKey) {
      const identity = workIdentityFor(row.name, null);
      if (!workKeyMatches(target.workKey, identity.name, identity.year)) continue;
    }
    if (!meetsResolutionFloor(row.name, target.minimumResolution)) continue;
    return row;
  }
  return null;
}

async function reuseStreamingEpisode(
  input: TitleGrabInput,
  target: { season: number; episode: number },
): Promise<TitleGrabResponse | null> {
  if ((input.retention ?? "keep") !== "keep") return null;
  try {
    const config = await getUserClientConfig(input.userId);
    if (!config || config.clientType !== "builtin") return null;
    const rows = await prisma.engineTorrent.findMany({
      where: {
        userId: input.userId,
        origin: "stream",
        status: { in: ["downloading", "seeding"] },
      },
      orderBy: { lastUsedAt: "desc" },
      select: { hash: true, name: true, status: true, origin: true },
    });
    const local = selectReusableLocalEpisode(
      rows,
      {
        ...target,
        workKey: input.workKey,
        minimumResolution: input.preferredResolution,
      },
      (hash) => findLiveBuiltinTorrent(hash) !== null,
    );
    const hash = normalizeInfoHash(local?.hash);
    if (!local || !hash) return null;
    await applySendRetention({
      userId: input.userId,
      config,
      infoHash: hash,
      retention: "keep",
      watchListItemId: input.watchListItemId,
    });
    return {
      ok: true,
      message: "Kept the episode already streaming",
      title: local.name,
      savePath: null,
      infoHash: hash,
      storage: null,
    };
  } catch {
    // Stale/missing local state is not terminal: normal discovery remains valid.
    return null;
  }
}

function toPositiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const int = Math.trunc(n);
  return int >= 1 ? int : null;
}

function uniquePositiveInts(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map(toPositiveInt)
        .filter((value): value is number => value != null),
    ),
  ).sort((a, b) => a - b);
}
