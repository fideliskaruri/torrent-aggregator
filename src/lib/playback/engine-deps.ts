/**
 * Real {@link SwarmWatchDeps} backed by the built-in engine and `SearchCache`.
 *
 * WHY THIS FILE EXISTS (do not inline it)
 * ---------------------------------------
 * This is the *single* place the swarm-delivery watchdog touches live engine
 * I/O — reading a torrent's transfer, looking up the cached ranked pool,
 * starting a release, pausing one. It has two consumers: the foreground poll in
 * `swarm-delivery-watchdog.ts` (the production trigger) and the manual override
 * route (`/api/playback/failover`). Both build their effects here, so there is
 * exactly one adapter to keep correct and exactly one thing to stub in tests —
 * `swarmDeliveryTick` and `pollForegroundSwarmWatch` take `SwarmWatchDeps`/
 * `buildDeps` as injected parameters, so the decision flow is exercised with
 * fakes and never needs a real WebTorrent swarm. That testability is the whole
 * justification: without this seam every test would need a live engine.
 *
 * Nothing here makes a decision — the rules live in `stall.ts` and
 * `failover.ts`. Keeping it separate from the API route also keeps the route a
 * thin HTTP shell and keeps this file free of `Request`/`Response`.
 */
import prisma from "@/lib/prisma";
import { builtinClient } from "@/lib/clients/builtin-engine";
import { listClientTorrents } from "@/lib/clients";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import { normalizeTitle } from "@/lib/utils";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";
import type { TransferSample } from "./stall";
import type { SwarmWatchDeps, ManualSwitchDeps } from "./swarm-delivery-watchdog";
import type { FailoverCandidate } from "./failover";

/**
 * The ranked candidate pool for a target, from what a prior search already
 * cached. Looked up by `normalizedQuery`, never by a rebuilt `cacheKey` — that
 * hash is opaque and reconstructing it misses 100% of the time (see
 * `prerank.ts` and `npm run test:seam`).
 */
export async function rankedResultsFromCache(
  target: PreRankTarget,
  db: typeof prisma = prisma,
): Promise<readonly TorrentResult[]> {
  const normalizedQuery = normalizeTitle(target.title);
  if (!normalizedQuery) return [];
  try {
    const row = await db.searchCache.findFirst({
      where: { normalizedQuery },
      orderBy: { expiresAt: "desc" },
    });
    if (!row) return [];
    const payload = JSON.parse(row.payload) as SearchResponse;
    return Array.isArray(payload.results) ? payload.results : [];
  } catch {
    return [];
  }
}

/**
 * A live transfer sample for a source, or null if the engine no longer has it.
 *
 * `downloadedBytes` is derived from `progress × sizeBytes` — the absolute figure
 * the stall rule compares across samples, not the point-in-time `dlspeed` which
 * the piece-race guard can leave stale.
 */
function toSample(config: ClientConnectionConfig, infoHash: string) {
  return async (): Promise<TransferSample | null> => {
    let torrents;
    try {
      torrents = await listClientTorrents(config);
    } catch {
      return null;
    }
    const hash = infoHash.toLowerCase();
    const t = torrents.find((x) => x.hash?.toLowerCase() === hash);
    if (!t) return null;
    const size = t.sizeBytes ?? 0;
    return {
      atMs: Date.now(),
      downloadedBytes: Math.max(0, Math.round((t.progress ?? 0) * size)),
      progress: t.progress ?? 0,
      state: t.state,
    };
  };
}

export function buildSwarmWatchDeps(
  config: ClientConnectionConfig,
  userId?: string,
): SwarmWatchDeps {
  return {
    async sample(infoHash) {
      return toSample(config, infoHash)();
    },
    async rankedResults(target) {
      return rankedResultsFromCache(target);
    },
    async startRelease(candidate: FailoverCandidate) {
      const magnet = candidate.release.magnet;
      if (!magnet) return false;
      try {
        const result = await builtinClient.addTorrent(config, {
          magnet,
          name: candidate.release.title,
        });
        return result.ok;
      } catch {
        return false;
      }
    },
    async abandon(infoHash) {
      // Pause, never delete: keep the partial bytes on disk. Abandoning to try
      // another release is reversible routing, not a data-loss decision.
      try {
        await builtinClient.pauseTorrent(config, infoHash);
      } catch {
        /* best-effort — a stalled source that will not pause is harmless */
      }
    },
    // Position carry needs the viewer's id. The foreground poll has it (the
    // engine row) and passes it so an automatic recovery resumes mid-file; the
    // diagnostics route has no user context and omits it, which is fine — carry
    // is best-effort and a switch still happens without it.
    ...(userId
      ? {
          async carryPosition(fromInfoHash: string, toInfoHash: string) {
            return carryPlaybackPosition(userId, fromInfoHash, toInfoHash);
          },
        }
      : {}),
  };
}

/**
 * Move a viewer's playback position from one source to another.
 *
 * The new release's file path is unknown until it has metadata, so the carried
 * row is keyed on the *source* file path as a seed; the client corrects it on
 * its first real progress write against the new stream. The authoritative value
 * for the immediate resume is the returned `positionSec`, which the switch hands
 * back to the player. Returns null when the old source had no saved position.
 */
export async function carryPlaybackPosition(
  userId: string,
  fromInfoHash: string,
  toInfoHash: string,
  db: typeof prisma = prisma,
): Promise<number | null> {
  const from = fromInfoHash.toLowerCase();
  const to = toInfoHash.toLowerCase();
  const src = await db.playbackProgress.findFirst({
    where: { userId, infoHash: from },
    orderBy: { updatedAt: "desc" },
  });
  if (!src) return null;

  await db.playbackProgress.upsert({
    where: { userId_infoHash_filePath: { userId, infoHash: to, filePath: src.filePath } },
    create: {
      userId,
      infoHash: to,
      filePath: src.filePath,
      positionSec: src.positionSec,
      durationSec: src.durationSec,
      title: src.title,
      season: src.season,
      episode: src.episode,
      posterUrl: src.posterUrl,
      watchListItemId: src.watchListItemId,
    },
    update: { positionSec: src.positionSec, durationSec: src.durationSec },
  });
  return src.positionSec;
}

/**
 * The latest saved playback position for a source, or null if none. Used by the
 * status read so a client re-pointing after an automatic switch knows where to
 * resume — the same value {@link carryPlaybackPosition} wrote onto the new
 * source before the old one was abandoned.
 */
export async function latestPlaybackPositionSec(
  userId: string,
  infoHash: string,
  db: typeof prisma = prisma,
): Promise<number | null> {
  const row = await db.playbackProgress.findFirst({
    where: { userId, infoHash: infoHash.toLowerCase() },
    orderBy: { updatedAt: "desc" },
    select: { positionSec: true },
  });
  return row?.positionSec ?? null;
}

/**
 * Engine-backed effects for a manual switch. Reuses the exact `startRelease`/
 * `abandon` path {@link buildSwarmWatchDeps} uses — a manual switch is the same
 * swap chosen by a human instead of the ranker — and adds position carry.
 */
export function buildManualSwitchDeps(
  config: ClientConnectionConfig,
  userId: string,
): ManualSwitchDeps {
  const base = buildSwarmWatchDeps(config);
  return {
    rankedResults: base.rankedResults,
    startRelease: base.startRelease,
    abandon: base.abandon,
    async carryPosition(fromInfoHash, toInfoHash) {
      return carryPlaybackPosition(userId, fromInfoHash, toInfoHash);
    },
  };
}