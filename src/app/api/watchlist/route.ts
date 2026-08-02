import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  cursorFromStart,
  episodeSearchQuery,
  resolveHuntCursor,
} from "@/lib/library/cursor";
import { resolveMetadata } from "@/lib/metadata/enrich";
import { isSeriesMediaType, normalizeMediaType } from "@/lib/metadata/media-type";
import { promoteLibraryStreamsToKept } from "@/lib/streaming/retention";
import { SELECTABLE_RESOLUTIONS } from "@/lib/torrents/target-resolution";
import {
  booleanField,
  enumField,
  guardBrowserMutation,
  numberField,
  queryString,
  readMutationObject,
  requestFailureResponse,
  stringField,
  type RequestResult,
} from "@/lib/http/request";

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

/**
 * A per-title resolution override.
 *
 * Null is a real answer meaning "follow the global preference", and is not the
 * same as storing today's global value: a copy taken at add time would stop
 * tracking the setting it came from, so changing the global later would leave
 * every existing title behind at a number nobody chose deliberately.
 */
function resolutionField(
  fields: ReadonlyMap<string, unknown>,
): RequestResult<number | null> {
  const parsed = numberField(fields, "preferredResolution", {
    nullable: true,
    integer: true,
    min: 1,
    max: 100_000,
  });
  if (!parsed.ok) return parsed;
  if (parsed.value == null) return { ok: true, value: null };
  // An arbitrary number here would be stored and then silently ignored by the
  // hunt, which snaps to the ladder it knows. Rejecting is honest; accepting
  // and rounding would tell the user 1440 was saved when 1080 was.
  if (!(SELECTABLE_RESOLUTIONS as readonly number[]).includes(parsed.value)) {
    return {
      ok: false,
      status: 400,
      error: `preferredResolution must be one of ${SELECTABLE_RESOLUTIONS.join(", ")}`,
    };
  }
  return { ok: true, value: parsed.value };
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = await readMutationObject(request);
  if (!parsedBody.ok) return requestFailureResponse(parsedBody);
  const fields = parsedBody.value;
  const mediaTypeInput = stringField(fields, "mediaType", {
    required: true,
    maxLength: 32,
  });
  if (!mediaTypeInput.ok) return requestFailureResponse(mediaTypeInput);
  const mediaType = normalizeMediaType(mediaTypeInput.value);
  if (!mediaType) {
    return NextResponse.json(
      { error: "mediaType must be anime, movie, or tv", field: "mediaType" },
      { status: 400 },
    );
  }
  const externalId = stringField(fields, "externalId", {
    required: true,
    maxLength: 128,
  });
  if (!externalId.ok) return requestFailureResponse(externalId);
  const title = stringField(fields, "title", { required: true, maxLength: 500 });
  if (!title.ok) return requestFailureResponse(title);
  const posterUrl = stringField(fields, "posterUrl", { nullable: true, maxLength: 2048 });
  if (!posterUrl.ok) return requestFailureResponse(posterUrl);
  const synopsis = stringField(fields, "synopsis", { nullable: true, maxLength: 20_000 });
  if (!synopsis.ok) return requestFailureResponse(synopsis);
  const rating = numberField(fields, "rating", { nullable: true, min: 0, max: 10 });
  if (!rating.ok) return requestFailureResponse(rating);
  const status = enumField(
    fields,
    "status",
    ["watching", "planned", "completed", "dropped"] as const,
  );
  if (!status.ok) return requestFailureResponse(status);
  const monitored = booleanField(fields, "monitored");
  if (!monitored.ok) return requestFailureResponse(monitored);
  const fromSeasonInput = numberField(fields, "fromSeason", {
    nullable: true,
    integer: true,
    min: 1,
    max: 10_000,
  });
  if (!fromSeasonInput.ok) return requestFailureResponse(fromSeasonInput);
  const fromEpisodeInput = numberField(fields, "fromEpisode", {
    nullable: true,
    integer: true,
    min: 1,
    max: 100_000,
  });
  if (!fromEpisodeInput.ok) return requestFailureResponse(fromEpisodeInput);
  const monitorMode = enumField(fields, "monitorMode", ["ongoing"] as const);
  if (!monitorMode.ok) return requestFailureResponse(monitorMode);
  const preferredResolution = resolutionField(fields);
  if (!preferredResolution.ok) return requestFailureResponse(preferredResolution);
  const body = {
    mediaType,
    externalId: externalId.value ?? "",
    title: title.value ?? "",
    posterUrl: posterUrl.value,
    synopsis: synopsis.value,
    rating: rating.value,
    status: status.value,
    monitored: monitored.value,
    fromSeason: fromSeasonInput.value,
    fromEpisode: fromEpisodeInput.value,
    monitorMode: monitorMode.value,
    preferredResolution: preferredResolution.value,
  };

  const isSeries = isSeriesMediaType(body.mediaType);
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
      preferredResolution: body.preferredResolution,
    },
    update: {
      title: body.title,
      // Only overwrite art we actually have. `?? null` here meant re-adding a
      // title from a source with no poster erased the poster already on file.
      ...(art.posterUrl ? { posterUrl: art.posterUrl } : {}),
      ...(art.synopsis ? { synopsis: art.synopsis } : {}),
      ...(art.rating != null ? { rating: art.rating } : {}),
      status: body.status ?? undefined,
      // Re-adding with a season resets the hunt cursor.
      //
      // It does not switch automation on. This used to force `monitored: true`
      // here, so "start from season 2, but let me choose episodes myself" was
      // silently stored as "download season 2 onwards forever" — a start point
      // says *where* to begin, not *whether* to hunt, and the two answers come
      // from two different questions.
      ...(fromSeason != null
        ? {
            fromSeason,
            fromEpisode,
            cursorSeason,
            cursorEpisode,
            nextEpisodeHint,
          }
        : {}),
      ...(body.monitored != null ? { monitored: body.monitored } : {}),
      ...(body.monitorMode ? { monitorMode: body.monitorMode } : {}),
      ...(body.preferredResolution !== undefined
        ? { preferredResolution: body.preferredResolution }
        : {}),
    },
  });

  await promoteLibraryStreamsToKept(session.user.id, {
    watchListItemId: item.id,
    title: item.title,
    mediaType: item.mediaType,
  });

  return NextResponse.json({ item });
}

/**
 * Stop tracking a title. Keep every byte of it.
 *
 * ## What this must not do
 *
 * It must not delete media, and it must not *let* anything else delete media
 * either. The second half is the part that was missing, and it is invisible
 * from here: removing the row is what makes the files reclaimable.
 *
 * `retention-sweep.ts` and `listEvictableStreams` both refuse to reclaim a
 * `stream`-origin torrent while a live `WatchListItem` references it — in the
 * sweep via `watchlistReferences`, in the eviction lister via
 * `liveWatchlistIds`. Every episode the owner *streamed* from this title is
 * such a row. Deleting the library row therefore removed the only thing
 * protecting them, and the next scheduled sweep (every 30 minutes, whenever the
 * cache is over budget) would have been free to unlink files the user had just
 * been promised were safe. Nothing in the delete path would have logged it as
 * anything other than routine cache reclamation.
 *
 * So the promotion runs FIRST and the row is removed second. Ordered that way,
 * a failure anywhere leaves the files kept and the title still tracked, which
 * is the harmless direction. The reverse order has a window — however short —
 * in which the files are unprotected and unreferenced.
 *
 * `promoteLibraryStreamsToKept` is the same helper POST and PATCH already use;
 * there is deliberately no second promotion path to drift from it. Library
 * *downloads* are already `user` origin and were never at risk — this closes
 * the gap for everything the owner watched rather than downloaded.
 *
 * Deleting files is a separate, confirmed, granular operation:
 * `POST /api/library/delete`.
 */
export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = guardBrowserMutation(request);
  if (!origin.ok) return requestFailureResponse(origin);
  const idResult = queryString(request.nextUrl.searchParams, "id", {
    required: true,
    maxLength: 128,
  });
  if (!idResult.ok) return requestFailureResponse(idResult);
  const id = idResult.value ?? "";

  const existing = await prisma.watchListItem.findFirst({
    where: { id, userId: session.user.id },
    select: { id: true, title: true, mediaType: true },
  });
  // Already gone. Report success rather than 404: the user's intent — "this is
  // not in my library" — is satisfied, and a double-click must not look broken.
  if (!existing) return NextResponse.json({ ok: true, filesKept: true });

  await promoteLibraryStreamsToKept(session.user.id, {
    watchListItemId: existing.id,
    title: existing.title,
    mediaType: existing.mediaType,
  });

  await prisma.watchListItem.deleteMany({
    where: { id, userId: session.user.id },
  });

  return NextResponse.json({ ok: true, filesKept: true });
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = await readMutationObject(request);
  if (!parsedBody.ok) return requestFailureResponse(parsedBody);
  const fields = parsedBody.value;
  const id = stringField(fields, "id", { required: true, maxLength: 128 });
  if (!id.ok) return requestFailureResponse(id);
  const status = enumField(
    fields,
    "status",
    ["watching", "planned", "completed", "dropped"] as const,
  );
  if (!status.ok) return requestFailureResponse(status);
  const lastEpisode = stringField(fields, "lastEpisode", {
    nullable: true,
    maxLength: 100,
  });
  if (!lastEpisode.ok) return requestFailureResponse(lastEpisode);
  const monitored = booleanField(fields, "monitored");
  if (!monitored.ok) return requestFailureResponse(monitored);
  const fromSeason = numberField(fields, "fromSeason", {
    nullable: true,
    integer: true,
    min: 1,
    max: 10_000,
  });
  if (!fromSeason.ok) return requestFailureResponse(fromSeason);
  const fromEpisode = numberField(fields, "fromEpisode", {
    nullable: true,
    integer: true,
    min: 1,
    max: 100_000,
  });
  if (!fromEpisode.ok) return requestFailureResponse(fromEpisode);
  const cursorSeason = numberField(fields, "cursorSeason", {
    nullable: true,
    integer: true,
    min: 1,
    max: 10_000,
  });
  if (!cursorSeason.ok) return requestFailureResponse(cursorSeason);
  const cursorEpisode = numberField(fields, "cursorEpisode", {
    nullable: true,
    integer: true,
    min: 1,
    max: 100_000,
  });
  if (!cursorEpisode.ok) return requestFailureResponse(cursorEpisode);
  const monitorMode = enumField(fields, "monitorMode", ["ongoing"] as const);
  if (!monitorMode.ok) return requestFailureResponse(monitorMode);
  const preferredResolution = resolutionField(fields);
  if (!preferredResolution.ok) return requestFailureResponse(preferredResolution);
  const body = {
    id: id.value ?? "",
    status: status.value,
    lastEpisode: lastEpisode.value,
    monitored: monitored.value,
    fromSeason: fromSeason.value,
    fromEpisode: fromEpisode.value,
    cursorSeason: cursorSeason.value,
    cursorEpisode: cursorEpisode.value,
    monitorMode: monitorMode.value,
    preferredResolution: preferredResolution.value,
  };

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
  if (body.preferredResolution !== undefined) {
    data.preferredResolution = body.preferredResolution;
  }

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

  if (updated && body.monitored === true) {
    await promoteLibraryStreamsToKept(session.user.id, {
      watchListItemId: updated.id,
      title: updated.title,
      mediaType: updated.mediaType,
    });
  }

  return NextResponse.json({ item: updated });
}
