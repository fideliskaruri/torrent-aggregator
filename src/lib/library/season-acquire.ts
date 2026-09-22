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
import { logAcquisitionDecision } from "@/lib/observability/acquisition-diagnostics";
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

/**
 * Why a season search produced less than the whole season.
 *
 * A provider that answered `429` and a provider that answered "nothing here"
 * are different facts, and collapsing them into "No release found for this
 * episode" is the quiet dishonesty this subsystem refuses. `retryable` is the
 * signal the UI needs to say "try again shortly" instead of "does not exist".
 */
export interface SeasonSearchError {
  query: string;
  /** The exact episode this query was for, when it was a per-episode query. */
  episode?: number;
  /** Provider id when a single source failed inside an otherwise-ok search. */
  source?: string;
  message: string;
  retryable: boolean;
}

/**
 * How many consecutive outright search failures stop the ladder.
 *
 * Without this a provider refusing everything would still be asked once per
 * wanted episode — thirteen more requests to a service that just said no.
 */
const SEARCH_FAILURE_ABORT = 3;

/** What a season search ladder returns: rows plus what went wrong getting them. */
export interface SeasonSearchOutcome {
  releases: TorrentResult[];
  errors: SeasonSearchError[];
  /** Episodes whose exact `Show SxxEyy` query completed (with or without hits). */
  episodesQueried: number[];
  /** Rows dropped because they were a different work (alias rescue guard). */
  rejectedIdentity: number;
  /** How many indexer queries this season press actually issued. */
  queryCount: number;
  /** True when the search ladder stopped early to avoid hammering a failing provider. */
  aborted: boolean;
}

const RETRYABLE_RE =
  /\b(429|rate[\s-]?limit(?:ed|ing)?|too many requests|timed? ?out|timeout|econnreset|etimedout|socket hang up|temporarily|503|502|504)\b/i;

function isRetryableSearchFailure(message: string): boolean {
  return RETRYABLE_RE.test(message);
}

/**
 * The failure that best explains an empty result, if any.
 *
 * A retryable failure outranks a permanent one: if any contributing provider
 * said "later", the honest advice is to try later.
 */
export function chooseSeasonSearchError(
  errors: readonly SeasonSearchError[],
): SeasonSearchError | null {
  if (errors.length === 0) return null;
  return errors.find((e) => e.retryable) ?? errors[0];
}

/**
 * A season download that a provider rate-limited must not look like a season
 * that does not exist. This turns collected search failures into the sentence
 * an episode card shows when nothing could be found for it.
 */
export function seasonSearchFailureReason(
  errors: readonly SeasonSearchError[],
): string | null {
  const chosen = chooseSeasonSearchError(errors);
  if (!chosen) return null;
  const where = chosen.source ? `${chosen.source}: ` : "";
  return chosen.retryable
    ? `Search was refused by a provider (${where}${chosen.message}) — retry shortly.`
    : `Search failed (${where}${chosen.message}).`;
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
  preferredResolution: number | null = null,
): Promise<SeasonSearchOutcome> {
  const merged = new Map<string, TorrentResult>();
  /**
   * Which query shape first produced each merged row.
   *
   * Provenance, not re-identification, is what makes the alias guard correct.
   * A row found by a canonical-title query is already constrained by that
   * title; re-running the work-identity check on it and deleting it on a miss
   * would silently throw away legitimate releases whose scene name the
   * identity parser cannot reconstruct — the exact under-coverage this module
   * was fixed for. A row found only by a broad romaji alias query has no such
   * constraint, so it must prove it belongs to this work. Deleting by key
   * without provenance conflated the two: a legitimate primary row that also
   * happened to come back under an alias query was removed by the alias guard.
   */
  const provenance = new Map<string, "primary" | "alias">();
  const errors: SeasonSearchError[] = [];
  const episodesQueried = new Set<number>();
  let rejectedIdentity = 0;
  let queryCount = 0;
  const acceptedTitles = [title, ...aliases].flatMap((t) => aliasTitleForms(t));
  let consecutiveFailures = 0;
  let aborted = false;
  /** Retryability of the failures that made up the current failure window. */
  const failureWindow: boolean[] = [];

  const addAll = (
    rows: readonly TorrentResult[],
    origin: "primary" | "alias",
  ) => {
    for (const r of rows) {
      const key = releaseDedupeKey(r);
      if (!key || merged.has(key)) continue;
      merged.set(key, r);
      provenance.set(key, origin);
    }
  };

  /**
   * Record a failure and decide whether the ladder should stop.
   *
   * The abort sentinel inherits the retryability of the failures that caused
   * it. Marking it retryable unconditionally turned three permanent failures
   * (a bad request, a dead endpoint) into "retry shortly" — advice that is
   * wrong every time it is followed.
   */
  const noteFailure = (query: string, retryable: boolean) => {
    consecutiveFailures += 1;
    failureWindow.push(retryable);
    if (consecutiveFailures < SEARCH_FAILURE_ABORT) return;
    aborted = true;
    errors.push({
      query,
      message: `Stopped after ${consecutiveFailures} consecutive search failures`,
      retryable: failureWindow.some(Boolean),
    });
  };

  const clearFailures = () => {
    consecutiveFailures = 0;
    failureWindow.length = 0;
  };

  /**
   * One search, with the failure recorded rather than thrown.
   *
   * A single `429` used to reject the whole season press: one provider losing
   * its temper turned into "Could not plan this season" for thirteen episodes
   * that were otherwise findable. Errors are collected and reported; the ladder
   * keeps walking. It stops only when several searches in a row failed
   * outright, so a provider that is refusing everything is not hammered once
   * per episode.
   */
  const runSearch = async (
    opts: Parameters<typeof searchTorrents>[0],
    episode?: number,
    origin: "primary" | "alias" = "primary",
  ): Promise<TorrentResult[]> => {
    if (aborted) return [];
    queryCount += 1;
    let res: SearchResponse;
    try {
      res = await searchFn(opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = isRetryableSearchFailure(message);
      errors.push({ query: opts.query, episode, message, retryable });
      noteFailure(opts.query, retryable);
      return [];
    }
    const sources = res.sources ?? [];
    let anyRetryable = false;
    for (const s of sources) {
      if (!s.error) continue;
      const retryable = isRetryableSearchFailure(s.error);
      anyRetryable = anyRetryable || retryable;
      errors.push({
        query: opts.query,
        episode,
        source: String(s.id),
        message: s.error,
        retryable,
      });
    }
    const everySourceFailed =
      sources.length > 0 && sources.every((s) => Boolean(s.error));
    if (everySourceFailed) {
      noteFailure(opts.query, anyRetryable);
    } else {
      clearFailures();
      if (episode != null) episodesQueried.add(episode);
    }
    const rows = res.results ?? [];
    addAll(rows, origin);
    return rows;
  };

  /**
   * The episode a row can actually be used for.
   *
   * Coverage bookkeeping decides whether an exact `Show SxxEyy` search is
   * issued, so it must apply the same gates selection applies later: a magnet,
   * a live seeder, and the user's hard resolution floor. Counting a 480p or
   * dead row as "covered" is precisely how a thirteen-episode season came back
   * with two — the broad title-only query returned something for E03, the gap
   * fill skipped E03, and the planner then discarded that row for being below
   * the floor, leaving the episode missing with no search ever made for it.
   */
  const coverageEpisodeOf = (r: TorrentResult): number | null => {
    if (!r.magnet || (r.seeders ?? 0) <= 0 || releaseInfoHash(r) == null) {
      return null;
    }
    if (!meetsResolutionFloor(r.title ?? "", preferredResolution)) return null;
    if (
      acceptedTitles.length > 0 &&
      !episodeReleaseMatchesWork(r, acceptedTitles)
    ) {
      return null;
    }
    return releaseEpisodeNumber(r, season);
  };

  for (const query of seasonSearchQueries(title, season)) {
    await runSearch({
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
  }

  const coveredEpisodes = (): Set<number> => {
    const covered = new Set<number>();
    for (const r of merged.values()) {
      const ep = coverageEpisodeOf(r);
      if (ep != null) covered.add(ep);
    }
    return covered;
  };

  // Gap-fill exact episode queries for anything the season shapes missed.
  const covered = coveredEpisodes();
  if (wanted.length > 0) {
    for (const episode of wanted) {
      if (covered.has(episode)) continue;
      const rows = await runSearch(
        {
          query: episodeSearchQuery(title, season, episode),
          category,
          limit: 10,
          pageSize: 10,
          enrich: false,
          skipCache: false,
          background: false,
          filters: { hasMagnet: true, minSeeders: 1, season, episode },
        },
        episode,
      );
      for (const r of rows) {
        const ep = coverageEpisodeOf(r);
        if (ep != null) covered.add(ep);
      }
    }
  }

  const rescueNames = seasonAliasQueryNames(title, aliases);
  if (rescueNames.length === 0 || wanted.length === 0) {
    return {
      releases: [...merged.values()],
      errors,
      episodesQueried: [...episodesQueried],
      rejectedIdentity,
      queryCount,
      aborted,
    };
  }

  for (const alias of rescueNames) {
    const stillMissing = wanted.filter((e) => !covered.has(e));
    if (stillMissing.length === 0) break;
    const aliasRows: TorrentResult[] = [];
    aliasRows.push(
      ...(await runSearch(
        {
          query: seasonSearchQuery(alias, season),
          category,
          limit: 40,
          pageSize: 40,
          enrich: false,
          skipCache: false,
          background: false,
          filters: { hasMagnet: true, minSeeders: 1, season },
        },
        undefined,
        "alias",
      )),
    );
    for (const episode of stillMissing) {
      aliasRows.push(
        ...(await runSearch(
          {
            query: episodeSearchQuery(alias, season, episode),
            category,
            limit: 10,
            pageSize: 10,
            enrich: false,
            skipCache: false,
            background: false,
            filters: { hasMagnet: true, minSeeders: 1, season, episode },
          },
          episode,
          "alias",
        )),
      );
    }
    // A broad romaji query must not smuggle in a different series. Only rows
    // this alias pass *introduced* are subject to that guard: a row already
    // vouched for by a canonical-title query keeps its place, because its
    // provenance — not a second identity parse of its scene name — is what
    // established that it belongs to this work.
    for (const r of aliasRows) {
      if (episodeReleaseMatchesWork(r, acceptedTitles)) {
        const ep = coverageEpisodeOf(r);
        if (ep != null) covered.add(ep);
        continue;
      }
      const key = releaseDedupeKey(r);
      if (!key || provenance.get(key) !== "alias") continue;
      merged.delete(key);
      provenance.delete(key);
      rejectedIdentity += 1;
    }
  }

  return {
      releases: [...merged.values()],
      errors,
      episodesQueried: [...episodesQueried],
      rejectedIdentity,
      queryCount,
      aborted,
    };
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
  /** Search failures collected while building the plan (never thrown away). */
  searchErrors: SeasonSearchError[];
  /** Episodes whose exact per-episode query actually ran. */
  episodesQueried: number[];
  /** True when the search ladder stopped early after repeated failures. */
  searchAborted: boolean;
  /**
   * Counts behind the plan, for verbose acquisition diagnostics. Numbers and
   * reason tallies only — never a title, hash, magnet or path.
   */
  stats: {
    candidateCount: number;
    rejectedQuality: number;
    rejectedSeeders: number;
    rejectedIdentity: number;
    queryCount: number;
  };
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
  const preferredResolution =
    normalizeResolutionFloor(target.preferredResolution);

  const outcome: SeasonSearchOutcome = opts._releases
    ? {
        releases: opts._releases,
        errors: [],
        episodesQueried: [],
        rejectedIdentity: 0,
        queryCount: 0,
        aborted: false,
      }
    : await searchSeasonReleases(
        target.title,
        target.season,
        category,
        target.episodes,
        opts._searchFn,
        target.aliases ?? [],
        preferredResolution,
      );
  const releases = outcome.releases;

  let rejectedSeeders = 0;
  let rejectedQuality = 0;
  const usableUnranked = releases.filter((r) => {
    if (!r.magnet || (r.seeders ?? 0) <= 0 || releaseInfoHash(r) === null) {
      rejectedSeeders += 1;
      return false;
    }
    if (!meetsResolutionFloor(r.title, preferredResolution)) {
      rejectedQuality += 1;
      return false;
    }
    return true;
  });
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

  return {
    plan,
    releases: usable,
    probed,
    verdictOf,
    searchErrors: outcome.errors,
    episodesQueried: outcome.episodesQueried,
    searchAborted: outcome.aborted,
    stats: {
      candidateCount: usable.length,
      rejectedQuality,
      rejectedSeeders,
      rejectedIdentity: outcome.rejectedIdentity,
      queryCount: outcome.queryCount,
    },
  };
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
  /** Search failures behind any missing episode; empty when search was clean. */
  searchErrors?: SeasonSearchError[];
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
  const { plan, searchErrors, searchAborted, episodesQueried, stats } =
    await resolveSeasonPlan(target, opts);

  const config = await getUserClientConfig(target.userId);
  if (!config) {
    return {
      plan,
      items: [],
      acquired: [],
      coverageLabel: plan.coverageLabel,
      coverageConfirmed: plan.coverageConfirmed,
      storage: null,
      searchErrors,
    };
  }

  const category = searchCategoryForMediaType(target.mediaType) ?? "tv";
  const items: SeasonItemResult[] = [];
  const acquired = new Set<number>();
  let storageRefusal: StorageOverrideFacts | null = null;
  const retention = opts.retention ?? "keep";
  const overrideCap = opts.overrideStorageCap === true;
  const minResolution = normalizeResolutionFloor(target.preferredResolution);

  // Verbose diagnostics: counts and reason codes only. This is the view that
  // answers "why did a thirteen-episode season come back with two" without
  // logging a single title, hash, magnet or path.
  logAcquisitionDecision(config, "season_plan", {
    stage: "plan",
    scope: "season",
    season: target.season,
    wanted: plan.wanted.length,
    covered: plan.covered.length,
    missing: plan.missing.length,
    candidateCount: stats.candidateCount,
    rejectedQuality: stats.rejectedQuality,
    rejectedSeeders: stats.rejectedSeeders,
    rejectedIdentity: stats.rejectedIdentity,
    count: stats.queryCount,
    minResolution: minResolution ?? null,
    overrideStorageCap: overrideCap,
    strategy: plan.singles.length > 0 ? "singles" : "none",
    clientType: config.clientType,
    status: searchAborted ? "search_aborted" : "planned",
  });
  for (const e of searchErrors) {
    logAcquisitionDecision(config, "season_search_error", {
      stage: "search",
      scope: e.episode != null ? "episode" : "season",
      season: target.season,
      episode: e.episode ?? null,
      // `source` is the indexer id, which is already a safe low-cardinality
      // token; the provider's message never is, so only its class is logged.
      source: e.source ?? null,
      status: e.retryable ? "retryable" : "failed",
    });
  }

  const send = async (
    release: TorrentResult,
    verdict: SwarmVerdict,
    kind: "pack" | "single",
    episode: number | undefined,
    coversEpisodes: number[],
  ): Promise<boolean> => {
    let pathMode: string = "client-default";
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
        // Which path strategy produced the destination — the mode, never the
        // path itself.
        pathMode = t.savePath
          ? "smart-target"
          : config.baseDownloadPath?.trim()
            ? "client-base"
            : "client-default";
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

    logAcquisitionDecision(config, "season_send", {
      stage: "send",
      scope: "episode",
      season: target.season,
      episode: episode ?? null,
      status: res.status,
      strategy: kind === "pack" ? "pack" : "single",
      pathMode,
      minResolution: minResolution ?? null,
      overrideStorageCap: overrideCap,
      clientType: config.clientType,
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

  // Every wanted episode that never reached a send gets its own honest item.
  //
  // Without this, an episode the *search* failed for and an episode that
  // genuinely has no release were indistinguishable one layer up: both fell
  // through to "No release found for this episode". A provider that answered
  // `429` is a retry, not a verdict on the episode's existence, and a release
  // rejected for being below the user's floor is a quality decision, not an
  // absence. Each is said out loud, per episode, through the existing item
  // contract the title route already reads.
  const sentEpisodes = new Set(
    items
      .filter((i) => i.status === "sent" || i.status === "already_active")
      .map((i) => i.episode)
      .filter((e): e is number => e != null),
  );
  const attemptedEpisodes = new Set(
    items.map((i) => i.episode).filter((e): e is number => e != null),
  );
  const queried = new Set(episodesQueried);
  const floor = minResolution;
  const noRelease = {
    message:
      floor != null
        ? `No release found at ${floor}p or better for this episode.`
        : "No release found for this episode.",
    code: floor != null ? "below_quality_floor" : "not_found",
  };

  /**
   * One decision produces both the sentence the user reads and the code the
   * log records, so the two can never disagree. They previously derived
   * independently, which let a log say `search_aborted` (retry) while the card
   * said "Search failed" (permanent) about the same episode.
   *
   * Precedence, strongest evidence first: this episode's own failed search,
   * then the fact that its own search ran and found nothing (a real absence,
   * even while some other query was rate-limited), then a season-wide search
   * failure, then plain absence.
   */
  const describeMissing = (
    episode: number,
  ): { message: string; code: string } => {
    const own = chooseSeasonSearchError(
      searchErrors.filter((e) => e.episode === episode),
    );
    if (own) {
      return {
        message: seasonSearchFailureReason([own]) ?? noRelease.message,
        code: own.retryable ? "search_retryable" : "search_failed",
      };
    }
    if (queried.has(episode)) return noRelease;
    const wide = chooseSeasonSearchError(searchErrors);
    if (!wide) return noRelease;
    const retryable = wide.retryable;
    return {
      message: seasonSearchFailureReason([wide]) ?? noRelease.message,
      code: searchAborted
        ? retryable
          ? "search_aborted_retryable"
          : "search_aborted"
        : retryable
          ? "search_retryable"
          : "search_failed",
    };
  };

  for (const episode of plan.wanted) {
    if (sentEpisodes.has(episode) || attemptedEpisodes.has(episode)) continue;
    const { message, code } = describeMissing(episode);
    logAcquisitionDecision(config, "season_episode_missing", {
      stage: "failure",
      scope: "episode",
      season: target.season,
      episode,
      status: code,
      minResolution: floor ?? null,
      clientType: config.clientType,
    });
    items.push({
      kind: "single",
      episode,
      title: episodeSearchQuery(target.title, target.season, episode),
      verdict: "unknown",
      status: "failed",
      message,
      infoHash: null,
    });
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
    searchErrors,
  };
}
