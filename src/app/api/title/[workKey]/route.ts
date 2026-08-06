import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { buildTitleDetail } from "./detail";
import { grabForTitle, grabSeasonForTitle } from "./grab";
import type { TitleGrabRequest } from "@/components/title/types";
import {
  readMutationObject,
  type RequestResult,
} from "@/lib/http/request";
import {
  acquisitionTargetKey,
  validateAcquisitionScope,
} from "./acquisition-target";
import { resolveTitleProviderIdentity } from "./provider-identity";

export const dynamic = "force-dynamic";

type RouteParams = {
  workKey: string;
};

type RouteContext = {
  params: RouteParams | Promise<RouteParams>;
};

export async function readTitleMutationBody(
  request: Request,
): Promise<RequestResult<TitleGrabRequest>> {
  const parsed = await readMutationObject(request);
  return parsed.ok
    ? {
        ok: true,
        value: Object.fromEntries(parsed.value) as TitleGrabRequest,
      }
    : parsed;
}

/**
 * Everything one title page needs, in one round trip.
 *
 * Reads only local state — engine rows, playback progress, library rows,
 * cached catalog metadata and the existing search cache — so the page paints
 * immediately. **No indexer is contacted here.** A live search is an action
 * the user takes (`POST`), never a precondition for the page appearing; a
 * spinner blocked on a tracker is the failure mode this route exists to avoid.
 *
 * The optional query parameters carry what the linking card already knew, for
 * the case where the work is in no local table yet:
 *
 *   `t`    title        `y`  year
 *   `type` media type   `s`  season to open on
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

  const url = new URL(request.url);

  try {
    const providerResult = await resolveTitleProviderIdentity(
      url.searchParams,
      decodeSegment(workKey),
    );
    if (providerResult.kind === "invalid") {
      return NextResponse.json(
        { error: providerResult.reason },
        { status: 400 },
      );
    }
    const payload = await buildTitleDetail({
      userId: session.user.id,
      workKey: decodeSegment(workKey),
      title: url.searchParams.get("t"),
      year: intParam(url.searchParams.get("y")),
      mediaType: url.searchParams.get("type"),
      season: intParam(url.searchParams.get("s")),
      providerIdentity:
        providerResult.kind === "verified" || providerResult.kind === "carried"
          ? providerResult.identity
          : null,
    });
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[title]", err);
    return NextResponse.json(
      {
        error: "Failed to build title payload",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

/**
 * Download — one press, no release table.
 *
 * The client sends at most a season and an episode. Everything that decides
 * *what* gets grabbed (the title, the media type, whether this is a series,
 * which library row to advance) is re-derived server-side from the same
 * `buildTitleDetail` the page rendered from, because a client that can name
 * its own search query is a client that can grab the wrong film.
 */
export async function POST(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workKey } = await context.params;
  if (!workKey?.trim()) {
    return NextResponse.json({ error: "Missing work key" }, { status: 400 });
  }

  const parsedBody = await readTitleMutationBody(request);
  if (!parsedBody.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: parsedBody.error,
        message: parsedBody.error,
        ...(parsedBody.field ? { field: parsedBody.field } : {}),
      },
      { status: parsedBody.status },
    );
  }
  const body = parsedBody.value;

  const scope = validateAcquisitionScope(body);
  if (!scope.ok) {
    return NextResponse.json(
      { ok: false, message: scope.message },
      { status: 400 },
    );
  }

  const preferredResolution =
    body.preferredResolution == null
      ? null
      : [480, 720, 1080, 2160].includes(body.preferredResolution)
        ? body.preferredResolution
        : null;
  if (
    body.preferredResolution != null &&
    preferredResolution == null
  ) {
    return NextResponse.json(
      {
        ok: false,
        message: "Preferred resolution must be 480p, 720p, 1080p, or 2160p.",
      },
      { status: 400 },
    );
  }

  const key = decodeSegment(workKey);
  const targetKey = acquisitionTargetKey(
    key,
    scope.scope,
    scope.season,
    scope.episode,
  );
  const trackTransfer = (body.retention ?? "keep") === "keep";

  try {
    const detail = await buildTitleDetail({
      userId: session.user.id,
      workKey: key,
      title: body.title ?? null,
      year: body.year ?? null,
      mediaType: body.mediaType ?? null,
    });

    if (trackTransfer) {
      await prisma.acquisitionTarget.upsert({
        where: {
          userId_targetKey: {
            userId: session.user.id,
            targetKey,
          },
        },
        create: {
          userId: session.user.id,
          targetKey,
          workKey: key,
          scope: scope.scope,
          season: scope.season,
          episode: scope.episode,
          preferredResolution,
          status: "queued",
        },
        update: {
          preferredResolution,
          status: "queued",
          progress: 0,
          infoHash: null,
          filePath: null,
          error: null,
        },
      });
    }

    const input = {
      userId: session.user.id,
      workKey: key,
      season: scope.season,
      episode: scope.episode,
      preferredResolution,
      retention: body.retention ?? "keep",
      // The owner's informed decision to exceed their own cap. Only ever
      // honoured for the cap — never the free-space floor.
      overrideStorageCap: body.overrideStorageCap === true,
      resolvedTitle: detail.title,
      resolvedMediaType: detail.mediaType,
      isSeries: detail.isSeries,
      watchListItemId: detail.library.watchListItemId,
    };

    const result =
      scope.scope === "season"
        ? await grabSeasonForTitle({
            ...input,
            season: scope.season,
            episodes: body.episodes ?? [],
            seasonComplete: body.seasonComplete,
          })
        : await grabForTitle(input);

    if (trackTransfer) {
      await prisma.acquisitionTarget.update({
        where: {
          userId_targetKey: {
            userId: session.user.id,
            targetKey,
          },
        },
        data: result.ok
          ? {
              status: "downloading",
              infoHash: "infoHash" in result ? result.infoHash ?? null : null,
              error: null,
            }
          : {
              status: "failed",
              error: result.message,
            },
      });
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (err) {
    console.error("[title:grab]", err);
    if (trackTransfer) {
      await prisma.acquisitionTarget
        .update({
          where: {
            userId_targetKey: {
              userId: session.user.id,
              targetKey,
            },
          },
          data: {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          },
        })
        .catch(() => undefined);
    }
    return NextResponse.json(
      {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

/** Path segments arrive percent-encoded for non-Latin slugs. */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function intParam(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
