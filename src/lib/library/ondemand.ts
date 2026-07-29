/**
 * On-demand single-episode grab.
 * - Rewatch / off-cursor episode: does NOT move the hunt cursor.
 * - Grab of the current hunt target (next SxxEyy): advances cursor like automation.
 */
import prisma from "@/lib/prisma";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { selectSeriesCandidateWithPackPreference } from "@/lib/torrents/pack-preference";
import { parseEpisode } from "@/lib/torrents/episodes";
import { searchTorrents } from "@/lib/torrents/aggregator";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import type { ClientConnectionConfig } from "@/lib/clients";
import {
  afterSuccessfulGrab,
  episodeSearchQuery,
  formatEpisodeLabel,
  padEp,
  resolveHuntCursor,
} from "@/lib/library/cursor";
import { assertStorageBudget } from "@/lib/library/disk-space";
import {
  getUserClientConfig,
} from "@/lib/clients";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
import { searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { runGrabPipeline } from "@/lib/grab/pipeline";
import type {
  GrabPipelineResult,
  PipelineSearchOptions,
  TxClient,
} from "@/lib/grab/types";
import { applySendRetention, sendRetentionToPurpose, type SendRetention } from "@/lib/streaming/send-retention";

export type OnDemandResult = {
  ok: boolean;
  message: string;
  query: string;
  title?: string;
  savePath?: string | null;
  magnet?: string | null;
  /**
   * The release that was sent, addressable.
   *
   * The pipeline has always known this — it dedupes on it — and threw it away
   * at the boundary. Returning it is what lets a caller open the player on a
   * torrent that started downloading a second ago instead of telling the user
   * to come back later.
   */
  infoHash?: string | null;
  /** True when grab matched hunt cursor and cursor was advanced */
  advanced?: boolean;
  lastEpisode?: string;
  cursorSeason?: number;
  cursorEpisode?: number;
  nextEpisodeHint?: string;
  /**
   * Present ONLY when the fallback ladder was exhausted without a successful
   * send. Lets a UI render an honest, actionable failure (e.g. a "Search
   * manually" button pre-filled with `manualSearchQuery`) instead of flat grey
   * text. `reason` is a coarse machine hint; `message` is the authoritative
   * human sentence.
   *
   * NOTE: this structured field is exposed on the `/api/library/ondemand`
   * route (which spreads the whole result). The title-page caller
   * (`api/title/[workKey]/grab.ts`) currently maps only `{ ok, message, ... }`
   * into its component-owned `TitleGrabResponse`, so the title page sees only
   * `message` until that (component-owned) type is extended to carry this.
   */
  noReleaseFound?: {
    reason: "no_release" | "client_offline" | "send_failed";
    /** Distinct indexer searches actually run this press. */
    searches: number;
    /** Whether a season-pack rung was reached (message honesty). */
    triedSeasonPacks: boolean;
    /** Canonical query to prefill a manual search box, e.g. "Family Guy S01E02". */
    manualSearchQuery: string;
  };
};

/**
 * After a successful send: if the grabbed SxxEyy is the library item's hunt
 * cursor, advance last/next/cursor (same as automation). Off-cursor rewatch
 * leaves the cursor alone.
 *
 * Accepts a db client — either `tx` (inside a transaction) or the top-level
 * prisma client. This lets the cursor advance commit atomically with the
 * GrabJob + DownloadHistory writes when called from the pipeline hook.
 *
 * Exported despite having no other *runtime* caller: it is the seam
 * `scripts/test-ondemand-advance.ts` drives directly, because cursor advance
 * is the one step whose off-by-one is invisible from the outside — a rewatch
 * that quietly moves the cursor and a match that quietly doesn't both look
 * like a successful grab. Do not un-export it.
 */
export async function advanceLibraryItemIfHuntMatch(
  db: TxClient | typeof prisma,
  opts: {
  userId: string;
  watchListItemId: string;
  grabSeason: number;
  grabEpisode: number;
  grabbedTitle: string;
}): Promise<{
  advanced: boolean;
  lastEpisode?: string;
  cursorSeason?: number;
  cursorEpisode?: number;
  nextEpisodeHint?: string;
}> {
  const item = await db.watchListItem.findFirst({
    where: { id: opts.watchListItemId, userId: opts.userId },
  });
  if (!item) {
    return { advanced: false };
  }

  const hunt = resolveHuntCursor({
    title: item.title,
    mediaType: item.mediaType,
    cursorSeason: item.cursorSeason,
    cursorEpisode: item.cursorEpisode,
    fromSeason: item.fromSeason,
    fromEpisode: item.fromEpisode,
    lastEpisode: item.lastEpisode,
    nextEpisodeHint: item.nextEpisodeHint,
  });

  if (
    !hunt.cursor ||
    hunt.cursor.season !== opts.grabSeason ||
    hunt.cursor.episode !== opts.grabEpisode
  ) {
    return { advanced: false };
  }

  const advanced = afterSuccessfulGrab(
    item.title,
    hunt.cursor,
    opts.grabbedTitle,
  );

  await db.watchListItem.update({
    where: { id: item.id },
    data: {
      lastChecked: new Date(),
      latestReleaseTitle: opts.grabbedTitle,
      latestReleaseAt: new Date(),
      lastEpisode: advanced.lastEpisode,
      cursorSeason: advanced.cursorSeason,
      cursorEpisode: advanced.cursorEpisode,
      nextEpisodeHint: advanced.nextEpisodeHint,
      // A grab is a grab, whoever asked for it. Automation resets both of
      // these when it advances the cursor, and an on-demand grab that moved
      // the same cursor must do the same or it quietly disables automation:
      //   - `cursorMisses` left non-zero keeps the item in hunt backoff for
      //     hours even though we just proved releases are findable.
      //   - `seederWaitSince` left set points at the *previous* episode's wait,
      //     so the 6h thin-swarm escape hatch can fire immediately on the new
      //     episode and grab a 0-seeder release that should have been deferred.
      cursorMisses: 0,
      seederWaitSince: null,
      ...(item.fromSeason == null
        ? {
            fromSeason: hunt.cursor.season,
            fromEpisode: hunt.cursor.episode,
          }
        : {}),
    },
  });

  return {
    advanced: true,
    lastEpisode: advanced.lastEpisode,
    cursorSeason: advanced.cursorSeason,
    cursorEpisode: advanced.cursorEpisode,
    nextEpisodeHint: advanced.nextEpisodeHint,
  };
}

// ── On-demand fallback ladder ───────────────────────────────────────────────
// A single episode-shaped search ("Show SxxEyy") is only ONE of the ways an
// indexer names a release, and it structurally hides season packs: EZTV drops
// every pack when the query names an episode (torrents/eztv.ts), and free-text
// indexers never substring-match a pack title against "SxxEyy". So a perfectly
// seedable pack that CONTAINS the episode is invisible to rung 1. The ladder
// relaxes the search one rung at a time and STOPS at the first working send.

/** Distinct indexer searches allowed per press (at most one per rung). */
const MAX_LADDER_SEARCHES = 4;
/** Total pipeline send attempts allowed per press (across all rungs). */
const MAX_SEND_ATTEMPTS = 4;
/** Next-best-candidate retries within a single rung before moving on. */
const MAX_CANDIDATES_PER_RUNG = 2;

type RungKind = "exact" | "alt" | "pack" | "relaxed";

type EpisodeRung = {
  kind: RungKind;
  query: string;
  filters: PipelineSearchOptions["filters"];
  /** Ordered pick, skipping any candidate key already attempted this press. */
  select: (
    results: TorrentResult[],
    attempted: Set<string>,
  ) => TorrentResult | null;
};

/** Stable identity for cross-rung dedupe: infohash, else magnet, else id. */
function candidateKey(r: TorrentResult): string {
  return normalizeInfoHash(r.infoHash) ?? r.magnet ?? r.id;
}

/** "Show 1x02" — the other common single-episode naming indexers use. */
function altEpisodeQuery(title: string, season: number, episode: number): string {
  return `${title.trim()} ${season}x${padEp(episode)}`;
}

/**
 * "Show S01" — a season-shaped query. This is the ONLY shape that surfaces
 * season packs: an episode-shaped query makes EZTV drop packs and makes
 * free-text indexers miss them. Mirrors season-acquire's seasonSearchQuery.
 */
function seasonPackQuery(title: string, season: number): string {
  return `${title.trim()} S${padEp(season)}`;
}

/**
 * Last-resort selector: accept the EXACT episode even with zero seeders (a
 * stalled magnet the engine may still resolve from the DHT), healthiest first.
 * Never returns a pack or a wrong episode. Kept local so the shared
 * pack-preference selector's `seeders > 0` floor stays intact for everyone else.
 */
function selectRelaxedEpisode(
  results: TorrentResult[],
  target: { season: number; episode: number },
): TorrentResult | null {
  const exact = results
    .filter((r) => Boolean(r.magnet))
    .filter((r) => {
      const ep = parseEpisode(r.title);
      return ep.season === target.season && ep.episode === target.episode;
    })
    .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
  return exact[0] ?? null;
}

/** A SearchResponse carrying exactly the pinned candidate for the pipeline. */
function pinnedResponse(
  results: TorrentResult[],
  query: string,
): SearchResponse {
  return {
    query,
    results,
    groups: [],
    tookMs: 0,
    sources: [],
    totalCount: results.length,
    page: 1,
    pageSize: Math.max(1, results.length),
    totalPages: results.length ? 1 : 0,
  };
}

/**
 * The rungs, in relaxation order. Rungs 1-2 vary the single-episode NAME; rung
 * 3 switches to a season query so packs can finally appear (the high-value rung
 * that rescues the Family Guy S01E02 case); rung 4 drops the seeder floor.
 *
 * A `102`-style scene-number rung was deliberately NOT added: parseEpisode
 * cannot turn a bare "102" back into S01E02, so those results would never pass
 * the season/episode filter or be selectable — it would be a wasted search.
 */
function buildEpisodeRungs(
  title: string,
  season: number,
  episode: number,
): EpisodeRung[] {
  const target = { season, episode };
  const packPreferred = (results: TorrentResult[], attempted: Set<string>) =>
    selectSeriesCandidateWithPackPreference(
      results.filter((r) => !attempted.has(candidateKey(r))),
      target,
    );
  return [
    {
      kind: "exact",
      query: episodeSearchQuery(title, season, episode),
      filters: { hasMagnet: true, minSeeders: 1, season, episode },
      select: packPreferred,
    },
    {
      kind: "alt",
      query: altEpisodeQuery(title, season, episode),
      filters: { hasMagnet: true, minSeeders: 1, season, episode },
      select: packPreferred,
    },
    {
      kind: "pack",
      // No episode filter: a pack carries no episode number, but the season
      // filter keeps a "Show S01" query from grabbing the wrong season.
      query: seasonPackQuery(title, season),
      filters: { hasMagnet: true, minSeeders: 1, season },
      select: packPreferred,
    },
    {
      kind: "relaxed",
      query: episodeSearchQuery(title, season, episode),
      filters: { hasMagnet: true, minSeeders: 0, season, episode },
      select: (results, attempted) =>
        selectRelaxedEpisode(
          results.filter((r) => !attempted.has(candidateKey(r))),
          target,
        ),
    },
  ];
}

export async function grabSingleEpisode(opts: {
  userId: string;
  showTitle: string;
  mediaType: string;
  season: number;
  episode: number;
  /** Optional library item id for GrabJob externalId + hunt-cursor advance */
  watchListItemId?: string | null;
  /** "stream" = reclaimable cache; "keep" = permanent download. */
  retention?: SendRetention;
  /** Test seam — bypass getUserClientConfig with a pinned client config. */
  _config?: ClientConnectionConfig;
  /** Test seam — override the per-rung aggregator search. */
  _searchFn?: typeof searchTorrents;
  /** Test seam — override the client send (forwarded to the pipeline). */
  _sendFn?: typeof import("@/lib/clients").sendToClient;
  /** Test seam — override Prisma (forwarded to the pipeline + synth skip row). */
  _prisma?: typeof prisma;
}): Promise<OnDemandResult> {
  const season = Math.max(1, Math.trunc(opts.season) || 1);
  const episode = Math.max(1, Math.trunc(opts.episode) || 1);
  const query = episodeSearchQuery(opts.showTitle, season, episode);
  // Unknown media type falls back to "tv": this path only runs for a library
  // row we are hunting episode-by-episode, which is a series by construction.
  const searchCategory = searchCategoryForMediaType(opts.mediaType) ?? "tv";

  const config = opts._config ?? (await getUserClientConfig(opts.userId));
  if (!config) {
    return {
      ok: false,
      query,
      message: "No client configured",
    };
  }

  const label = formatEpisodeLabel(season, episode);
  const searchFn = opts._searchFn ?? searchTorrents;
  const db = opts._prisma ?? prisma;
  const rungs = buildEpisodeRungs(opts.showTitle, season, episode);

  let cursorAdvance: Awaited<
    ReturnType<typeof advanceLibraryItemIfHuntMatch>
  > = { advanced: false };

  // Memoize by (query + filters) so two rungs that resolve to the same search
  // never double-hit the indexers, and so `searchMemo.size` is an honest count
  // of DISTINCT searches for both the exhausted message and the search cap.
  const searchMemo = new Map<string, Promise<SearchResponse>>();
  const attempted = new Set<string>();
  let sendAttempts = 0;
  let triedPacks = false;
  let lastFailure: GrabPipelineResult | null = null;
  let winner: { result: GrabPipelineResult; rung: EpisodeRung } | null = null;

  const runRungSearch = (rung: EpisodeRung): Promise<SearchResponse> | null => {
    const key = `${rung.query}|${JSON.stringify(rung.filters)}`;
    const existing = searchMemo.get(key);
    if (existing) return existing;
    if (searchMemo.size >= MAX_LADDER_SEARCHES) return null;
    const p = searchFn({
      query: rung.query,
      category: searchCategory,
      limit: 15,
      enrich: false,
      skipCache: true,
      background: false,
      filters: rung.filters,
    });
    searchMemo.set(key, p);
    return p;
  };

  ladder: for (const rung of rungs) {
    if (sendAttempts >= MAX_SEND_ATTEMPTS) break;
    const searchPromise = runRungSearch(rung);
    if (!searchPromise) break; // search cap reached
    if (rung.kind === "pack") triedPacks = true;
    const searchResp = await searchPromise;

    let perRung = 0;
    while (perRung < MAX_CANDIDATES_PER_RUNG && sendAttempts < MAX_SEND_ATTEMPTS) {
      const candidate = rung.select(searchResp.results, attempted);
      if (!candidate?.magnet) break; // nothing (more) to try this rung
      attempted.add(candidateKey(candidate));
      perRung += 1;
      sendAttempts += 1;

      // Pin the chosen candidate into the pipeline: with `_searchFn` returning
      // exactly this release, the pipeline never re-searches (so it can't hit
      // its own no-candidate skip branch and write a stray Activity row) and
      // sends only this one torrent. The RECORDED query stays canonical so
      // Activity shows what the user asked for, not the relaxed rung shape.
      const res = await runGrabPipeline({
        userId: opts.userId,
        search: {
          query,
          category: searchCategory,
          limit: 1,
          enrich: false,
          skipCache: true,
          background: false,
          filters: rung.filters,
        },
        config,
        fallbackTitle: opts.showTitle,
        grabJobKind: "ondemand",
        externalId: opts.watchListItemId ?? null,
        purpose: sendRetentionToPurpose(opts.retention, opts.watchListItemId),
        downloadHistoryPrefix: `On-demand ${label}`,
        selectCandidate: () => candidate,
        async checkStorageBudget(cand, target) {
          const root =
            config.baseDownloadPath?.trim() ||
            target.savePath ||
            config.savePath?.trim() ||
            process.cwd();
          const space = await assertStorageBudget({
            root,
            maxStorageBytes: config.maxStorageBytes,
            incomingBytes: cand.sizeBytes ?? null,
          });
          return space.ok
            ? { ok: true as const }
            : { ok: false as const, message: space.message };
        },
        resolveTarget(cfg, cand) {
          const t = resolveSmartSendTarget(cfg, {
            name: cand.title,
            source: cand.source,
            searchCategory,
            metadata: catalogMetadata({
              mediaType: opts.mediaType,
              title: opts.showTitle,
            }),
          });
          return { category: t.category, savePath: t.savePath };
        },
        async onSuccess(tx, cand) {
          if (opts.watchListItemId) {
            cursorAdvance = await advanceLibraryItemIfHuntMatch(tx, {
              userId: opts.userId,
              watchListItemId: opts.watchListItemId,
              grabSeason: season,
              grabEpisode: episode,
              grabbedTitle: cand.title,
            });
          }
        },
        _searchFn: (async () =>
          pinnedResponse([candidate], query)) as typeof searchTorrents,
        _sendFn: opts._sendFn,
        _prisma: opts._prisma,
      });

      if (res.status === "sent" || res.status === "already_active") {
        winner = { result: res, rung };
        break ladder;
      }
      lastFailure = res;
      // Offline is environmental, not a search problem — more rungs won't help.
      if (res.offline) break ladder;
      // Otherwise (dedupe / viability / storage / send) fall through to this
      // rung's next-best candidate, then to the next rung. THIS is the
      // single-candidate gap fix: one bad pick no longer ends the attempt.
    }
  }

  const searches = searchMemo.size;

  // ── Success ──────────────────────────────────────────────────────────────
  if (winner) {
    const res = winner.result;
    await applySendRetention({
      userId: opts.userId,
      config,
      infoHash: normalizeInfoHash(res.candidate?.infoHash),
      retention: opts.retention ?? "keep",
      watchListItemId: opts.watchListItemId,
    });
    if (res.status === "already_active") {
      return {
        ok: true,
        query,
        message: res.message,
        title: res.candidate?.title,
        magnet: res.candidate?.magnet,
        infoHash: normalizeInfoHash(res.candidate?.infoHash),
      };
    }
    // Honestly label the provenance when we had to relax to win.
    const notes: string[] = [];
    if (cursorAdvance.advanced) notes.push(`advanced past ${label}`);
    if (winner.rung.kind === "pack") notes.push("from season pack");
    if (winner.rung.kind === "relaxed") notes.push("low-seed release");
    const message = notes.length
      ? `${res.message} · ${notes.join(" · ")}`
      : res.message;
    return {
      ok: true,
      message,
      query,
      title: res.candidate?.title,
      savePath: res.target?.savePath,
      magnet: res.candidate?.magnet,
      infoHash: normalizeInfoHash(res.candidate?.infoHash),
      advanced: cursorAdvance.advanced,
      lastEpisode: cursorAdvance.lastEpisode,
      cursorSeason: cursorAdvance.cursorSeason,
      cursorEpisode: cursorAdvance.cursorEpisode,
      nextEpisodeHint: cursorAdvance.nextEpisodeHint,
    };
  }

  // ── Exhausted: a candidate WAS attempted but every send failed ────────────
  // The pipeline already wrote a GrabJob for each real attempt, so we add NO
  // synthetic row here — we just surface the last failure's message plus a
  // coarse machine-readable reason for the UI.
  if (sendAttempts > 0 && lastFailure) {
    const reason: "client_offline" | "send_failed" = lastFailure.offline
      ? "client_offline"
      : "send_failed";
    return {
      ok: false,
      query,
      message: lastFailure.message,
      title: lastFailure.candidate?.title,
      savePath: lastFailure.target?.savePath,
      magnet: lastFailure.candidate?.magnet,
      noReleaseFound: {
        reason,
        searches,
        triedSeasonPacks: triedPacks,
        manualSearchQuery: query,
      },
    };
  }

  // ── Exhausted: NOTHING was ever selectable (the reported-bug path) ────────
  // No pipeline call happened, so nothing is in Activity yet. Write EXACTLY ONE
  // honest skip row — not one per rung — and tell the user what they can do.
  const message = `Couldn't find a working release for ${label} — tried ${searches} search${
    searches === 1 ? "" : "es"
  }${triedPacks ? " including season packs" : ""}. Search manually?`;
  await db.grabJob.create({
    data: {
      userId: opts.userId,
      title: opts.showTitle,
      query,
      status: "skipped",
      message,
      kind: "ondemand",
      externalId: opts.watchListItemId ?? null,
    },
  });
  return {
    ok: false,
    query,
    message,
    noReleaseFound: {
      reason: "no_release",
      searches,
      triedSeasonPacks: triedPacks,
      manualSearchQuery: query,
    },
  };
}
