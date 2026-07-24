import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { grabSingleEpisode } from "@/lib/library/ondemand";

export const dynamic = "force-dynamic";

/**
 * POST — grab exactly one SxxEyy for a library show.
 * If season/episode match the item's hunt cursor, advances cursor (like automation).
 * Off-cursor rewatch leaves the hunt cursor alone.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized", message: "Sign in required" },
        { status: 401 },
      );
    }

    let body: {
      watchListItemId?: string;
      title?: string;
      mediaType?: string;
      season?: number;
      episode?: number;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON", message: "Invalid JSON" },
        { status: 400 },
      );
    }

    const season = Number(body.season);
    const episode = Number(body.episode);
    if (!Number.isFinite(season) || !Number.isFinite(episode) || season < 1 || episode < 1) {
      return NextResponse.json(
        {
          ok: false,
          error: "Invalid episode",
          message: "season and episode must be positive integers",
        },
        { status: 400 },
      );
    }

    let title = body.title?.trim();
    let mediaType = body.mediaType?.trim() || "tv";
    let watchListItemId = body.watchListItemId?.trim() || null;

    if (watchListItemId) {
      const item = await prisma.watchListItem.findFirst({
        where: { id: watchListItemId, userId: session.user.id },
      });
      if (!item) {
        return NextResponse.json(
          { ok: false, error: "Not found", message: "Library item not found" },
          { status: 404 },
        );
      }
      title = item.title;
      mediaType = item.mediaType;
    }

    if (!title) {
      return NextResponse.json(
        {
          ok: false,
          error: "Missing title",
          message: "title or watchListItemId required",
        },
        { status: 400 },
      );
    }

    const result = await grabSingleEpisode({
      userId: session.user.id,
      showTitle: title,
      mediaType,
      season,
      episode,
      watchListItemId,
    });

    return NextResponse.json(
      { ...result },
      { status: result.ok ? 200 : 502 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "On-demand failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
