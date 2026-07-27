/**
 * POST /api/playback/failover
 *
 * The play-time watchdog tick. The client polls this while a source is starting
 * or playing; the server samples the live transfer, judges it against the stall
 * rule, and — only when the source is genuinely dead — fails over to the next
 * untried release of the same content, abandoning (pausing, not deleting) the
 * stalled one.
 *
 * The response is **structured playback state** plus its rendered copy from the
 * single presentation seam. The engine never writes the words; `describePlayback`
 * does, so the UI can render an honest "this source stalled, trying another" or
 * a terminal "no working source" instead of a bare spinner. See `narration.ts`
 * and commit `badaf94`.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig } from "@/lib/clients";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { preRankKey } from "@/lib/prewarm/prerank";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { describePlayback } from "@/lib/playback/narration";
import { buildWatchdogDeps } from "@/lib/playback/engine-deps";
import { watchdogTick } from "@/lib/playback/watchdog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return json(401, { error: "Not authenticated" });

  const config = await getUserClientConfig(session.user.id);
  if (!config) return json(503, { error: "No torrent client configured" });
  if (config.clientType !== "builtin") {
    return json(409, {
      error: "Play-time failover requires the built-in client",
      clientType: config.clientType,
    });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const infoHash = normalizeInfoHash(
    typeof body.infoHash === "string" ? body.infoHash : null,
  );
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!infoHash || !title) {
    return json(400, { error: "infoHash and title are required" });
  }

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.trunc(v) : null;

  const target: PreRankTarget = {
    title,
    mediaType: typeof body.mediaType === "string" ? body.mediaType : "tv",
    season: num(body.season),
    episode: num(body.episode),
  };
  const contentKey = preRankKey(target);

  try {
    const deps = buildWatchdogDeps(config);
    const result = await watchdogTick(contentKey, infoHash, target, deps);
    return json(200, {
      // Structured facts — the source of truth for the client.
      narration: result.narration,
      // Rendered by the one presentation seam, for direct display.
      copy: describePlayback(result.narration),
      currentHash: result.currentHash,
      switched: result.switched,
      exhausted: result.exhausted,
      stall: {
        stalled: result.verdict.stalled,
        reason: result.verdict.reason,
        deliveredBytes: result.verdict.deliveredBytes,
        windowMs: result.verdict.windowMs,
      },
    });
  } catch (err) {
    return json(500, {
      error: "Failover tick failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
