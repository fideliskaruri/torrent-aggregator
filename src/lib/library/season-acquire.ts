/**
 * Season acquisition — orchestration + execution over the pure planner.
 *
 * `season-plan.ts` decides *what* to acquire from a table of releases and a
 * verdict lookup; this module supplies that table and executes the exact
 * episode plan. It is deliberately thin: every non-trivial decision lives in
 * the pure planner where it is tested without a swarm.
 *
 * The UI asks for a season; this layer turns that into one exact torrent per
 * episode so each card has its own truthful transfer state.
 *
 *   - {@link resolveSeasonPlan} — preview: which exact episodes can be grabbed.
 *   - {@link acquireSeason} — commit: resolve the plan, then add each chosen
 *     release through the normal grab pipeline with the caller's explicit
 *     stream/keep retention, and report honest coverage.
 */
import prisma from "@/lib/prisma";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { rankResults } from "@/lib/torrents/ranking";
import {
  meetsResolutionFloor,
  normalizeResolutionFloor,
} from "@/lib/torrents/quality";
import { getUserClientConfig } from "@/lib/clients";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
import { searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { checkSendStorage } from "@/lib/library/storage-gate";
import type { StorageOverrideFacts } from "@/lib/library/storage-override";
import { runGrabPipeline } from "@/lib/grab/pipeline";
import { releaseInfoHash } from "@/lib/prewarm/prerank";
import {
  loadSwarmVerdicts,
  type SwarmVerdict,
} from "@/lib/torrents/swarm-probe";
import { planSeason, type SeasonPlan, type SingleChoice } from "@/lib/torrents/season-plan";
import { parseEpisode } from "@/lib/torrents/episodes";
import { isEpisodeRangeRelease } from "@/lib/torrents/pack-preference";
import { episodeSearchQuery } from "@/lib/library/cursor";
import {
  aliasTitleForms,
  episodeReleaseMatchesWork,
  rankAliases,
} from "@/lib/library/ondemand";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import { applySendRetention, sendRetentionToPurpose, type SendRetention } from "@/lib/streaming/send-retention";

/**
 * Backend search query for a whole season (packs + episodes come back).
 *
 * Kept as the canonical first form for ranking / history labels. Indexers do
 * not all answer it — see {@link seasonSearchQueries}.
 */
export function seasonSearchQuery(title: string, season: number): string {
  const n = Math.max(1, Math.trunc(season));
  return `${title.trim()} S${String(n).padStart(2, "0")}`;
}

/**
 * Every query shape worth asking for a season download, in preference order.
 *
 * Measured against public indexers: `Rick and Morty S09` returns 0 hits while
 * bare `Rick and Morty` (with a season filter) returns every S09Exx single, and
 * `Season 9` sometimes surfaces multi-season packs. Asking only the Sxx form
 * is why "Download season" reported "No release found" on a show whose every
 * episode was one click away on the same page.
 */
export function seasonSearchQueries(title: string, season: number): string[] {
  const t = title.trim();
  if (!t) return [];
  const n = Math.max(1, Math.trunc(season));
  const padded = String(n).padStart(2, "0");
  // Deduped, order preserved. Title-only is always asked because it often finds
  // exact episode releases that season-shaped searches omit.
  const raw = [
    `${t} S${padded}`,
    `${t} Season ${n}`,
    `${t} S${padded} COMPLETE`,
    `${t} Season ${n} COMPLETE`,
    t,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of raw) {
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function releaseDedupeKey(r: TorrentResult): string | null {
  return releaseInfoHash(r) ?? (r.magnet ? r.magnet.toLowerCase() : null);
}

function releaseEpisodeNumber(r: TorrentResult, season: number): number | null {
  const ep = r.episode ?? parseEpisode(r.title ?? "");
  if (
    ep.isSeasonPack ||
    ep.isBatch ||
    ep.isMultiSeason ||
    isEpisodeRangeRelease(r.title ?? "")
  ) {
    return null;
  }
  if (ep.season != null && ep.season !== season) return null;
  return ep.episode ?? null;
}

/**
 * Search every season query shape and merge unique usable releases.
 *
 * Title-only hit lists often skew to the most popular recent episodes (E10
 * before E01). After the pack-oriented queries, any wanted episode still
 * missing a single is topped up with an exact `Show SxxEyy` search — the same
 * shape the per-episode Download button uses, so "Download season" cannot be
 * emptier than clicking each episode by hand.
 *
 * `aliases` are verified provider names (AniList romaji/native). Anime is
 * seeded under the romaji name no normalization of the English catalog title
 * can reach, so a season download of an anime finds nothing without them. They
 * are searched LAST, only for episodes still uncovered, bounded to two names,
 * and every row they return must pass the work-identity check against the show
 * and its aliases — a broad romaji query must not be able to smuggle in a
 * different series that happens to number its episodes the same way.
 */
async function searchSeasonReleases(
  title: string,
  season: number,
  category: NonNullable<Parameters<typeof searchTorrents>[0]["category"]>,
  wanted: readonly number[],
  searchFn: typeof searchTorrents = searchTorrents,
  aliases: readonly string[] = [],
): Promise<TorrentResult[]> {
  const merged = new Map<string, TorrentResult>();
  const addAll = (rows: readonly TorrentResult[]) => {
    for (const r of rows) {
      const key = releaseDedupeKey(r);
      if (!key || merged.has(key)) continue;
      merged.set(key, r);
    }
  };

  for (const query of seasonSearchQueries(title, season)) {
    const res = await searchFn({
      query,
      category,
      limit: 40,
      pageSize: 40,
      enrich: false,
      skipCache: false,
      // A season download is an explicit user action, not background work,
      // so it draws on the interactive indexer budget.
      background: false,
      filters: { hasMagnet: true, minSeeders: 1, season },
    });
    addAll(res.results);
  }

  const coveredEpisodes = (): Set<number> => {
    const covered = new Set<number>();
    for (const r of merged.values()) {
      const ep = releaseEpisodeNumber(r, season);
      if (ep != null) covered.add(ep);
    }
    return covered;
  };

  // Gap-fill exact episode queries for anything the season shapes missed.
  if (wanted.length > 0) {
    const covered = coveredEpisodes();
    for (const episode of wanted) {
      if (covered.has(episode)) continue;
      const res = await searchFn({
        query: episodeSearchQuery(title, season, episode),
        category,
        limit: 10,
        pageSize: 10,
        enrich: false,
        skipCache: false,
        background: false,
        filters: { hasMagnet: true, minSeeders: 1, season, episode },
      });
      addAll(res.results);
      for (const r of res.results) {
        const ep = releaseEpisodeNumber(r, season);
        if (ep != null) covered.add(ep);
      }
    }
  }

  const rescueNames = seasonAliasQueryNames(title, aliases);
  if (rescueNames.length === 0 || wanted.length === 0) return [...merged.values()];

  const acceptedTitles = [title, ...aliases].flatMap((t) => aliasTitleForms(t));
  const covered = coveredEpisodes();
  for (const alias of rescueNames) {
    const stillMissing = wanted.filter((e) => !covered.has(e));
    if (stillMissing.length === 0) break;
    const aliasRows: TorrentResult[] = [];
    const seasonRes = await searchFn({
      query: seasonSearchQuery(alias, season),
      category,
      limit: 40,
      pageSize: 40,
      enrich: false,
      skipCache: false,
      background: false,
      filters: { hasMagnet: true, minSeeders: 1, season },
    });
    aliasRows.push(...seasonRes.results);
    for (const episode of stillMissing) {
      const epRes = await searchFn({
        query: episodeSearchQuery(alias, season, episode),
        category,
        limit: 10,
        pageSize: 10,
        enrich: false,
        skipCache: false,
        background: false,
        filters: { hasMagnet: true, minSeeders: 1, season, episode },
      });
      aliasRows.push(...epRes.results);
    }
    const eligible = aliasRows.filter((r) =>
      episodeReleaseMatchesWork(r, acceptedTitles),
    );
    addAll(eligible);
    for (const r of eligible) {
      const ep = releaseEpisodeNumber(r, season);
      if (ep != null) covered.add(ep);
    }
  }

  return [...merged.values()];
}

/**
 * The alias names worth a season search: genuinely different names only (an
 * alias that is the canonical title minus its punctuation buys nothing here),
 * strongest first, capped at two so a season press stays bounded.
 */
export function seasonAliasQueryNames(
  title: string,
  aliases: readonly string[],
): string[] {
  const squash = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const known = new Set<string>(
    aliasTitleForms(title).map((t) => squash(t)),
  );
  const out: string[] = [];
  for (const alias of aliases) {
    // Every form of the alias competes; `rankAliases` prefers the short,
    // space-separated, punctuation-free name indexers actually rank, which for
    // AniList romaji is the comma head rather than the full sentence.
    const forms = aliasTitleForms(alias).filter((variant) => {
      const key = squash(variant);
      return Boolean(key) && !known.has(key);
    });
    const best = rankAliases(forms)[0];
    if (!best) continue;
    known.add(squash(best));
    out.push(best);
    if (out.length >= 2) break;
  }
  return out;
}

export interface SeasonAcquireTarget {
  userId: string;
  workId?: string | null;
  title: string;
  mediaType: string;
  season: number;
  /**
   * Verified provider names for this work (AniList romaji/native and other
   * confirmed aliases). Anime is seeded under names the English catalog title
   * cannot reach, so a season download without them finds nothing. Optional;
   * ordinary TV passes none and behaves exactly as before.
   */
  aliases?: readonly string[];
  /** Minimum output height. Lower and unknown resolutions are ineligible. */
  preferredResolution?: number | null;
  /**
   * Authoritative wanted-episode numbers. The caller knows the season's
   * episode count from metadata; the planner never invents episodes it cannot
   * see, so honest "8 of 10" reporting depends on this being the real list.
   */
  episodes: number[];
  /**
   * Retained in the API contract for callers that already compute it. Exact
   * episode acquisition never grabs unaired gaps regardless.
   */
  seasonComplete?: boolean;
}

export interface ResolveSeasonOptions {
  db?: typeof prisma;
  /** Test seam — supply releases directly instead of searching. */
  _releases?: TorrentResult[];
  /** Test seam — inject the search function used by the multi-query ladder. */
  _searchFn?: typeof searchTorrents;
}

export interface ResolveSeasonResult {
  plan: SeasonPlan;
  /** Every usable release considered, in ranker order (for the preview UI). */
  releases: TorrentResult[];
  /** Retained for response compatibility; exact planning performs no pack probes. */
  probed: string[];
  /**
   * The verdict lookup used to build the plan.
   */
  verdictOf: (r: TorrentResult) => SwarmVerdict;
}

/**
 * Search, load cached verdicts, and build an exact-episode plan.
 */
export async function resolveSeasonPlan(
  target: SeasonAcquireTarget,
  opts: ResolveSeasonOptions = {},
): Promise<ResolveSeasonResult> {
  const db = opts.db ?? prisma;
  const category = searchCategoryForMediaType(target.mediaType) ?? "tv";

  const releases =
    opts._releases ??
    (await searchSeasonReleases(
      target.title,
      target.season,
      category,
      target.episodes,
      opts._searchFn,
      target.aliases ?? [],
    ));

  const preferredResolution =
    normalizeResolutionFloor(target.preferredResolution);
  const usableUnranked = releases.filter(
    (r) =>
      r.magnet &&
      (r.seeders ?? 0) > 0 &&
      releaseInfoHash(r) !== null &&
      meetsResolutionFloor(r.title, preferredResolution),
  );
  const usable =
    preferredResolution == null
      ? usableUnranked
      : rankResults(
          usableUnranked,
          seasonSearchQuery(target.title, target.season),
          preferredResolution,
          category,
        );

  const probed: string[] = [];
  const verdicts = await loadSwarmVerdicts(
    usable.map((r) => releaseInfoHash(r)),
    { db },
  );
  const verdictOf = (r: TorrentResult): SwarmVerdict => {
    const h = releaseInfoHash(r);
    return (h && verdicts.get(h)) || "unknown";
  };

  const plan = planSeason({
    season: target.season,
    wanted: target.episodes,
    releases: usable,
    verdictOf,
    preferredResolution,
    seasonComplete: target.seasonComplete,
  });

  return { plan, releases: usable, probed, verdictOf };
}

export interface SeasonItemResult {
  kind: "pack" | "single";
  episode?: number;
  title: string;
  verdict: SwarmVerdict;
  status: "sent" | "failed" | "skipped" | "already_active";
  message: string;
  infoHash: string | null;
}

export interface AcquireSeasonResult {
  plan: SeasonPlan;
  items: SeasonItemResult[];
  /** Wanted episodes for which a torrent was actually sent (or already active). */
  acquired: number[];
  /** Honest end-state summary, e.g. "8 of 10 episodes". */
  coverageLabel: string;
  /**
   * Always true for a returned plan because singles name exact episodes.
   */
  coverageConfirmed: boolean;
  /**
   * Set when a storage limit refused every send. Cap/reserve are overridable;
   * the UI turns this into a "download anyway" confirmation. Null when at least
   * one release was sent, or when the failure was not a storage refusal.
   */
  storage?: StorageOverrideFacts | null;
}

export interface AcquireSeasonOptions extends ResolveSeasonOptions {
  /** Optional library item id for GrabJob externalId. */
  watchListItemId?: string | null;
  /** "stream" = reclaimable cache; "keep" = permanent download. */
  retention?: SendRetention;
  /**
   * The owner saw the real figures and chose to exceed their own storage cap.
   * Honoured for cap/reserve only — never for a release that genuinely won't fit.
   */
  overrideStorageCap?: boolean;
  /** Test seam — override the send function. */
  _sendFn?: typeof import("@/lib/clients").sendToClient;
}

/**
 * Resolve then execute: add the chosen exact singles as `origin: "user"`.
 *
 * Each add goes through the shared grab pipeline, which sends via the client
 * (builtin → `addTorrentWithEngineDefaults`, inheriting the private-swarm
 * tracker rule and the `origin: "user"` default) and records GrabJob +
 * DownloadHistory. The pipeline's own infoHash dedupe remains a backstop.
 */
export async function acquireSeason(
  target: SeasonAcquireTarget,
  opts: AcquireSeasonOptions = {},
): Promise<AcquireSeasonResult> {
  const db = opts.db ?? prisma;
  const { plan } = await resolveSeasonPlan(target, opts);

  const config = await getUserClientConfig(target.userId);
  if (!config) {
    return {
      plan,
      items: [],
      acquired: [],
      coverageLabel: plan.coverageLabel,
      coverageConfirmed: plan.coverageConfirmed,
      storage: null,
    };
  }

  const category = searchCategoryForMediaType(target.mediaType) ?? "tv";
  const items: SeasonItemResult[] = [];
  const acquired = new Set<number>();
  let storageRefusal: StorageOverrideFacts | null = null;
  const retention = opts.retention ?? "keep";
  const overrideCap = opts.overrideStorageCap === true;

  const send = async (
    release: TorrentResult,
    verdict: SwarmVerdict,
    kind: "pack" | "single",
    episode: number | undefined,
    coversEpisodes: number[],
  ): Promise<boolean> => {
    const res = await runGrabPipeline({
      userId: target.userId,
      workId: target.workId ?? null,
      // The pipeline searches; we hand it exactly the chosen release so it
      // sends that and nothing else. selectCandidate is pinned to the release.
      search: {
        query: seasonSearchQuery(target.title, target.season),
        category,
        limit: 1,
        enrich: false,
        skipCache: true,
        background: false,
        filters: { hasMagnet: true, minSeeders: 1, season: target.season },
      },
      config,
      grabJobKind: "ondemand",
      externalId: opts.watchListItemId ?? null,
      purpose: sendRetentionToPurpose(retention, opts.watchListItemId),
      minimumResolution:
        retention === "keep" ? target.preferredResolution : null,
      downloadHistoryPrefix:
        kind === "pack"
          ? `Season ${target.season} pack`
          : `Season ${target.season} E${String(episode).padStart(2, "0")}`,
      fallbackTitle: release.title,
      selectCandidate: () => release,
      // Engine-side storage check must see the same override the gate honours,
      // or a confirmed over-cap grab passes here and is refused there.
      addPayload: { overrideStorageCap: overrideCap },
      resolveTarget(cfg: ClientConnectionConfig, candidate: TorrentResult) {
        const t = resolveSmartSendTarget(cfg, {
          name: candidate.title,
          source: candidate.source,
          searchCategory: category,
          metadata: catalogMetadata({
            mediaType: target.mediaType,
            title: target.title,
          }),
        });
        return { category: t.category, savePath: t.savePath };
      },
      async checkStorageBudget(candidate, t) {
        const root =
          config.baseDownloadPath?.trim() ||
          t.savePath ||
          config.savePath?.trim() ||
          process.cwd();
        const space = await checkSendStorage({
          userId: target.userId,
          config,
          root,
          incomingBytes: candidate.sizeBytes ?? null,
          retention,
          protectHashes: candidate.infoHash ? [candidate.infoHash] : [],
          overrideCap,
        });
        if (space.ok) return { ok: true as const };
        if (space.override && !storageRefusal) storageRefusal = space.override;
        return {
          ok: false as const,
          message: space.message,
          storage: space.override,
        };
      },
      _searchFn: (async () =>
        ({
          query: "",
          results: [release],
          groups: [],
          tookMs: 0,
          sources: [],
          totalCount: 1,
          page: 1,
          pageSize: 1,
          totalPages: 1,
        }) as SearchResponse) as typeof searchTorrents,
      _sendFn: opts._sendFn,
      _prisma: db,
    });

    items.push({
      kind,
      episode,
      title: release.title,
      verdict,
      status: res.status,
      message: res.message,
      infoHash: releaseInfoHash(release),
    });

    if (res.status === "sent" || res.status === "already_active") {
      await applySendRetention({
        userId: target.userId,
        config,
        infoHash: releaseInfoHash(release),
        retention,
        watchListItemId: opts.watchListItemId,
      });
      for (const e of coversEpisodes) acquired.add(e);
      return true;
    }
    if (res.storage && !storageRefusal) storageRefusal = res.storage;
    return false;
  };

  for (const s of plan.singles as SingleChoice[]) {
    await send(s.release, s.verdict, "single", s.episode, [s.episode]);
  }

  const acquiredList = [...acquired].filter((e) => plan.wanted.includes(e)).sort((a, b) => a - b);
  return {
    plan,
    items,
    acquired: acquiredList,
    coverageLabel: `${acquiredList.length} of ${plan.wanted.length} episodes`,
    coverageConfirmed: plan.coverageConfirmed,
    // Only surface a storage refusal when nothing was acquired — a partial
    // season that hit the cap mid-way still delivered what it could, and the
    // per-item messages already say which releases failed.
    storage: acquiredList.length === 0 ? storageRefusal : null,
  };
}
