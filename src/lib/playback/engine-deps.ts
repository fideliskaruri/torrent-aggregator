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
import type { SwarmWatchDeps } from "./swarm-delivery-watchdog";
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

export function buildSwarmWatchDeps(config: ClientConnectionConfig): SwarmWatchDeps {
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
  };
}
