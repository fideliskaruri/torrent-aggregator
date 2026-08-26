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
import { acquireSeason } from "@/lib/library/season-acquire";
import { applySendRetention, sendRetentionToPurpose } from "@/lib/streaming/send-retention";
import type { SeasonPlan } from "@/lib/torrents/season-plan";
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

    const searchIdentity = await resolveEpisodeSearchIdentity(input);
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
    };
    const result = await grabSingleEpisode(request);
    return {
      ok: result.ok,
      message: result.message,
      title: result.title ?? null,
      savePath: result.savePath ?? null,
      infoHash: result.infoHash ?? null,
      storage: result.storage ?? null,
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
  /** Whether the season has finished airing — passed through to the planner. */
  seasonComplete?: boolean;
}

/**
 * Temporary season-planner seam.
 *
 * The swarm planner will replace this function's body with a measured
 * pack-vs-singles plan. The title page already consumes the typed report, so
 * wiring the real planner is a one-line swap at this boundary rather than a UI
 * rewrite.
 */
/**
 * Season acquisition, planned around measured swarm health.
 *
 * Delegates the decision to `acquireSeason`, which prefers a good pack, fills
 * gaps with singles, and never grabs an episode twice. The strategy is *read
 * off the plan* rather than inferred from how many info-hashes came back —
 * the plan knows whether it chose a pack, and guessing from counts would
 * mislabel a one-episode season as a pack.
 */
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

  let result: Awaited<ReturnType<typeof acquireSeason>>;
  try {
    const target: Parameters<typeof acquireSeason>[0] = {
      userId: input.userId,
      workId: input.workId,
      title: input.resolvedTitle,
      aliases: input.resolvedAliases,
      mediaType: input.resolvedMediaType ?? "tv",
      season,
      episodes,
      preferredResolution: input.preferredResolution ?? null,
      seasonComplete: input.seasonComplete,
    };
    result = await acquireSeason(target, {
      watchListItemId: input.watchListItemId,
      retention: input.retention ?? "keep",
      overrideStorageCap: input.overrideStorageCap === true,
    });
  } catch (err) {
    // A failed plan is an error, not an empty season. Saying "no episodes
    // found" here would be the same lie the episode list used to tell.
    const message =
      err instanceof Error ? err.message : "Could not plan this season";
    return {
      ok: false,
      message,
      episodeTransfers: failedEpisodeTransfers(episodes, message),
    };
  }

  const acquired = new Set(result.acquired);
  // Prefer the real send failure over "no release" when the planner found a
  // candidate but storage (or the client) refused it — otherwise a full plan
  // that hit the cap still reads as "nothing exists for this episode".
  const failureByEpisode = new Map<number, string>();
  let packFailure: string | null = null;
  for (const item of result.items) {
    if (item.status === "sent" || item.status === "already_active") continue;
    if (item.kind === "pack") {
      packFailure = item.message;
      continue;
    }
    if (item.episode != null && !failureByEpisode.has(item.episode)) {
      failureByEpisode.set(item.episode, item.message);
    }
  }
  const episodeReports: SeasonGrabEpisodeReport[] = episodes.map((episode) => {
    if (acquired.has(episode)) return { episode, status: "covered" as const };
    const reason =
      failureByEpisode.get(episode) ??
      packFailure ??
      (result.storage?.message ?? "No release found for this episode");
    return { episode, status: "missing" as const, reason };
  });

  const report: SeasonGrabReport = {
    season,
    totalEpisodes: episodes.length,
    coveredEpisodes: acquired.size,
    strategy: planStrategy(result.plan),
    coverageConfirmed: result.coverageConfirmed,
    episodes: episodeReports,
    planReason: result.plan.reason ?? null,
  };
  const episodeTransfers = exactSeasonEpisodeTransfers(
    episodes,
    result.items,
    failureByEpisode,
    packFailure,
    result.storage?.message ?? null,
  );

  // Nothing was sent to the client — no release could be taken for any wanted
  // episode. Reporting ok:true here (with "0 of N episodes") is the false
  // success that made the user press Download season twice: a green toast, an
  // AcquisitionTarget written as "downloading" with no hash, and no download.
  // Say so, and keep the report so the UI can still show which episodes missed.
  if (acquired.size === 0) {
    // Prefer a storage refusal when that is why nothing was sent — the UI turns
    // an overridable cap into "download anyway", which a generic "no release"
    // message cannot. A real empty plan keeps the release-not-found copy.
    if (result.storage) {
      return {
        ok: false,
        message: result.storage.message,
        report,
        storage: result.storage,
        episodeTransfers,
      };
    }
    return {
      ok: false,
      message: "No release found for this season yet — try again shortly.",
      report,
      episodeTransfers,
    };
  }

  return {
    ok: true,
    message: result.coverageLabel,
    report,
    episodeTransfers,
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

function failedEpisodeTransfers(
  episodes: readonly number[],
  error: string,
): TitleSeasonEpisodeTransfer[] {
  return episodes.map((episode) => ({
    episode,
    status: "failed",
    infoHash: null,
    error,
  }));
}

/** Read the strategy off the plan itself, rather than guessing from counts. */
function planStrategy(plan: SeasonPlan): SeasonGrabReport["strategy"] {
  const hasPack = plan.pack != null;
  const hasSingles = plan.singles.length > 0;
  if (hasPack && hasSingles) return "mixed";
  if (hasPack) return "pack";
  if (hasSingles) return "singles";
  return "unknown";
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
    noMatchMessage: (count) =>
      count
        ? `No ${minimumResolution ? `${minimumResolution}p-or-higher ` : ""}release for ${title} in ${count} results`
        : `No seeded ${minimumResolution ? `${minimumResolution}p-or-higher ` : ""}torrent for ${title}`,

    selectCandidate(results) {
      return selectWorkCandidate(
        results,
        input.workKey,
        input.isSeries,
        input.preferredResolution,
        title,
        searchCategory,
        minimumResolution,
      );
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
      return { category: target.category, savePath: target.savePath };
    },
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
