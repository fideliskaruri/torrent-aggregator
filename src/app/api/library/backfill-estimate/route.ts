import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getUserClientConfig } from "@/lib/clients";
import {
  canFitEstimate,
  estimateBackfillBytes,
  formatBytesShort,
  getFreeSpace,
} from "@/lib/library/disk-space";

export const dynamic = "force-dynamic";

/**
 * GET/POST — estimate bulk catch-up size vs free space (never auto-starts grab).
 * Query: watchListItemId | title, fromSeason, toSeason
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
      fromSeason?: number;
      toSeason?: number;
      episodesPerSeason?: number;
      avgEpisodeGb?: number;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON", message: "Invalid JSON" },
        { status: 400 },
      );
    }

    let fromSeason = Number(body.fromSeason);
    let toSeason = Number(body.toSeason);
    let title = "Show";

    if (body.watchListItemId) {
      const item = await prisma.watchListItem.findFirst({
        where: { id: body.watchListItemId, userId: session.user.id },
      });
      if (!item) {
        return NextResponse.json(
          { ok: false, error: "Not found", message: "Library item not found" },
          { status: 404 },
        );
      }
      title = item.title;
      if (!Number.isFinite(fromSeason) || fromSeason < 1) {
        fromSeason = item.fromSeason ?? item.cursorSeason ?? 1;
      }
    }

    if (!Number.isFinite(fromSeason) || fromSeason < 1) fromSeason = 1;
    if (!Number.isFinite(toSeason) || toSeason < fromSeason) {
      toSeason = fromSeason;
    }

    const avgEpisodeBytes =
      body.avgEpisodeGb != null && Number.isFinite(body.avgEpisodeGb)
        ? body.avgEpisodeGb * 1e9
        : undefined;

    const estimate = estimateBackfillBytes({
      fromSeason,
      toSeason,
      episodesPerSeason: body.episodesPerSeason,
      avgEpisodeBytes,
    });

    const config = await getUserClientConfig(session.user.id);
    const root =
      config?.baseDownloadPath?.trim() ||
      config?.savePath?.trim() ||
      process.cwd();
    const space = await getFreeSpace(root);
    const fit = canFitEstimate(space.freeBytes, estimate.estimatedBytes);

    return NextResponse.json({
      ok: true,
      title,
      fromSeason,
      toSeason,
      seasons: estimate.seasons,
      episodes: estimate.episodes,
      estimatedBytes: estimate.estimatedBytes,
      estimatedLabel: formatBytesShort(estimate.estimatedBytes),
      freeBytes: space.freeBytes,
      freeLabel:
        space.freeBytes != null ? formatBytesShort(space.freeBytes) : "unknown",
      canFit: fit.canFit,
      message: fit.message,
      note: "Estimate only — confirm in UI before any bulk grab. Default monitoring never bulk-grabs.",
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "Estimate failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
