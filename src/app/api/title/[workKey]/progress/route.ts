import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import type { TitleEpisodeTransfer } from "@/components/title/types";

export const dynamic = "force-dynamic";

type RouteParams = {
  workKey: string;
};

type RouteContext = {
  params: RouteParams | Promise<RouteParams>;
};

/**
 * Lightweight progress-only endpoint for polling during downloads.
 * Returns only active transfers (queued/downloading) to avoid full re-renders.
 * Polled every 2.5s while a transfer is in flight; does not include metadata.
 */
export interface TitleProgressPayload {
  workKey: string;
  /**
   * Title-level transfer, or null.
   * This is what a film-level grab produces.
   */
  transfer: TitleEpisodeTransfer | null;
  /**
   * Season-level transfers. Keyed by season number (as string).
   * Example: { "1": { status: "downloading", progress: 0.45, ... } }
   */
  seasonTransfers: Record<string, TitleEpisodeTransfer | null>;
  /**
   * Episode-level transfers. Keyed by `S01E02` format.
   * Example: { "S01E02": { status: "downloading", progress: 0.75, ... } }
   */
  episodeTransfers: Record<string, TitleEpisodeTransfer | null>;
  generatedAt: string;
}

export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workKey } = await context.params;
  if (!workKey?.trim()) {
    return NextResponse.json({ error: "Missing work key" }, { status: 400 });
  }

  try {
    const decoded = decodeURIComponent(workKey);
    const userId = session.user.id;

    // Fetch all active acquisition targets (transfer states)
    const targets = await prisma.acquisitionTarget.findMany({
      where: {
        userId,
        workKey: decoded,
        status: { in: ["queued", "downloading"] }, // Only active transfers
      },
      select: {
        scope: true,
        season: true,
        episode: true,
        status: true,
        progress: true,
        infoHash: true,
        filePath: true,
        error: true,
      },
    });

    const episodeTransfers: Record<string, TitleEpisodeTransfer | null> = {};
    const seasonTransfers: Record<string, TitleEpisodeTransfer | null> = {};
    let titleTransfer: TitleEpisodeTransfer | null = null;

    // Organize by scope
    for (const target of targets) {
      const transfer: TitleEpisodeTransfer = {
        status: target.status === "downloading" ? "downloading" : "queued",
        progress: target.progress ?? 0,
        infoHash: target.infoHash,
        filePath: target.filePath,
        error: target.error,
      };

      if (target.scope === "title") {
        titleTransfer = transfer;
      } else if (target.scope === "season" && target.season != null) {
        seasonTransfers[String(target.season)] = transfer;
      } else if (target.scope === "episode" && target.season != null && target.episode != null) {
        episodeTransfers[`S${String(target.season).padStart(2, "0")}E${String(target.episode).padStart(2, "0")}`] = transfer;
      }
    }

    const payload: TitleProgressPayload = {
      workKey: decoded,
      transfer: titleTransfer,
      seasonTransfers,
      episodeTransfers,
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(payload);
  } catch (err) {
    console.error("[title-progress]", err);
    return NextResponse.json(
      {
        error: "Failed to fetch progress",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
