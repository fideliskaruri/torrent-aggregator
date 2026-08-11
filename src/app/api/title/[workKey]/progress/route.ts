import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import type {
  TitleEpisodeTransfer,
  TitleProgressPayload,
} from "@/components/title/types";
import {
  acquisitionTransferFromRow,
  resolveAcquisitionTransfer,
} from "../acquisition-target";
import { localFilePresence } from "@/lib/library/local-file-presence";
import { persistedTorrentHasInvalidMedia } from "@/lib/clients/builtin-engine-lifecycle";

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

    const targets = await prisma.acquisitionTarget.findMany({
      where: {
        userId,
        workKey: decoded,
        status: { in: ["queued", "downloading"] }, // Only active transfers
      },
      select: {
        id: true,
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
    const hashes = targets
      .map((target) => target.infoHash?.trim().toLowerCase() ?? "")
      .filter(Boolean);
    const engines = hashes.length > 0
      ? await prisma.engineTorrent.findMany({
          where: {
            userId,
            hash: { in: hashes },
            status: { not: "removed" },
          },
        })
      : [];
    const engineByHash = new Map(
      engines.map((engine) => [engine.hash.trim().toLowerCase(), engine]),
    );

    const episodeTransfers: Record<string, TitleEpisodeTransfer | null> = {};
    const seasonTransfers: Record<string, TitleEpisodeTransfer | null> = {};
    let titleTransfer: TitleEpisodeTransfer | null = null;
    const updates: Promise<unknown>[] = [];

    for (const target of targets) {
      const persisted = acquisitionTransferFromRow(target);
      const engine = target.infoHash
        ? engineByHash.get(target.infoHash.trim().toLowerCase()) ?? null
        : null;
      const invalidMedia = engine
        ? persistedTorrentHasInvalidMedia(engine)
        : false;
      const transfer = resolveAcquisitionTransfer(
        persisted,
        engine
          ? {
              hash: engine.hash,
              status: invalidMedia ? "error" : engine.status,
              progress: engine.progress,
            }
          : null,
        engine
          ? invalidMedia
            ? "absent"
            : localFilePresence(engine)
          : "unknown",
      );

      if (
        transfer.status !== persisted.status
        || transfer.progress !== persisted.progress
        || transfer.infoHash !== persisted.infoHash
        || transfer.filePath !== persisted.filePath
        || transfer.error !== persisted.error
      ) {
        updates.push(
          prisma.acquisitionTarget.update({
            where: { id: target.id },
            data: transfer,
          }),
        );
      }

      if (
        transfer.status !== "queued"
        && transfer.status !== "downloading"
      ) {
        continue;
      }

      if (target.scope === "title") {
        titleTransfer = transfer;
      } else if (target.scope === "season" && target.season != null) {
        seasonTransfers[String(target.season)] = transfer;
      } else if (target.scope === "episode" && target.season != null && target.episode != null) {
        episodeTransfers[`S${String(target.season).padStart(2, "0")}E${String(target.episode).padStart(2, "0")}`] = transfer;
      }
    }
    if (updates.length > 0) await Promise.all(updates);

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
