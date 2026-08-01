import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig } from "@/lib/clients";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { preRankKey, releaseInfoHash } from "@/lib/prewarm/prerank";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { describeReleaseShape } from "@/lib/playback/candidates";
import { buildSwarmWatchDeps } from "@/lib/playback/engine-deps";
import {
  ensureSwarmWatchTarget,
  swarmDeliveryTick,
  updateSwarmWatchTarget,
} from "@/lib/playback/swarm-delivery-watchdog";
import type { TorrentResult } from "@/lib/torrents/types";
import {
  readMutationObject,
  requestFailureResponse,
  type RequestResult,
} from "@/lib/http/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params:
    | { infoHash: string }
    | Promise<{ infoHash: string }>;
};

function json(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status });
}

export async function readSelectMutationBody(
  request: Request,
): Promise<RequestResult<Record<string, unknown>>> {
  const parsed = await readMutationObject(request);
  return parsed.ok
    ? { ok: true, value: Object.fromEntries(parsed.value) }
    : parsed;
}

export function prioritizeResolution(
  releases: readonly TorrentResult[],
  preferredResolution: number,
): TorrentResult[] {
  return releases
    .map((release, index) => ({
      release,
      index,
      resolution: describeReleaseShape(release.title).resolution,
    }))
    .sort((a, b) => {
      const aDistance =
        a.resolution == null
          ? Number.POSITIVE_INFINITY
          : Math.abs(a.resolution - preferredResolution);
      const bDistance =
        b.resolution == null
          ? Number.POSITIVE_INFINITY
          : Math.abs(b.resolution - preferredResolution);
      return aDistance - bDistance || a.index - b.index;
    })
    .map(({ release }) => release);
}

export function currentSourceIsBestResolution(
  releases: readonly TorrentResult[],
  currentInfoHash: string,
  preferredResolution: number,
): boolean {
  const current = normalizeInfoHash(currentInfoHash);
  if (!current) return false;
  const best = prioritizeResolution(releases, preferredResolution)[0];
  return best != null && releaseInfoHash(best) === current;
}

export function currentSourceNoopResponse(
  infoHash: string,
  preferredResolution: number,
): Response {
  return json(200, {
    ok: true,
    infoHash,
    preferredResolution,
    noOp: true,
  });
}

export async function POST(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) return json(401, { error: "Not authenticated" });

  const { infoHash: rawInfoHash } = await context.params;
  const infoHash = normalizeInfoHash(rawInfoHash);
  if (!infoHash) return json(404, { error: "Current stream was not found" });

  const parsedBody = await readSelectMutationBody(request);
  if (!parsedBody.ok) return requestFailureResponse(parsedBody);
  const body = parsedBody.value;
  if (
    "infoHash" in body ||
    "currentInfoHash" in body ||
    "chosenInfoHash" in body
  ) {
    return json(400, { error: "Resolution selection cannot pin a release hash" });
  }

  const preferredResolution =
    typeof body.preferredResolution === "number" &&
    [480, 720, 1080, 2160].includes(body.preferredResolution)
      ? body.preferredResolution
      : null;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || preferredResolution == null) {
    return json(400, {
      error: "title and a supported preferredResolution are required",
    });
  }

  const config = await getUserClientConfig(session.user.id);
  if (!config || config.clientType !== "builtin") {
    return json(409, { error: "Automatic selection requires the built-in client" });
  }

  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : null;
  const target: PreRankTarget & {
    preferredResolution?: number | null;
  } = {
    title,
    mediaType: typeof body.mediaType === "string" ? body.mediaType : "tv",
    year: number(body.year),
    season: number(body.season),
    episode: number(body.episode),
    preferredResolution,
  };
  const contentKey = preRankKey(target);
  const deps = buildSwarmWatchDeps(config, session.user.id);
  const rankedResults = deps.rankedResults;
  const preferredResults = prioritizeResolution(
    await rankedResults(target),
    preferredResolution,
  );
  deps.rankedResults = async (nextTarget) =>
    preRankKey(nextTarget) === contentKey
      ? preferredResults
      : prioritizeResolution(
          await rankedResults(nextTarget),
          preferredResolution,
        );

  if (!updateSwarmWatchTarget(contentKey, target)) {
    ensureSwarmWatchTarget(contentKey, infoHash, target);
  }
  if (
    currentSourceIsBestResolution(
      preferredResults,
      infoHash,
      preferredResolution,
    )
  ) {
    return currentSourceNoopResponse(infoHash, preferredResolution);
  }
  const result = await swarmDeliveryTick(contentKey, infoHash, target, deps, {
    cause: "playability",
    force: true,
  });
  if (!result.switched) {
    return json(409, {
      ok: false,
      exhausted: result.exhausted,
      message: "No playable version is available at that quality.",
    });
  }
  return json(200, {
    ok: true,
    infoHash: result.currentHash,
    preferredResolution,
  });
}
