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
      /**
       * "stream" = reclaimable buffer, "keep" = permanent file. Defaults to
       * "keep" so existing callers (the library's explicit Get) are unchanged;
       * the player's Next button asks for "stream" because advancing an episode
       * while watching should behave like the Play that got you here, not
       * silently start a permanent download.
       */
      retention?: "stream" | "keep";
      /** The stream on screen right now, which reclamation must not evict. */
      protectHashes?: string[];
      /** Owner saw the real figures and chose to proceed past their own cap. */
      overrideStorageCap?: boolean;
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
    const watchListItemId = body.watchListItemId?.trim() || null;

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
      retention: body.retention === "stream" ? "stream" : "keep",
      protectHashes: Array.isArray(body.protectHashes)
        ? body.protectHashes.filter((h): h is string => typeof h === "string" && h.length > 0)
        : undefined,
      overrideStorageCap: body.overrideStorageCap === true,
    });

    return NextResponse.json(
      { ...result },
      // A storage refusal is not a bad gateway. 507 is what every other send
      // path returns for it, and it is what the client keys on to offer the
      // override prompt instead of a generic failure toast.
      { status: result.ok ? 200 : result.storage ? 507 : 502 },
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
