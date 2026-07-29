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
import { getUserClientConfig } from "@/lib/clients";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
import { searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { assertStorageBudget } from "@/lib/library/disk-space";
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

/** Backend search query for a whole season (packs + episodes come back). */
export function seasonSearchQuery(title: string, season: number): string {
  return `${title.trim()} S${String(Math.max(1, Math.trunc(season))).padStart(2, "0")}`;
}

export interface SeasonAcquireTarget {
  userId: string;
  title: string;
  mediaType: string;
  season: number;
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
  /** Test seam — inject the probe. */
  _probeFn?: typeof probeAndRecord;
  /** Test seam — inject the live-download guard. */
  _findLive?: (hash: string) => unknown;
  /** Test seam — override the foreground check. */
  _foregroundActive?: () => boolean;
}

export interface ResolveSeasonResult {
  plan: SeasonPlan;
  /** Every usable release considered, in ranker order (for the preview UI). */
  releases: TorrentResult[];
  /** Info-hashes freshly probed while resolving. */
  probed: string[];
  /**
   * The verdict lookup used to build the plan. Exposed so the executor can
   * re-run the pure planner during reconciliation (feeding it the pack's real
   * file list) without a second search or verdict load.
   */
  verdictOf: (r: TorrentResult) => SwarmVerdict;
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
    (
      await searchTorrents({
        query: seasonSearchQuery(target.title, target.season),
        category,
        limit: 40,
        enrich: false,
        skipCache: false,
        // A season download is an explicit user action, not background work,
        // so it draws on the interactive indexer budget.
        background: false,
        filters: { hasMagnet: true, minSeeders: 1, season: target.season },
      })
    ).results;

  const usable = releases.filter(
    (r) => r.magnet && (r.seeders ?? 0) > 0 && releaseInfoHash(r) !== null,
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

  const plan = planSeason({
    season: target.season,
    wanted: target.episodes,
    releases: usable,
    verdictOf,
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
   * True only when no chosen pack's coverage is a bare-name inference — i.e.
   * every episode we claim is either an explicit-range/reconciled pack or a
   * per-episode single. A prediction is not a guarantee: this is `false` when we
   * had to trust a pack's name because its file list never resolved.
   */
  coverageConfirmed: boolean;
}

export interface AcquireSeasonOptions extends ResolveSeasonOptions {
  /** Optional library item id for GrabJob externalId. */
  watchListItemId?: string | null;
  /** "stream" = reclaimable cache; "keep" = permanent download. */
  retention?: SendRetention;
  /** Test seam — override the send function. */
  _sendFn?: typeof import("@/lib/clients").sendToClient;
  /**
   * Test seam — read the real file paths of an added pack by info-hash.
   * Defaults to the live builtin torrent's file list, which is authoritative
   * and beats the release name every time.
   */
  _packFilesOf?: (hash: string) => string[] | null;
}

/**
 * Read the real file paths of a live pack torrent. The engine populates
 * `.files` once metadata resolves (the builtin send waits for it), so after a
 * successful pack add this reflects what the swarm actually holds — the one
 * field that outranks the release name. Returns null when the torrent is not
 * live or its metadata has not resolved yet, in which case the caller keeps the
 * honest name-inferred coverage rather than fabricating a confirmation.
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
  const { plan: initialPlan, releases, verdictOf } = await resolveSeasonPlan(target, opts);
  let plan = initialPlan;
  const packFilesOf = opts._packFilesOf ?? livePackFiles;

  const config = await getUserClientConfig(target.userId);
  if (!config) {
    return {
      plan,
      items: [],
      acquired: [],
      coverageLabel: plan.coverageLabel,
      coverageConfirmed: plan.coverageConfirmed,
    };
  }

  const category = searchCategoryForMediaType(target.mediaType) ?? "tv";
  const items: SeasonItemResult[] = [];
  const acquired = new Set<number>();

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
      purpose: sendRetentionToPurpose(opts.retention, opts.watchListItemId),
      downloadHistoryPrefix:
        kind === "pack"
          ? `Season ${target.season} pack`
          : `Season ${target.season} E${String(episode).padStart(2, "0")}`,
      fallbackTitle: release.title,
      selectCandidate: () => release,
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
        const space = await assertStorageBudget({
          root,
          maxStorageBytes: config.maxStorageBytes,
          incomingBytes: candidate.sizeBytes ?? null,
        });
        return space.ok ? { ok: true as const } : { ok: false as const, message: space.message };
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
        retention: opts.retention ?? "keep",
        watchListItemId: opts.watchListItemId,
      });
      for (const e of coversEpisodes) acquired.add(e);
      return true;
    }
    return false;
  };

  // ── Send the pack first, then reconcile ───────────────────────────────────
  // A pack's covers may be *inferred* from a bare `S01` name (no episode range),
  // which is a claim, not a fact — the same untrusted-string problem the swarm
  // probe exists to resist, one field over. Once the pack is added, its real
  // file list becomes knowable and beats the name every time: reconcile the
  // inferred coverage against the actual files, then let the pure planner
  // re-derive the gap singles so a short pack fills the gap instead of lying
  // about it. Only reconcile an inferred pack that actually sent and whose files
  // resolved; otherwise the honest name-inferred plan (coverageConfirmed:false)
  // stands.
  if (plan.pack) {
    const p: PackChoice = plan.pack;
    const packSent = await send(p.release, p.verdict, "pack", undefined, p.covers);
    if (packSent && p.coverageBasis === "inferred") {
      const hash = releaseInfoHash(p.release);
      const files = hash ? packFilesOf(hash) : null;
      if (hash && files && files.length > 0) {
        const verified = episodesFromFilenames(files, target.season);
        const reconciled = planSeason({
          season: target.season,
          wanted: target.episodes,
          releases,
          verdictOf,
          packContents: (r) => (releaseInfoHash(r) === hash ? verified : null),
        });
        plan = reconciled;
        // The pack really covers only its verified episodes; drop any phantom
        // episodes credited from the inferred covers so `acquired` stays honest.
        acquired.clear();
        for (const e of verified) if (target.episodes.includes(e)) acquired.add(e);
      }
    }
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
  };
}
