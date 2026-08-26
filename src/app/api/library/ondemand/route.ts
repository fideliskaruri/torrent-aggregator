import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { grabSingleEpisode } from "@/lib/library/ondemand";
import { getTargetResolution } from "@/lib/torrents/target-resolution";
import { ApiError, defineRoute } from "@/lib/http/define-route";
import { f } from "@/lib/http/schema";

export const dynamic = "force-dynamic";

/**
 * POST — grab exactly one SxxEyy for a library show.
 * If season/episode match the item's hunt cursor, advances cursor (like automation).
 * Off-cursor rewatch leaves the hunt cursor alone.
 */
export const POST = defineRoute({
  body: {
    watchListItemId: f.string(),
    title: f.string(),
    mediaType: f.string(),
    season: f.number({ required: true, integer: true, min: 1 }),
    episode: f.number({ required: true, integer: true, min: 1 }),
    /**
     * "stream" = reclaimable buffer, "keep" = permanent file. Defaults to
     * "keep" so existing callers (the library's explicit Get) are unchanged;
     * the player's Next button asks for "stream" because advancing an episode
     * while watching should behave like the Play that got you here, not
     * silently start a permanent download.
     */
    retention: f.enum(["stream", "keep"] as const),
    /** The stream on screen right now, which reclamation must not evict. */
    protectHashes: f.stringArray(),
    /** Owner saw the real figures and chose to proceed past their own cap. */
    overrideStorageCap: f.boolean(),
  },
})(async ({ session, body }) => {
    let title = body.title?.trim() || undefined;
    let mediaType = body.mediaType?.trim() || "tv";
    const watchListItemId = body.watchListItemId?.trim() || null;
    let preferredResolution: number | null = null;
    let workId: string | null = null;

    if (watchListItemId) {
      const item = await prisma.watchListItem.findFirst({
        where: { id: watchListItemId, userId: session.user.id },
      });
      if (!item) {
        throw new ApiError(404, "Not found", "Library item not found");
      }
      title = item.title;
      mediaType = item.mediaType;
      preferredResolution = item.preferredResolution;
      workId = item.workId;
    }

    if (body.retention !== "stream" && preferredResolution == null) {
      preferredResolution = await getTargetResolution();
    }

    if (!title) {
      throw new ApiError(
        400,
        "Missing title",
        "title or watchListItemId required",
      );
    }

    const result = await grabSingleEpisode({
      userId: session.user.id,
      workId,
      showTitle: title,
      mediaType,
      season: body.season,
      episode: body.episode,
      watchListItemId,
      retention: body.retention === "stream" ? "stream" : "keep",
      preferredResolution:
        body.retention === "stream" ? null : preferredResolution,
      protectHashes: body.protectHashes ?? undefined,
      overrideStorageCap: body.overrideStorageCap === true,
    });

    return NextResponse.json(
      { ...result },
      // A storage refusal is not a bad gateway. 507 is what every other send
      // path returns for it, and it is what the client keys on to offer the
      // override prompt instead of a generic failure toast.
      { status: result.ok ? 200 : result.storage ? 507 : 502 },
    );
});

