import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  cursorFromStart,
  episodeSearchQuery,
  resolveHuntCursor,
} from "@/lib/library/cursor";
import { resolveMetadata } from "@/lib/metadata/enrich";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await prisma.watchListItem.findMany({
    where: { userId: session.user.id },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ items });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    mediaType?: string;
    externalId?: string;
    title?: string;
    posterUrl?: string | null;
    synopsis?: string | null;
    rating?: number | null;
    status?: string;
    /**
     * Defaults to true. A recommendation added as "planned" passes false: it
     * has not earned disk, and automation hunts every monitored row.
     */
    monitored?: boolean;
    /** Library aggregator: start monitoring from this season (TV/anime) */
    fromSeason?: number | null;
    fromEpisode?: number | null;
    monitorMode?: string;
  };

  if (!body.mediaType || !body.externalId || !body.title) {
    return NextResponse.json(
      { error: "mediaType, externalId, and title are required" },
      { status: 400 },
    );
  }

  const isSeries = body.mediaType === "tv" || body.mediaType === "anime";
  let fromSeason: number | null = null;
  let fromEpisode: number | null = null;
  let cursorSeason: number | null = null;
  let cursorEpisode: number | null = null;
  let nextEpisodeHint: string | null = null;

  if (isSeries && body.fromSeason != null && body.fromSeason >= 1) {
    const cur = cursorFromStart(body.fromSeason, body.fromEpisode ?? 1);
    fromSeason = cur.season;
    fromEpisode = cur.episode;
    cursorSeason = cur.season;
    cursorEpisode = cur.episode;
    nextEpisodeHint = episodeSearchQuery(body.title, cur.season, cur.episode);
  }

  /**
   * Callers that already hold metadata (the search flow) pass it through.
   * Callers that do not (the demo seeder, a hand-rolled curl) used to create a
   * row with no poster, which the library renders as a grey letter tile. Fill
   * the gap here rather than at every call site, and never let a catalog
   * outage block the add itself.
   */
  let art: {
    posterUrl?: string | null;
    synopsis?: string | null;
    rating?: number | null;
  } = {
    posterUrl: body.posterUrl ?? null,
    synopsis: body.synopsis ?? null,
    rating: body.rating ?? null,
  };
  if (!art.posterUrl) {
    try {
      const resolved = await resolveMetadata(body.title, body.mediaType);
      if (resolved) {
        art = {
          posterUrl: resolved.posterUrl ?? null,
          synopsis: art.synopsis ?? resolved.synopsis ?? null,
          rating: art.rating ?? resolved.rating ?? null,
        };
      }
    } catch {
      // Metadata is decoration; adding to the library is the actual request.
    }
  }

  const item = await prisma.watchListItem.upsert({
    where: {
      userId_mediaType_externalId: {
        userId: session.user.id,
        mediaType: body.mediaType,
        externalId: body.externalId,
      },
    },
    create: {
      userId: session.user.id,
      mediaType: body.mediaType,
      externalId: body.externalId,
      title: body.title,
      posterUrl: art.posterUrl,
      synopsis: art.synopsis,
      rating: art.rating,
      status: body.status ?? "watching",
      monitored: body.monitored ?? true,
      fromSeason,
      fromEpisode,
      cursorSeason,
      cursorEpisode,
      nextEpisodeHint,
      monitorMode: body.monitorMode ?? "ongoing",
    },
    update: {
      title: body.title,
      // Only overwrite art we actually have. `?? null` here meant re-adding a
      // title from a source with no poster erased the poster already on file.
      ...(art.posterUrl ? { posterUrl: art.posterUrl } : {}),
      ...(art.synopsis ? { synopsis: art.synopsis } : {}),
      ...(art.rating != null ? { rating: art.rating } : {}),
      status: body.status ?? undefined,
      // Re-adding with a season resets the hunt cursor
      ...(fromSeason != null
        ? {
            fromSeason,
            fromEpisode,
            cursorSeason,
            cursorEpisode,
            nextEpisodeHint,
            monitored: true,
          }
        : {}),
      ...(body.monitorMode ? { monitorMode: body.monitorMode } : {}),
    },
  });

  return NextResponse.json({ item });
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  await prisma.watchListItem.deleteMany({
    where: { id, userId: session.user.id },
  });

  return NextResponse.json({ ok: true });
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    id?: string;
    status?: string;
    lastEpisode?: string | null;
    monitored?: boolean;
    fromSeason?: number | null;
    fromEpisode?: number | null;
    cursorSeason?: number | null;
    cursorEpisode?: number | null;
    monitorMode?: string;
  };

  if (!body.id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const existing = await prisma.watchListItem.findFirst({
    where: { id: body.id, userId: session.user.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const data: Record<string, unknown> = {
    lastChecked: new Date(),
  };
  if (body.status !== undefined) data.status = body.status;
  if (body.monitored !== undefined) data.monitored = body.monitored;
  if (body.monitorMode !== undefined) data.monitorMode = body.monitorMode;
  if (body.lastEpisode !== undefined) data.lastEpisode = body.lastEpisode;

  // Reset hunt start: set from + cursor together
  if (body.fromSeason != null && body.fromSeason >= 1) {
    const cur = cursorFromStart(body.fromSeason, body.fromEpisode ?? 1);
    data.fromSeason = cur.season;
    data.fromEpisode = cur.episode;
    data.cursorSeason = cur.season;
    data.cursorEpisode = cur.episode;
    data.nextEpisodeHint = episodeSearchQuery(
      existing.title,
      cur.season,
      cur.episode,
    );
  } else if (
    body.cursorSeason != null &&
    body.cursorEpisode != null &&
    body.cursorSeason >= 1 &&
    body.cursorEpisode >= 1
  ) {
    data.cursorSeason = body.cursorSeason;
    data.cursorEpisode = body.cursorEpisode;
    data.nextEpisodeHint = episodeSearchQuery(
      existing.title,
      body.cursorSeason,
      body.cursorEpisode,
    );
  } else if (body.lastEpisode !== undefined) {
    // Keep cursor in sync when user edits last episode
    const hunt = resolveHuntCursor({
      title: existing.title,
      mediaType: existing.mediaType,
      lastEpisode: body.lastEpisode,
      fromSeason: existing.fromSeason,
      fromEpisode: existing.fromEpisode,
    });
    if (hunt.cursor) {
      data.cursorSeason = hunt.cursor.season;
      data.cursorEpisode = hunt.cursor.episode;
      data.nextEpisodeHint = hunt.query;
    }
  }

  await prisma.watchListItem.update({
    where: { id: body.id },
    data,
  });

  const updated = await prisma.watchListItem.findUnique({
    where: { id: body.id },
  });

  return NextResponse.json({ item: updated });
}
