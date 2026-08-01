/**
 * POST /api/playback/switch
 *
 * Switch to a release the viewer explicitly chose from the quality selector.
 * Unlike the automatic watchdog, the chooser here is the human, and two rules
 * matter more because of it (see `manualSwitchTo`):
 *
 *  - Playback position is preserved — the response carries `positionSec` so the
 *    player resumes where the viewer was, not at zero.
 *  - The old source is paused, never deleted, so switching is freely reversible.
 *
 * A manual choice is recorded as the current preference, but a later failure
 * still advances automatically. The response is structured state plus its
 * rendered copy from the one presentation seam.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig } from "@/lib/clients";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { preRankKey } from "@/lib/prewarm/prerank";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { describePlayback } from "@/lib/playback/narration";
import { buildManualSwitchDeps } from "@/lib/playback/engine-deps";
import { manualSwitchTo } from "@/lib/playback/swarm-delivery-watchdog";

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
      error: "Manual switching requires the built-in client",
      clientType: config.clientType,
    });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const currentInfoHash = normalizeInfoHash(
    typeof body.currentInfoHash === "string" ? body.currentInfoHash : null,
  );
  const chosenInfoHash = normalizeInfoHash(
    typeof body.chosenInfoHash === "string" ? body.chosenInfoHash : null,
  );
  if (!title || !currentInfoHash || !chosenInfoHash) {
    return json(400, { error: "title, currentInfoHash and chosenInfoHash are required" });
  }

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.trunc(v) : null;

  const target: PreRankTarget = {
    title,
    mediaType: typeof body.mediaType === "string" ? body.mediaType : "tv",
    season: num(body.season),
    episode: num(body.episode),
    preferredResolution: num(body.preferredResolution),
  };
  const contentKey = preRankKey(target);

  try {
    const deps = buildManualSwitchDeps(config, session.user.id);
    const result = await manualSwitchTo(contentKey, currentInfoHash, chosenInfoHash, target, deps);

    if (!result.ok) {
      const status = result.reason === "not-a-candidate" ? 409 : 502;
      return json(status, { ok: false, reason: result.reason });
    }

    return json(200, {
      ok: true,
      infoHash: result.infoHash,
      // Authoritative resume position for the player to seek the new stream to.
      positionSec: result.positionSec,
      narration: result.narration,
      copy: describePlayback(result.narration),
    });
  } catch (err) {
    return json(500, {
      error: "Manual switch failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
