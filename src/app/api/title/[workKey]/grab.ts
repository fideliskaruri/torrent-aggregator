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
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { assertStorageBudget } from "@/lib/library/disk-space";
import { grabSingleEpisode } from "@/lib/library/ondemand";
import { runGrabPipeline } from "@/lib/grab/pipeline";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
import { searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { parseEpisode } from "@/lib/torrents/episodes";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import type { TorrentResult } from "@/lib/torrents/types";
import { workIdentityFor, workKeyMatches } from "@/components/title/work-key";
import type {
  TitleGrabRequest,
  TitleGrabResponse,
  TitleSeasonGrabResponse,
} from "@/components/title/types";
import type {
  SeasonGrabEpisodeReport,
  SeasonGrabReport,
} from "@/components/title/season-grab-state";

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
    const result = await grabSingleEpisode({
      userId: input.userId,
      showTitle: input.resolvedTitle,
      // A row we are hunting episode-by-episode is a series by construction;
      // this states that default in the open rather than hiding it in the
      // shared media-type module (see the comment there).
      mediaType: input.resolvedMediaType ?? "tv",
      season,
      episode,
      watchListItemId: input.watchListItemId,
    });
    return {
      ok: result.ok,
      message: result.message,
      title: result.title ?? null,
      savePath: result.savePath ?? null,
      infoHash: result.infoHash ?? null,
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

  const episodeReports: SeasonGrabEpisodeReport[] = [];
  const coveredHashes = new Set<string>();

  for (const episode of episodes) {
    const result = await grabSingleEpisode({
      userId: input.userId,
      showTitle: input.resolvedTitle,
      mediaType: input.resolvedMediaType ?? "tv",
      season,
      episode,
      watchListItemId: input.watchListItemId,
    });

    if (result.ok) {
      const hash = normalizeInfoHash(result.infoHash);
      if (hash) coveredHashes.add(hash);
      episodeReports.push({ episode, status: "covered" });
      continue;
    }

    if (isNoReleaseMessage(result.message)) {
      episodeReports.push({
        episode,
        status: "missing",
        reason: result.message,
      });
      continue;
    }

    return {
      ok: false,
      message: result.message,
      report: seasonReport(season, episodes, episodeReports, coveredHashes),
    };
  }

  const report = seasonReport(season, episodes, episodeReports, coveredHashes);
  return {
    ok: true,
    message: `${report.coveredEpisodes} of ${report.totalEpisodes} episodes covered`,
    report,
  };
}

/**
 * A film, or a whole series where no episode was named.
 *
 * Mirrors `grabSingleEpisode`'s pipeline options exactly, minus the episode
 * filter and the cursor advance: same explicit-user semantics (no dedupe gate,
 * no viability gate — the user asked for this by name), same storage-budget
 * check, same smart save-path resolution.
 */
async function grabWholeWork(input: TitleGrabInput): Promise<TitleGrabResponse> {
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
    downloadHistoryPrefix: "Title page",
    noMatchMessage: (count) =>
      count
        ? `No release for ${title} in ${count} results`
        : `No seeded torrent for ${title}`,

    selectCandidate(results) {
      return selectWorkCandidate(results, input.workKey, input.isSeries);
    },

    async checkStorageBudget(candidate, target) {
      const root =
        config.baseDownloadPath?.trim() ||
        target.savePath ||
        config.savePath?.trim() ||
        process.cwd();
      const space = await assertStorageBudget({
        root,
        maxStorageBytes: config.maxStorageBytes,
        incomingBytes: candidate.sizeBytes ?? null,
      });
      return space.ok
        ? { ok: true as const }
        : { ok: false as const, message: space.message };
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

  return {
    // An already-active grab is a success from the caller's point of view:
    // the release IS downloading. Reporting ok:false would tell the user the
    // grab failed while the torrent runs in the background.
    ok: result.status === "sent" || result.status === "already_active",
    message: result.message,
    title: result.candidate?.title ?? null,
    savePath: result.target?.savePath ?? null,
    infoHash: normalizeInfoHash(result.candidate?.infoHash),
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
): TorrentResult | null {
  const usable = results.filter((r) => r.magnet && (r.seeders ?? 0) > 0);

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

function isNoReleaseMessage(message: string): boolean {
  return /no (seeded torrent|matching .* release|release .* in \d+ results)/i.test(
    message,
  );
}

function seasonReport(
  season: number,
  episodes: number[],
  episodeReports: SeasonGrabEpisodeReport[],
  coveredHashes: Set<string>,
): SeasonGrabReport {
  const answered = new Map(episodeReports.map((episode) => [episode.episode, episode]));
  const complete = episodes.map(
    (episode) =>
      answered.get(episode) ?? {
        episode,
        status: "not_measured" as const,
        reason: "The planner stopped before this episode was measured.",
      },
  );
  const coveredEpisodes = complete.filter(
    (episode) => episode.status === "covered",
  ).length;

  return {
    season,
    totalEpisodes: episodes.length,
    coveredEpisodes,
    strategy: inferSeasonStrategy(coveredHashes.size, coveredEpisodes),
    episodes: complete,
  };
}

function inferSeasonStrategy(
  uniqueCoveredHashes: number,
  coveredEpisodes: number,
): SeasonGrabReport["strategy"] {
  if (coveredEpisodes === 0) return "unknown";
  if (coveredEpisodes > 1 && uniqueCoveredHashes === 1) return "pack";
  if (uniqueCoveredHashes > 1 && uniqueCoveredHashes < coveredEpisodes) return "mixed";
  return "singles";
}
