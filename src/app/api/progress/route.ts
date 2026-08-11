import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { COMPLETION_THRESHOLD } from "@/lib/browse/types";
import { isSlopTitle } from "@/lib/metadata/slop";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { workIdentity } from "@/lib/torrents/work-identity";
import type { ProgressEntry } from "@/lib/browse/types";
import {
  canonicalProgressTitle,
  canonicalWorkForHash,
} from "@/lib/work/store";
import {
  numberField,
  queryString,
  readMutationObject,
  requestFailureResponse,
  stringField,
} from "@/lib/http/request";

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

  const parsedBody = await readMutationObject(request);
  if (!parsedBody.ok) return requestFailureResponse(parsedBody);
  const fields = parsedBody.value;
  const infoHash = stringField(fields, "infoHash", { required: true, maxLength: 64 });
  if (!infoHash.ok) return requestFailureResponse(infoHash);
  const filePath = stringField(fields, "filePath", { required: true, maxLength: 4096 });
  if (!filePath.ok) return requestFailureResponse(filePath);
  const normalizedFilePath = (filePath.value ?? "").replace(/\\/g, "/");
  if (
    normalizedFilePath.includes("\0") ||
    normalizedFilePath.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalizedFilePath) ||
    normalizedFilePath.split("/").some((segment) => segment === "..")
  ) {
    return NextResponse.json(
      {
        error: "filePath must be a safe path inside the torrent",
        field: "filePath",
      },
      { status: 400 },
    );
  }
  const titleField = stringField(fields, "title", { required: true, maxLength: 500 });
  if (!titleField.ok) return requestFailureResponse(titleField);
  const positionSec = numberField(fields, "positionSec", {
    required: true,
    min: 0,
    max: 1_000_000_000,
  });
  if (!positionSec.ok) return requestFailureResponse(positionSec);
  const durationSec = numberField(fields, "durationSec", {
    required: true,
    min: Number.EPSILON,
    max: 1_000_000_000,
  });
  if (!durationSec.ok) return requestFailureResponse(durationSec);
  const season = numberField(fields, "season", {
    nullable: true,
    integer: true,
    min: 1,
    max: 10_000,
  });
  if (!season.ok) return requestFailureResponse(season);
  const episode = numberField(fields, "episode", {
    nullable: true,
    integer: true,
    min: 1,
    max: 100_000,
  });
  if (!episode.ok) return requestFailureResponse(episode);
  const posterUrl = stringField(fields, "posterUrl", {
    nullable: true,
    maxLength: 2048,
  });
  if (!posterUrl.ok) return requestFailureResponse(posterUrl);
  const watchListItemId = stringField(fields, "watchListItemId", {
    nullable: true,
    maxLength: 128,
  });
  if (!watchListItemId.ok) return requestFailureResponse(watchListItemId);

  const body = {
    infoHash: infoHash.value ?? "",
    filePath: normalizedFilePath,
    title: titleField.value ?? "",
    positionSec: positionSec.value ?? 0,
    durationSec: durationSec.value ?? 0,
    season: season.value,
    episode: episode.value,
    posterUrl: posterUrl.value,
    watchListItemId: watchListItemId.value,
  };

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
  if (body.positionSec > body.durationSec) {
    return NextResponse.json(
      { error: "positionSec cannot exceed durationSec" },
      { status: 400 },
    );
  }

  const userId = session.user.id;
  const work = await canonicalWorkForHash(userId, infoHashKey);
  const fraction = body.durationSec > 0 ? body.positionSec / body.durationSec : 0;
  const isComplete = fraction >= COMPLETION_THRESHOLD;
  // Player often posts the episode label ("S01E08") as title. Prefer a real
  // work name from the file path so rails never say "watching S01E08".
  const resolvedTitle = resolveProgressTitle(body.title, body.filePath);
  const title = work
    ? canonicalProgressTitle(work, resolvedTitle)
    : resolvedTitle;

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
  if (work) {
    await prisma.$executeRawUnsafe(
      `UPDATE "PlaybackProgress" SET "workId" = ?
       WHERE "id" = ?`,
      work.id,
      row.id,
    );
  }

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
  const active = queryString(searchParams, "active", { allowed: ["0", "1"] });
  if (!active.ok) return requestFailureResponse(active);
  const infoHashParam = queryString(searchParams, "infoHash", { maxLength: 64 });
  if (!infoHashParam.ok) return requestFailureResponse(infoHashParam);
  const activeOnly = active.value === "1";
  const infoHash = infoHashParam.value;

  // Normalise so a caller filtering with the hash the UI shows still matches
  // the lowercase form POST stores.
  let normalizedInfoHash: string | null = null;
  if (infoHash) {
    const normalized = normalizeInfoHash(infoHash);
    if (!normalized) {
      return NextResponse.json(
        { error: "infoHash is not a valid torrent info hash", field: "infoHash" },
        { status: 400 },
      );
    }
    normalizedInfoHash = normalized;
  }

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      workId: string | null;
      workKey: string | null;
      canonicalTitle: string | null;
      infoHash: string;
      filePath: string;
      positionSec: number;
      durationSec: number | null;
      completedAt: Date | string | null;
      title: string;
      season: number | null;
      episode: number | null;
      posterUrl: string | null;
      watchListItemId: string | null;
      updatedAt: Date | string;
    }>
  >(
    `SELECT p."id", p."workId", p."infoHash", p."filePath",
            p."positionSec", p."durationSec", p."completedAt", p."title",
            p."season", p."episode", p."posterUrl", p."watchListItemId",
            p."updatedAt", w."workKey", w."canonicalTitle"
     FROM "PlaybackProgress" p
     LEFT JOIN "Work" w ON w."id" = p."workId"
     WHERE p."userId" = ?
       AND (? = 0 OR p."completedAt" IS NULL)
       AND (? IS NULL OR p."infoHash" = ?)
     ORDER BY p."updatedAt" DESC
     LIMIT 50`,
    session.user.id,
    activeOnly ? 1 : 0,
    normalizedInfoHash,
    normalizedInfoHash,
  );

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
    completedAt:
      r.completedAt == null
        ? null
        : (r.completedAt instanceof Date
          ? r.completedAt
          : new Date(r.completedAt)).toISOString(),
    workId: r.workId,
    workKey: r.workKey,
    title: r.canonicalTitle ?? r.title,
    season: r.season,
    episode: r.episode,
    posterUrl: r.posterUrl,
    watchListItemId: r.watchListItemId,
    updatedAt: (r.updatedAt instanceof Date
      ? r.updatedAt
      : new Date(r.updatedAt)).toISOString(),
  }));

  return NextResponse.json({ entries });
}
