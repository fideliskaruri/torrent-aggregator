import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { COMPLETION_THRESHOLD } from "@/lib/browse/types";
import { isSlopTitle } from "@/lib/metadata/slop";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { workIdentity } from "@/lib/torrents/work-identity";
import type { ProgressUpdateBody, ProgressEntry } from "@/lib/browse/types";

export const dynamic = "force-dynamic";

/**
 * Upsert playback position. Designed to be called every ~10s during playback.
 *
 * Idempotent on [userId, infoHash, filePath]. Auto-marks complete when
 * position passes COMPLETION_THRESHOLD of duration.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ProgressUpdateBody;
  try {
    body = (await request.json()) as ProgressUpdateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate required fields
  if (!body.infoHash || typeof body.infoHash !== "string") {
    return NextResponse.json(
      { error: "infoHash is required" },
      { status: 400 },
    );
  }
  // Normalise before it touches the [userId, infoHash, filePath] unique key.
  // `EngineTorrent.hash` is stored lowercase and the playback-plan route
  // normalises too, so a player posting a mixed-case or base32 hash here would
  // create a *second* progress row for the same file — and resume would
  // silently restart from zero while the old row sat there invisibly.
  const infoHashKey = normalizeInfoHash(body.infoHash);
  if (!infoHashKey) {
    return NextResponse.json(
      { error: "infoHash is not a valid torrent info hash" },
      { status: 400 },
    );
  }
  if (!body.filePath || typeof body.filePath !== "string") {
    return NextResponse.json(
      { error: "filePath is required" },
      { status: 400 },
    );
  }
  if (!body.title || typeof body.title !== "string") {
    return NextResponse.json(
      { error: "title is required" },
      { status: 400 },
    );
  }
  if (typeof body.positionSec !== "number" || body.positionSec < 0) {
    return NextResponse.json(
      { error: "positionSec must be a non-negative number" },
      { status: 400 },
    );
  }
  if (typeof body.durationSec !== "number" || body.durationSec <= 0) {
    return NextResponse.json(
      { error: "durationSec must be a positive number" },
      { status: 400 },
    );
  }
  if (body.positionSec > body.durationSec) {
    return NextResponse.json(
      { error: "positionSec cannot exceed durationSec" },
      { status: 400 },
    );
  }

  const userId = session.user.id;
  const fraction = body.durationSec > 0 ? body.positionSec / body.durationSec : 0;
  const isComplete = fraction >= COMPLETION_THRESHOLD;
  // Player often posts the episode label ("S01E08") as title. Prefer a real
  // work name from the file path so rails never say "watching S01E08".
  const title = resolveProgressTitle(body.title, body.filePath);

  // Check if there's an existing record that is already completed — don't
  // un-complete it if the player scrubs backwards.
  const existing = await prisma.playbackProgress.findUnique({
    where: {
      userId_infoHash_filePath: {
        userId,
        infoHash: infoHashKey,
        filePath: body.filePath,
      },
    },
    select: { completedAt: true },
  });

  const completedAt =
    isComplete
      ? existing?.completedAt ?? new Date()
      : existing?.completedAt ?? null;

  const row = await prisma.playbackProgress.upsert({
    where: {
      userId_infoHash_filePath: {
        userId,
        infoHash: infoHashKey,
        filePath: body.filePath,
      },
    },
    create: {
      userId,
      infoHash: infoHashKey,
      filePath: body.filePath,
      positionSec: body.positionSec,
      durationSec: body.durationSec,
      completedAt: isComplete ? new Date() : null,
      title,
      season: body.season ?? null,
      episode: body.episode ?? null,
      posterUrl: body.posterUrl ?? null,
      watchListItemId: body.watchListItemId ?? null,
    },
    update: {
      positionSec: body.positionSec,
      durationSec: body.durationSec,
      completedAt,
      title,
      season: body.season ?? null,
      episode: body.episode ?? null,
      posterUrl: body.posterUrl ?? null,
      watchListItemId: body.watchListItemId ?? null,
    },
  });

  // ── Pre-warm trigger ────────────────────────────────────────────────
  // Fire-and-forget, deliberately *after* the row is written and deliberately
  // not awaited: a progress ping is on the playback hot path and speculative
  // work may never delay it, fail it, or change its response. The import is
  // dynamic so the prewarm subsystem stays out of this route's static graph.
  //
  // The trigger lives here rather than in the player because the player already
  // reports progress; asking it to also decide when to speculate would put
  // policy in a component and give the client a way to start downloads.
  void (async () => {
    const { onPlaybackProgress } = await import("@/lib/prewarm/prewarm");
    await onPlaybackProgress({
      userId,
      infoHash: infoHashKey,
      title,
      season: body.season ?? null,
      episode: body.episode ?? null,
      watchListItemId: body.watchListItemId ?? null,
      positionSec: body.positionSec,
      durationSec: body.durationSec,
    });
  })().catch(() => {
    // Already logged inside the prewarm subsystem. Never surfaced.
  });

  return NextResponse.json({ ok: true, id: row.id, completedAt: row.completedAt });
}

/**
 * Keep a real work name when the player only knows the episode coordinate.
 * Falls back to the posted title when the path cannot improve it.
 */
export function resolveProgressTitle(posted: string, filePath: string): string {
  const trimmed = posted.trim();
  if (trimmed && !isSlopTitle(trimmed) && !isSlopTitle(workIdentity(trimmed).name)) {
    return workIdentity(trimmed).name || trimmed;
  }
  const path = filePath.replace(/\\/g, "/");
  const leaf = path.split("/").filter(Boolean).at(-1) ?? filePath;
  for (const raw of [leaf, filePath]) {
    const name = workIdentity(raw).name?.trim();
    if (name && !isSlopTitle(name)) return name;
  }
  return trimmed || posted;
}

/**
 * Retrieve playback progress entries for the current user.
 *
 * Optional query params:
 * - `active=1` — only incomplete (Continue Watching candidates)
 * - `infoHash` — filter to a specific torrent
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const activeOnly = searchParams.get("active") === "1";
  const infoHash = searchParams.get("infoHash");

  const where: Record<string, unknown> = { userId: session.user.id };
  if (activeOnly) where.completedAt = null;
  // Normalise so a caller filtering with the hash the UI shows still matches
  // the lowercase form POST stores.
  if (infoHash) where.infoHash = normalizeInfoHash(infoHash) ?? infoHash;

  const rows = await prisma.playbackProgress.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  const entries: ProgressEntry[] = rows.map((r) => ({
    id: r.id,
    infoHash: r.infoHash,
    filePath: r.filePath,
    positionSec: r.positionSec,
    durationSec: r.durationSec,
    fraction:
      r.durationSec && r.durationSec > 0
        ? Math.min(r.positionSec / r.durationSec, 1)
        : 0,
    completedAt: r.completedAt?.toISOString() ?? null,
    title: r.title,
    season: r.season,
    episode: r.episode,
    posterUrl: r.posterUrl,
    watchListItemId: r.watchListItemId,
    updatedAt: r.updatedAt.toISOString(),
  }));

  return NextResponse.json({ entries });
}
