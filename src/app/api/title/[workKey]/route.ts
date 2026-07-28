import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildTitleDetail } from "./detail";
import { grabForTitle, grabSeasonForTitle } from "./grab";
import type { TitleGrabRequest } from "@/components/title/types";

export const dynamic = "force-dynamic";

type RouteParams = {
  workKey: string;
};

type RouteContext = {
  params: RouteParams | Promise<RouteParams>;
};

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
    const payload = await buildTitleDetail({
      userId: session.user.id,
      workKey: decodeSegment(workKey),
      title: url.searchParams.get("t"),
      year: intParam(url.searchParams.get("y")),
      mediaType: url.searchParams.get("type"),
      season: intParam(url.searchParams.get("s")),
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

  let body: TitleGrabRequest = {};
  try {
    body = (await request.json()) as TitleGrabRequest;
  } catch {
    // An empty body is a whole-title grab, which is a legitimate request.
  }

  try {
    const key = decodeSegment(workKey);
    const detail = await buildTitleDetail({
      userId: session.user.id,
      workKey: key,
      title: body.title ?? null,
      year: body.year ?? null,
      mediaType: body.mediaType ?? null,
    });

    const input = {
      userId: session.user.id,
      workKey: key,
      season: body.season ?? null,
      episode: body.episode ?? null,
      retention: body.retention ?? "keep",
      resolvedTitle: detail.title,
      resolvedMediaType: detail.mediaType,
      isSeries: detail.isSeries,
      watchListItemId: detail.library.watchListItemId,
    };

    const result =
      body.mode === "season"
        ? await grabSeasonForTitle({
            ...input,
            season: body.season ?? 0,
            episodes: body.episodes ?? [],
            retention: body.retention ?? "keep",
          })
        : await grabForTitle(input);

    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (err) {
    console.error("[title:grab]", err);
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
