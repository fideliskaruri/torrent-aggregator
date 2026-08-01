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
import { searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { parseEpisode } from "@/lib/torrents/episodes";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { matchesTargetEpisode } from "@/lib/torrents/pack-preference";
import { rankResults } from "@/lib/torrents/ranking";
import type { TorrentResult } from "@/lib/torrents/types";
import { workIdentityFor, workKeyMatches } from "@/components/title/work-key";
import { acquireSeason } from "@/lib/library/season-acquire";
import { applySendRetention, sendRetentionToPurpose } from "@/lib/streaming/send-retention";
import type { SeasonPlan } from "@/lib/torrents/season-plan";
import type {
  TitleGrabRequest,
  TitleGrabResponse,
  TitleSeasonGrabResponse,
} from "@/components/title/types";
import type {
  SeasonGrabEpisodeReport,
  SeasonGrabReport,
} from "@/components/title/season-grab-state";
import prisma from "@/lib/prisma";

export interface TitleGrabInput extends TitleGrabRequest {
  userId: string;
  workKey: string;
  /** Resolved server-side; the client is never trusted for identity. */
  resolvedTitle: string;
  resolvedMediaType: string | null;
  isSeries: boolean;
  watchListItemId: string | null;
}

export async function grabForTitle(
  input: TitleGrabInput,
): Promise<TitleGrabResponse> {
  const season = toPositiveInt(input.season);
  const episode = toPositiveInt(input.episode);

  if (season != null && episode != null) {
    const reused = await reuseStreamingEpisode(input, { season, episode });
    if (reused) return reused;

    const request: Parameters<typeof grabSingleEpisode>[0] = {
      userId: input.userId,
      showTitle: input.resolvedTitle,
      // A row we are hunting episode-by-episode is a series by construction;
      // this states that default in the open rather than hiding it in the
      // shared media-type module (see the comment there).
      mediaType: input.resolvedMediaType ?? "tv",
      season,
      episode,
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

  return grabWholeWork(input);
}

export interface TitleSeasonGrabInput extends TitleGrabInput {
  season: number;
  episodes: number[];
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
    };
  }

  let result: Awaited<ReturnType<typeof acquireSeason>>;
  try {
    const target: Parameters<typeof acquireSeason>[0] = {
      userId: input.userId,
      title: input.resolvedTitle,
      mediaType: input.resolvedMediaType ?? "tv",
      season,
      episodes,
      preferredResolution: input.preferredResolution ?? null,
    };
    result = await acquireSeason(target, {
      watchListItemId: input.watchListItemId,
      retention: input.retention ?? "keep",
    });
  } catch (err) {
    // A failed plan is an error, not an empty season. Saying "no episodes
    // found" here would be the same lie the episode list used to tell.
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Could not plan this season",
    };
  }

  const acquired = new Set(result.acquired);
  const episodeReports: SeasonGrabEpisodeReport[] = episodes.map((episode) => {
    if (acquired.has(episode)) return { episode, status: "covered" as const };
    return {
      episode,
      status: "missing" as const,
      reason: "No release found for this episode",
    };
  });

  const report: SeasonGrabReport = {
    season,
    totalEpisodes: episodes.length,
    coveredEpisodes: acquired.size,
    strategy: planStrategy(result.plan),
    coverageConfirmed: result.coverageConfirmed,
    episodes: episodeReports,
  };

  return {
    ok: true,
    message: result.coverageLabel,
    report,
  };
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

  const result = await runGrabPipeline({
    userId: input.userId,
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
    downloadHistoryPrefix: "Title page",
    noMatchMessage: (count) =>
      count
        ? `No release for ${title} in ${count} results`
        : `No seeded torrent for ${title}`,

    selectCandidate(results) {
      return selectWorkCandidate(
        results,
        input.workKey,
        input.isSeries,
        input.preferredResolution,
        title,
        searchCategory,
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
  const usable = ordered.filter((r) => r.magnet && (r.seeders ?? 0) > 0);

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
  target: { season: number; episode: number; workKey?: string | null },
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
      { ...target, workKey: input.workKey },
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
