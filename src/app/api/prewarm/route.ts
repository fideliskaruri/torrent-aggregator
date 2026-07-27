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
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getUserClientConfig } from "@/lib/clients";
import { evictPrewarmsForBytes, listEvictablePrewarms } from "@/lib/prewarm/eviction";
import { preRankUpcoming, upcomingTargets } from "@/lib/prewarm/prerank";
import {
  foregroundSnapshot,
  markForegroundActive,
  syncPrewarmSuspension,
} from "@/lib/prewarm/foreground";
import { onPlaybackProgress, prewarmNextEpisode } from "@/lib/prewarm/prewarm";
import { PREWARM_ORIGIN } from "@/lib/prewarm/types";
import type { NextEpisode } from "@/lib/prewarm/types";

export const dynamic = "force-dynamic";

/**
 * What is currently speculative, and what could be reclaimed.
 *
 * Read-only. Resolves nothing and searches nothing — a status page must not
 * become a reason to hit an indexer.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    return NextResponse.json({
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
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message, prewarms: [], evictableCount: 0, upcoming: [] },
      { status: 500 },
    );
  }
}

type PrewarmRequest =
  | { action: "prerank"; limit?: number }
  | { action: "evict"; bytes: number }
  | { action: "foreground"; infoHash?: string; beacon?: boolean }
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
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: PrewarmRequest;
  try {
    body = (await request.json()) as PrewarmRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    if (body.action === "prerank") {
      const choices = await preRankUpcoming(userId, { limit: body.limit });
      return NextResponse.json({
        ok: true,
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
    }

    if (body.action === "evict") {
      const config = await getUserClientConfig(userId);
      if (!config) {
        return NextResponse.json({ ok: false, reason: "no-client", evicted: [] });
      }
      const bytes = Number(body.bytes);
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return NextResponse.json({ error: "bytes must be positive" }, { status: 400 });
      }
      const result = await evictPrewarmsForBytes({
        userId,
        neededBytes: bytes,
        config,
      });
      return NextResponse.json({
        ok: true,
        satisfied: result.satisfied,
        freedBytes: result.freedBytes,
        evicted: result.evicted.map((c) => ({ hash: c.hash, name: c.name })),
        skipped: result.skipped,
      });
    }

    if (body.action === "foreground") {
      // `beacon` records a live stream; omitting it just reconciles against
      // whatever the engine is actually doing.
      if (body.beacon !== false) markForegroundActive(body.infoHash ?? null);
      const result = await syncPrewarmSuspension({ userId });
      return NextResponse.json({
        ok: true,
        foreground: result.foreground,
        suspended: result.suspended,
        resumed: result.resumed,
        parked: result.parked,
        snapshot: foregroundSnapshot(),
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
        return NextResponse.json(
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
          source: next.source === "hunt-cursor" ? "hunt-cursor" : "playing-episode",
        },
        protectHashes: body.protectHashes,
        force: body.force,
      });
      return NextResponse.json({ ok: true, outcome });
    }

    if (body.action === "progress") {
      if (typeof body.infoHash !== "string" || typeof body.title !== "string") {
        return NextResponse.json(
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
      return NextResponse.json({ ok: true, outcome });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
