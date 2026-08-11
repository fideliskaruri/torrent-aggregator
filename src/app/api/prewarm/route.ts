/**
 * Pre-warm control + diagnostics.
 *
 * Everything here is speculative work the user did not ask for, so the route
 * is deliberately dull: it reports what is speculative right now, and it lets
 * the background work be kicked manually (which is what the tests and a human
 * debugging a cold cache both need).
 *
 * It never returns an error that a UI would be tempted to show as a failure of
 * something the user asked for. A pre-warm that could not run is reported as a
 * skip with a reason, with HTTP 200, because nothing the user did went wrong.
 */
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getUserClientConfig } from "@/lib/clients";
import { evictPrewarmsForBytes, listEvictablePrewarms } from "@/lib/prewarm/eviction";
import { preRankUpcoming, upcomingTargets } from "@/lib/prewarm/prerank";
import { preProbeUpcoming } from "@/lib/prewarm/preprobe";
import {
  foregroundSnapshot,
  foregroundActive,
  markForegroundActive,
  releaseForeground,
  syncPrewarmSuspension,
} from "@/lib/prewarm/foreground";
import {
  onPlaybackProgress,
  prewarmNextEpisode,
  resolveNextEpisode,
} from "@/lib/prewarm/prewarm";
import { PREWARM_ORIGIN } from "@/lib/prewarm/types";
import type { NextEpisode } from "@/lib/prewarm/types";
import { formatEpisodeLabel } from "@/lib/library/cursor";
import { parseEpisode } from "@/lib/torrents/episodes";
import { episodeFileInTorrent } from "@/lib/prewarm/next-episode-file";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { workIdentity } from "@/lib/torrents/work-identity";
import { normalizeTitle } from "@/lib/utils";
import { getPreRanked, releaseInfoHash } from "@/lib/prewarm/prerank";
import { tryAcquirePreProbeLease } from "@/lib/prewarm/preprobe-lock";
import {
  guardBrowserMutation,
  requestFailureResponse,
} from "@/lib/http/request";
import {
  CORRELATION_HEADER,
  jsonResponse,
  observeRequest,
} from "@/lib/observability/logging";

export const dynamic = "force-dynamic";

/**
 * What is currently speculative, and what could be reclaimed.
 *
 * Read-only. Resolves nothing and searches nothing — a status page must not
 * become a reason to hit an indexer.
 */
export async function GET(request: Request) {
  const observer = observeRequest(request, "prewarm", "prewarm-status");
  const reply = (body: unknown, init?: ResponseInit) =>
    jsonResponse(observer, body, init);
  const session = await auth();
  if (!session?.user?.id) {
    return reply({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  try {
    const [prewarms, evictable, targets] = await Promise.all([
      prisma.engineTorrent.findMany({
        where: { userId, origin: PREWARM_ORIGIN },
        orderBy: { lastUsedAt: "asc" },
        take: 50,
      }),
      listEvictablePrewarms(userId),
      upcomingTargets(userId),
    ]);

    return reply({
      prewarms: prewarms.map((t) => ({
        hash: t.hash,
        name: t.name,
        status: t.status,
        progress: t.progress,
        sizeBytes: Number(t.sizeBytes),
        lastUsedAt: t.lastUsedAt.toISOString(),
      })),
      evictableCount: evictable.candidates.length,
      protectedFromEviction: evictable.skipped,
      upcoming: targets,
      foreground: foregroundSnapshot(),
    });
  } catch (err) {
    const safeError = observer.failure("PREWARM_FAILED", err);
    return reply(
      {
        error: "Failed to load pre-warm status",
        message: safeError.message,
        prewarms: [],
        evictableCount: 0,
        upcoming: [],
      },
      { status: 500 },
    );
  }
}

type PrewarmRequest =
  | { action: "prerank"; limit?: number }
  | { action: "evict"; bytes: number }
  | {
      action: "foreground";
      infoHash?: string;
      beacon?: boolean;
      /**
       * The player for this stream closed. Expire its foreground clock now so
       * its cache stops pulling pieces without waiting out the idle grace.
       * `true` releases whatever was last in the foreground.
       */
      released?: string | boolean;
    }
  | {
      action: "next";
      infoHash: string;
      title: string;
      season?: number | null;
      episode?: number | null;
      watchListItemId?: string | null;
    }
  | {
      action: "trigger";
      next: NextEpisode;
      protectHashes?: string[];
      force?: boolean;
    }
  | {
      action: "progress";
      infoHash: string;
      title: string;
      positionSec: number;
      durationSec: number;
      season?: number | null;
      episode?: number | null;
      watchListItemId?: string | null;
    };

export async function POST(request: NextRequest) {
  const observer = observeRequest(request, "prewarm", "prewarm-action");
  const reply = (body: unknown, init?: ResponseInit) =>
    jsonResponse(observer, body, init);
  const session = await auth();
  if (!session?.user?.id) {
    return reply({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const origin = guardBrowserMutation(request);
  if (!origin.ok) {
    const response = requestFailureResponse(origin);
    response.headers.set(CORRELATION_HEADER, observer.correlationId);
    return response;
  }
  let body: PrewarmRequest;
  try {
    body = (await request.json()) as PrewarmRequest;
  } catch {
    return reply({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    if (body.action === "prerank") {
      const releaseLease = tryAcquirePreProbeLease(userId);
      if (!releaseLease) {
        observer.degraded("PREWARM_SKIPPED", { status: "busy" });
        return reply({
          ok: true,
          preProbe: "busy",
          preRanked: [],
          message: "A bounded pre-rank/probe pass is already running.",
        });
      }
      let leaseHandedToProbe = false;
      try {
        const choices = await preRankUpcoming(userId, { limit: body.limit });

        // Speculatively measure the top candidates' swarms so the verdict is
        // already stored by the time the user presses play. Fire-and-forget:
        // this is background work, it must not add latency to the pre-rank
        // response, and it yields to any foreground stream on its own (see
        // `preProbeUpcoming`). An unreachable swarm is a normal `unknown`, not a
        // route failure — but whether the pass was even DISPATCHED is surfaced in
        // the response instead of hidden behind an unconditional 200 (I36).
        let preProbe: "scheduled" | "unavailable" = "unavailable";
        if (!foregroundActive()) {
          try {
            const pass = preProbeUpcoming(userId);
            preProbe = "scheduled";
            leaseHandedToProbe = true;
            observer.success("PREWARM_DISPATCHED", { status: "scheduled" });
            void pass
              .catch((err) => {
                observer.failure("PREWARM_FAILED", err, {
                  status: "background",
                });
              })
              .finally(releaseLease);
          } catch (err) {
            // A synchronous throw would otherwise escape before .catch attached.
            observer.failure("PREWARM_FAILED", err, { status: "dispatch" });
          }
        } else {
          observer.degraded("PREWARM_SKIPPED", { status: "foreground" });
        }

        return reply({
          ok: true,
          /**
           * Whether the background swarm pre-probe pass was dispatched for this
           * pre-rank ("scheduled") or could not start ("unavailable"). It runs
           * asynchronously, so "scheduled" means in-flight, not complete (I36).
           */
          preProbe,
          // `candidate: null` means "we looked and found nothing usable".
          // A target missing from this list means we never got an answer at all.
          // Those are different, and the response keeps them different.
          preRanked: choices.map((c) => ({
            query: c.query,
            season: c.season,
            episode: c.episode,
            resultCount: c.resultCount,
            source: c.source,
            candidate: c.candidate
              ? {
                  title: c.candidate.title,
                  seeders: c.candidate.seeders,
                  sizeBytes: c.candidate.sizeBytes,
                  source: c.candidate.source,
                }
              : null,
          })),
        });
      } finally {
        if (!leaseHandedToProbe) releaseLease();
      }
    }

    if (body.action === "evict") {
      const config = await getUserClientConfig(userId);
      if (!config) {
        return reply({ ok: false, reason: "no-client", evicted: [] });
      }
      const bytes = Number(body.bytes);
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return reply({ error: "bytes must be positive" }, { status: 400 });
      }
      const result = await evictPrewarmsForBytes({
        userId,
        neededBytes: bytes,
        config,
      });
      return reply({
        ok: true,
        satisfied: result.satisfied,
        freedBytes: result.freedBytes,
        evicted: result.evicted.map((c) => ({ hash: c.hash, name: c.name })),
        skipped: result.skipped,
      });
    }

    if (body.action === "foreground") {
      // `beacon` records a live stream; omitting it just reconciles against
      // whatever the engine is actually doing. `released` is the player closing:
      // expire the foreground clock for that stream now so its cache stops
      // pulling pieces immediately instead of after the idle grace.
      if (body.released) {
        releaseForeground(
          typeof body.released === "string"
            ? body.released
            : body.infoHash ?? null,
        );
      } else if (body.beacon !== false) {
        markForegroundActive(body.infoHash ?? null);
      }
      const result = await syncPrewarmSuspension({ userId });
      return reply({
        ok: true,
        foreground: result.foreground,
        suspended: result.suspended,
        resumed: result.resumed,
        parked: result.parked,
        snapshot: foregroundSnapshot(),
      });
    }

    if (body.action === "next") {
      const infoHash = normalizeInfoHash(body.infoHash);
      if (!infoHash || typeof body.title !== "string") {
        return reply(
          { error: "infoHash and title are required" },
          { status: 400 },
        );
      }
      const next = await resolveNextEpisode({
        userId,
        infoHash,
        title: body.title,
        season: body.season ?? null,
        episode: body.episode ?? null,
        watchListItemId: body.watchListItemId ?? null,
      });
      if (!next) {
        return reply({ ok: true, next: null });
      }

      // The fastest possible answer first: the episode the viewer is about to
      // watch is very often ANOTHER FILE IN THE TORRENT ALREADY PLAYING (a
      // season pack). Scanning torrent *names* can never see that — every name
      // in the row is the pack's name — so it fell through to "not-fetched" and
      // the viewer paid for an indexer search and a second acquisition of bytes
      // already on their disk. Read the playing torrent's own verified files
      // instead; a hit ends the resolution here, with the same infoHash and the
      // exact file to play.
      const current = await prisma.engineTorrent.findFirst({
        where: { userId, hash: infoHash, status: { not: "removed" } },
        select: { hash: true, progress: true, savePath: true, verifiedFilesJson: true },
        orderBy: { updatedAt: "desc" },
      });
      const inPackPath = current
        ? episodeFileInTorrent(current, next.season, next.episode)
        : null;
      if (current && inPackPath) {
        const packProgress = Math.max(0, Math.min(1, current.progress));
        return reply({
          ok: true,
          next: {
            title: next.title,
            label: formatEpisodeLabel(next.season, next.episode),
            season: next.season,
            episode: next.episode,
            // The file is in the verified list, so its bytes are on disk even
            // when the rest of the pack is still landing.
            availability: "ready",
            infoHash: current.hash,
            filePath: inPackPath,
            progress: packProgress,
            source: next.source,
          },
        });
      }

      const targetName = normalizeTitle(next.title);
      const heldRows = await prisma.engineTorrent.findMany({
        where: { userId, status: { not: "removed" } },
        orderBy: { updatedAt: "desc" },
        take: 100,
      });
      // A durable acquisition target is the user's exact intent. Prefer the
      // next target from the same canonical work over a speculative pre-rank
      // torrent; otherwise a stalled pre-warm can steal Next from an episode
      // that is already downloading and streamable.
      const sourceTarget = await prisma.acquisitionTarget.findFirst({
        where: { userId, infoHash },
        select: { workKey: true },
        orderBy: { updatedAt: "desc" },
      });
      const intendedTarget = sourceTarget
        ? await prisma.acquisitionTarget.findFirst({
            where: {
              userId,
              workKey: sourceTarget.workKey,
              scope: "episode",
              season: next.season,
              episode: next.episode,
              infoHash: { not: null },
              status: { not: "failed" },
            },
            select: { infoHash: true, filePath: true },
            orderBy: { updatedAt: "desc" },
          })
        : null;
      const acquired = intendedTarget?.infoHash
        ? heldRows.find((row) => row.hash === intendedTarget.infoHash)
        : null;
      const ranked = await getPreRanked(next);
      const rankedHash = ranked?.candidate ? releaseInfoHash(ranked.candidate) : null;
      const exact = rankedHash
        ? heldRows.find((row) => row.hash === rankedHash)
        : null;
      const byEpisode =
        acquired ??
        exact ??
        heldRows.find((row) => {
          const ep = parseEpisode(row.name);
          if (ep.season !== next.season || ep.episode !== next.episode) return false;
          return normalizeTitle(workIdentity(row.name).name) === targetName;
        }) ??
        null;

      const progress = byEpisode ? Math.max(0, Math.min(1, byEpisode.progress)) : null;
      const availability =
        byEpisode == null
          ? "not-fetched"
          : progress != null && progress >= 1
            ? "ready"
            : "downloading";
      // An already-known separate torrent still deserves an exact file when its
      // verified files answer deterministically — a pack that happens to hold
      // this episode saves the player a manifest round trip too.
      const matchedPath = byEpisode
        ? (
            acquired && intendedTarget?.filePath
              ? intendedTarget.filePath
              : episodeFileInTorrent(byEpisode, next.season, next.episode)
          )
        : null;

      return reply({
        ok: true,
        next: {
          title: next.title,
          label: formatEpisodeLabel(next.season, next.episode),
          season: next.season,
          episode: next.episode,
          availability,
          infoHash: byEpisode?.hash ?? null,
          filePath: matchedPath,
          progress,
          source: next.source,
        },
      });
    }

    if (body.action === "trigger") {
      const next = body.next;
      if (
        !next ||
        typeof next.title !== "string" ||
        !next.title.trim() ||
        typeof next.season !== "number" ||
        typeof next.episode !== "number"
      ) {
        return reply(
          { error: "next requires title, season and episode" },
          { status: 400 },
        );
      }
      const outcome = await prewarmNextEpisode({
        userId,
        next: {
          title: next.title,
          mediaType: next.mediaType ?? null,
          season: next.season,
          episode: next.episode,
          watchListItemId: next.watchListItemId ?? null,
          source:
            next.source === "hunt-cursor"
              ? "hunt-cursor"
              : "playing-episode",
        },
        protectHashes: body.protectHashes,
        force: body.force,
      });
      return reply({ ok: true, outcome });
    }

    if (body.action === "progress") {
      if (
        typeof body.infoHash !== "string" ||
        typeof body.title !== "string"
      ) {
        return reply(
          { error: "infoHash and title are required" },
          { status: 400 },
        );
      }
      const outcome = await onPlaybackProgress({
        userId,
        infoHash: body.infoHash,
        title: body.title,
        season: body.season ?? null,
        episode: body.episode ?? null,
        watchListItemId: body.watchListItemId ?? null,
        positionSec: Number(body.positionSec),
        durationSec: Number(body.durationSec),
      });
      return reply({ ok: true, outcome });
    }

    return reply({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const safeError = observer.failure("PREWARM_FAILED", err, {
      action: body.action,
    });
    return reply(
      {
        error: "Pre-warm action failed",
        code: safeError.code,
        message: safeError.message,
      },
      { status: 500 },
    );
  }
}
