/**
 * On-demand single-episode grab.
 * - Rewatch / off-cursor episode: does NOT move the hunt cursor.
 * - Grab of the current hunt target (next SxxEyy): advances cursor like automation.
 */
import prisma from "@/lib/prisma";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { selectSeriesCandidateWithPackPreference } from "@/lib/torrents/pack-preference";
import {
  afterSuccessfulGrab,
  episodeSearchQuery,
  formatEpisodeLabel,
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
import type { TxClient } from "@/lib/grab/types";
import { applySendRetention, type SendRetention } from "@/lib/streaming/send-retention";

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
}): Promise<OnDemandResult> {
  const season = Math.max(1, Math.trunc(opts.season) || 1);
  const episode = Math.max(1, Math.trunc(opts.episode) || 1);
  const query = episodeSearchQuery(opts.showTitle, season, episode);
  // Unknown media type falls back to "tv": this path only runs for a library
  // row we are hunting episode-by-episode, which is a series by construction.
  const searchCategory = searchCategoryForMediaType(opts.mediaType) ?? "tv";

  const config = await getUserClientConfig(opts.userId);
  if (!config) {
    return {
      ok: false,
      query,
      message: "No client configured",
    };
  }

  let cursorAdvance: Awaited<
    ReturnType<typeof advanceLibraryItemIfHuntMatch>
  > = { advanced: false };

  const pipelineResult = await runGrabPipeline({
    userId: opts.userId,
    search: {
      query,
      category: searchCategory,
      limit: 15,
      enrich: false,
      skipCache: true,
      background: false,
      filters: {
        hasMagnet: true,
        minSeeders: 1,
        season,
        episode,
      },
    },
    config,
    fallbackTitle: opts.showTitle,
    grabJobKind: "ondemand",
    externalId: opts.watchListItemId ?? null,
    downloadHistoryPrefix: `On-demand ${formatEpisodeLabel(season, episode)}`,
    noMatchMessage: (count) =>
      count
        ? `On-demand: no matching ${formatEpisodeLabel(season, episode)} release in ${count} results`
        : `No seeded torrent for ${formatEpisodeLabel(season, episode)}`,

    // ── Candidate: prefer safe packs, then exact season/episode ────────
    selectCandidate(results) {
      return selectSeriesCandidateWithPackPreference(results, {
        season,
        episode,
      });
    },

    // ── No dedupe for on-demand (user explicitly asked) ──────────────

    // ── Storage budget ───────────────────────────────────────────────
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
      if (!space.ok) {
        return { ok: false as const, message: space.message };
      }
      return { ok: true as const };
    },

    // ── Path resolution ──────────────────────────────────────────────
    resolveTarget(cfg, candidate) {
      const t = resolveSmartSendTarget(cfg, {
        name: candidate.title,
        source: candidate.source,
        searchCategory,
        metadata: catalogMetadata({
          mediaType: opts.mediaType,
          title: opts.showTitle,
        }),
      });
      return { category: t.category, savePath: t.savePath };
    },

    // ── Post-send: advance hunt cursor if it matches ─────────────────
    async onSuccess(tx, candidate, _target, _sendMessage) {
      if (opts.watchListItemId) {
        cursorAdvance = await advanceLibraryItemIfHuntMatch(tx, {
          userId: opts.userId,
          watchListItemId: opts.watchListItemId,
          grabSeason: season,
          grabEpisode: episode,
          grabbedTitle: candidate.title,
        });
      }
    },

    // ── No-candidate: pipeline writes the GrabJob ────────────────────
    async onNoCandidate(_reason, _message, _candidate) {
      // Nothing extra — GrabJob already recorded by the pipeline.
    },
  });

  if (pipelineResult.status === "skipped") {
    return {
      ok: false,
      query,
      message: pipelineResult.message,
      title: pipelineResult.candidate?.title,
    };
  }

  if (pipelineResult.status === "already_active") {
    await applySendRetention({
      userId: opts.userId,
      config,
      infoHash: normalizeInfoHash(pipelineResult.candidate?.infoHash),
      retention: opts.retention ?? "keep",
      watchListItemId: opts.watchListItemId,
    });
    return {
      ok: true,
      query,
      message: pipelineResult.message,
      title: pipelineResult.candidate?.title,
      magnet: pipelineResult.candidate?.magnet,
      infoHash: normalizeInfoHash(pipelineResult.candidate?.infoHash),
    };
  }

  if (pipelineResult.status === "failed") {
    return {
      ok: false,
      message: pipelineResult.message,
      query,
      title: pipelineResult.candidate?.title,
      savePath: pipelineResult.target?.savePath,
      magnet: pipelineResult.candidate?.magnet,
    };
  }

  const label = formatEpisodeLabel(season, episode);
  await applySendRetention({
    userId: opts.userId,
    config,
    infoHash: normalizeInfoHash(pipelineResult.candidate?.infoHash),
    retention: opts.retention ?? "keep",
    watchListItemId: opts.watchListItemId,
  });
  const message = cursorAdvance.advanced
    ? `${pipelineResult.message} · advanced past ${label}`
    : pipelineResult.message;

  return {
    ok: true,
    message,
    query,
    title: pipelineResult.candidate?.title,
    savePath: pipelineResult.target?.savePath,
    magnet: pipelineResult.candidate?.magnet,
    infoHash: normalizeInfoHash(pipelineResult.candidate?.infoHash),
    advanced: cursorAdvance.advanced,
    lastEpisode: cursorAdvance.lastEpisode,
    cursorSeason: cursorAdvance.cursorSeason,
    cursorEpisode: cursorAdvance.cursorEpisode,
    nextEpisodeHint: cursorAdvance.nextEpisodeHint,
  };
}
