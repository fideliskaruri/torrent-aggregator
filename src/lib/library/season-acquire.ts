/**
 * Season acquisition — orchestration + execution over the pure planner.
 *
 * `season-plan.ts` decides *what* to acquire from a table of releases and a
 * verdict lookup; this module supplies that table (one search), the verdicts
 * (cached, with a tiny bounded top-up probe), and then executes the plan by
 * adding the chosen torrents. It is deliberately thin: every non-trivial
 * decision lives in the pure planner where it is tested without a swarm.
 *
 * The user's request was "download a whole season, favour good packs but also
 * be able to find multiple episodes if available, automatically." The seam the
 * UI (`wt-title`) calls:
 *
 *   - {@link resolveSeasonPlan} — preview: what would we grab, and why. Reads
 *     cached verdicts, probes at most a few top *packs* to firm up the choice,
 *     never touches the client. Safe to call to render a plan.
 *   - {@link acquireSeason} — commit: resolve the plan, then add each chosen
 *     release through the normal grab pipeline with the caller's explicit
 *     stream/keep retention, and report honest coverage.
 */
import prisma from "@/lib/prisma";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { rankResults } from "@/lib/torrents/ranking";
import { getUserClientConfig } from "@/lib/clients";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
import { searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { checkSendStorage } from "@/lib/library/storage-gate";
import type { StorageOverrideFacts } from "@/lib/library/storage-override";
import { runGrabPipeline } from "@/lib/grab/pipeline";
import { releaseInfoHash } from "@/lib/prewarm/prerank";
import { foregroundActive } from "@/lib/prewarm/foreground";
import { findLiveBuiltinTorrent } from "@/lib/clients/builtin-engine";
import {
  getSwarmMeasurement,
  loadSwarmVerdicts,
  probeAndRecord,
  type SwarmVerdict,
} from "@/lib/torrents/swarm-probe";
import { planSeason, episodesFromFilenames, type PackChoice, type SeasonPlan, type SingleChoice } from "@/lib/torrents/season-plan";
import { parseEpisode } from "@/lib/torrents/episodes";
import { episodeSearchQuery } from "@/lib/library/cursor";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import { applySendRetention, sendRetentionToPurpose, type SendRetention } from "@/lib/streaming/send-retention";

/**
 * How many top candidates a *synchronous* resolve will probe.
 *
 * A user pressing "Download season" wants an answer now, so this path leans on
 * cached verdicts (from the background pre-probe) and only tops up a couple of
 * the most consequential releases — the packs, because the whole strategy
 * pivots on whether a pack is good. Small on purpose: an 8s window × 3 is at
 * most ~24s of trickle, and it never runs while a viewer is active.
 */
export const MAX_SEASON_RESOLVE_PROBES = 3;

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
  // Deduped, order preserved. Title-only is last among the pack-shaped forms
  // so a real pack still wins when the Sxx query works, but it is always
  // asked — that is the form that finds per-episode releases for airing seasons.
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
  if (ep.isSeasonPack) return null;
  if (ep.season != null && ep.season !== season) return null;
  return ep.episode ?? null;
}

function hasSeasonPack(releases: Iterable<TorrentResult>, season: number): boolean {
  for (const r of releases) {
    const ep = r.episode ?? parseEpisode(r.title ?? "");
    if (!ep.isSeasonPack) continue;
    if (ep.season == null || ep.season === season) return true;
  }
  return false;
}

/**
 * Search every season query shape and merge unique usable releases.
 *
 * Title-only hit lists often skew to the most popular recent episodes (E10
 * before E01). After the pack-oriented queries, any wanted episode still
 * missing a single is topped up with an exact `Show SxxEyy` search — the same
 * shape the per-episode Download button uses, so "Download season" cannot be
 * emptier than clicking each episode by hand.
 */
async function searchSeasonReleases(
  title: string,
  season: number,
  category: NonNullable<Parameters<typeof searchTorrents>[0]["category"]>,
  wanted: readonly number[],
  searchFn: typeof searchTorrents = searchTorrents,
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
      enrich: false,
      skipCache: false,
      // A season download is an explicit user action, not background work,
      // so it draws on the interactive indexer budget.
      background: false,
      filters: { hasMagnet: true, minSeeders: 1, season },
    });
    addAll(res.results);
    // A pack for this season is enough — the planner prefers it over singles.
    if (hasSeasonPack(merged.values(), season)) break;
  }

  // Gap-fill: exact episode queries for anything the season shapes missed.
  // Cap at the wanted list so a 24-ep season does not fire 24 searches when a
  // pack already covers it (handled above) or when most episodes already hit.
  if (!hasSeasonPack(merged.values(), season) && wanted.length > 0) {
    const covered = new Set<number>();
    for (const r of merged.values()) {
      const ep = releaseEpisodeNumber(r, season);
      if (ep != null) covered.add(ep);
    }
    for (const episode of wanted) {
      if (covered.has(episode)) continue;
      const res = await searchFn({
        query: episodeSearchQuery(title, season, episode),
        category,
        limit: 10,
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

  return [...merged.values()];
}

export interface SeasonAcquireTarget {
  userId: string;
  title: string;
  mediaType: string;
  season: number;
  /** Preferred output height. Used for affinity ordering, never as a filter. */
  preferredResolution?: number | null;
  /**
   * Authoritative wanted-episode numbers. The caller knows the season's
   * episode count from metadata; the planner never invents episodes it cannot
   * see, so honest "8 of 10" reporting depends on this being the real list.
   */
  episodes: number[];
}

export interface ResolveSeasonOptions {
  db?: typeof prisma;
  /** Cap synchronous probes. */
  maxProbes?: number;
  /** Test seam — supply releases directly instead of searching. */
  _releases?: TorrentResult[];
  /** Test seam — inject the search function used by the multi-query ladder. */
  _searchFn?: typeof searchTorrents;
  /** Test seam — inject the probe. */
  _probeFn?: typeof probeAndRecord;
  /** Test seam — inject the live-download guard. */
  _findLive?: (hash: string) => unknown;
  /** Test seam — override the foreground check. */
  _foregroundActive?: () => boolean;
  /**
   * Read a torrent's actual file manifest without sending it. A pack is not
   * eligible when this returns null/empty or when the manifest is incomplete.
   */
  _packFilesOf?: (
    hash: string,
  ) => string[] | null | Promise<string[] | null>;
}

export interface ResolveSeasonResult {
  plan: SeasonPlan;
  /** Every usable release considered, in ranker order (for the preview UI). */
  releases: TorrentResult[];
  /** Info-hashes freshly probed while resolving. */
  probed: string[];
  /**
   * The verdict lookup used to build the plan.
   */
  verdictOf: (r: TorrentResult) => SwarmVerdict;
}

const MANIFEST_READ_CONCURRENCY = 3;

async function readPackManifests(
  releases: readonly TorrentResult[],
  filesOf: NonNullable<ResolveSeasonOptions["_packFilesOf"]>,
): Promise<Map<string, string[]>> {
  const hashes = [
    ...new Set(
      releases
        .map((release) => releaseInfoHash(release))
        .filter((hash): hash is string => hash !== null),
    ),
  ];
  const manifests = new Map<string, string[]>();
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(MANIFEST_READ_CONCURRENCY, hashes.length) },
    async () => {
      while (cursor < hashes.length) {
        const hash = hashes[cursor++];
        const files = await filesOf(hash);
        if (Array.isArray(files) && files.length > 0) {
          manifests.set(hash, files);
        }
      }
    },
  );
  await Promise.all(workers);
  return manifests;
}

/**
 * Search once, load cached verdicts, top up a couple of pack probes, and build
 * the plan. Pure planner does the deciding; this only feeds it.
 */
export async function resolveSeasonPlan(
  target: SeasonAcquireTarget,
  opts: ResolveSeasonOptions = {},
): Promise<ResolveSeasonResult> {
  const db = opts.db ?? prisma;
  const probe = opts._probeFn ?? probeAndRecord;
  const findLive = opts._findLive ?? findLiveBuiltinTorrent;
  const isForeground = opts._foregroundActive ?? foregroundActive;
  const maxProbes = Math.max(0, opts.maxProbes ?? MAX_SEASON_RESOLVE_PROBES);

  const category = searchCategoryForMediaType(target.mediaType) ?? "tv";

  const releases =
    opts._releases ??
    (await searchSeasonReleases(
      target.title,
      target.season,
      category,
      target.episodes,
      opts._searchFn,
    ));

  const usableUnranked = releases.filter(
    (r) => r.magnet && (r.seeders ?? 0) > 0 && releaseInfoHash(r) !== null,
  );
  const preferredResolution =
    target.preferredResolution != null &&
    Number.isFinite(target.preferredResolution) &&
    target.preferredResolution >= 1
      ? Math.trunc(target.preferredResolution)
      : null;
  const usable =
    preferredResolution == null
      ? usableUnranked
      : rankResults(
          usableUnranked,
          seasonSearchQuery(target.title, target.season),
          preferredResolution,
          category,
        );

  // ── Bounded, speculative top-up probe ─────────────────────────────────────
  // Never compete with a viewer: if someone is watching, rely purely on the
  // cache. Probe only the top few *packs* (unknown, not live, not already
  // fresh) — those are the releases whose verdict changes the whole plan.
  const probed: string[] = [];
  if (maxProbes > 0 && !isForeground()) {
    const packCandidates = usable.filter((r) => r.episode?.isSeasonPack).slice(0, maxProbes * 2);
    for (const candidate of packCandidates) {
      if (probed.length >= maxProbes) break;
      if (isForeground()) break;
      const hash = releaseInfoHash(candidate);
      if (!hash) continue;
      // Never probe a live download — that guard protects a user's real files.
      if (findLive(hash)) continue;
      const existing = await getSwarmMeasurement(hash, { db });
      if (existing && existing.verdict !== "unknown") continue;
      await probe(
        { magnet: candidate.magnet ?? null, infoHash: hash },
        { db, sizeBytes: candidate.sizeBytes ?? null, name: candidate.title ?? null },
      );
      probed.push(hash);
    }
  }

  // Load verdicts AFTER the top-up so freshly-probed packs are reflected.
  const verdicts = await loadSwarmVerdicts(
    usable.map((r) => releaseInfoHash(r)),
    { db },
  );
  const verdictOf = (r: TorrentResult): SwarmVerdict => {
    const h = releaseInfoHash(r);
    return (h && verdicts.get(h)) || "unknown";
  };

  const manifestFiles = await readPackManifests(
    usable,
    opts._packFilesOf ?? livePackFiles,
  );

  const plan = planSeason({
    season: target.season,
    wanted: target.episodes,
    releases: usable,
    verdictOf,
    preferredResolution,
    packContents: (release) => {
      const hash = releaseInfoHash(release);
      const files = hash ? manifestFiles.get(hash) : null;
      return files ? episodesFromFilenames(files, target.season) : null;
    },
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
   * Always true for a returned plan: packs require a complete verified manifest
   * and singles name the exact episode.
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
 * Read the real file paths of an already-live torrent. New packs remain
 * ineligible until a metadata-only manifest provider is wired; the planner
 * falls back to exact episodes rather than sending first and checking later.
 */
function livePackFiles(hash: string): string[] | null {
  const t = findLiveBuiltinTorrent(hash) as
    | { files?: Array<{ path?: string; name?: string }> }
    | null
    | undefined;
  const files = t?.files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const paths = files.map((f) => f.path || f.name || "").filter(Boolean);
  return paths.length > 0 ? paths : null;
}

/**
 * Resolve then execute: add the chosen pack and singles as `origin: "user"`.
 *
 * Each add goes through the shared grab pipeline, which sends via the client
 * (builtin → `addTorrentWithEngineDefaults`, inheriting the private-swarm
 * tracker rule and the `origin: "user"` default) and records GrabJob +
 * DownloadHistory. The pipeline's own 5-minute infoHash dedupe means an episode
 * already covered by the pack and re-requested cannot double-add — but the plan
 * already guarantees no double-grab, so that is only a backstop.
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

  // The planner chose this pack: file-confirmed when its torrent was already
  // live, otherwise taken on its name and marked unconfirmed. Either way it is
  // the plan's choice to send — a pack whose files cannot be read yet is the
  // normal first-grab case, not a reason to send nothing.
  if (plan.pack) {
    const p: PackChoice = plan.pack;
    await send(p.release, p.verdict, "pack", undefined, p.covers);
  }
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
