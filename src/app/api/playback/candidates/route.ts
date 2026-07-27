/**
 * POST /api/playback/candidates
 *
 * Lists the alternative releases for a piece of content — the data behind the
 * quality selector. Same {@link PreRankTarget} body as the failover route, but
 * this endpoint *lists and annotates* rather than *decides*: it returns every
 * candidate from the shared ranked pool with its quality shape (resolution,
 * source, codec, audio, size, seeders), a flag for the one currently playing,
 * and its cached swarm verdict.
 *
 * It only ever reads cached verdicts — never probes — because it is on the UI's
 * latency path. An unmeasured release reads `unknown` and is listed normally;
 * `unknown` is not `dead`. See `candidates.ts`.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { listCandidates } from "@/lib/playback/candidates";
import { loadSwarmVerdicts } from "@/lib/torrents/swarm-probe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return json(401, { error: "Not authenticated" });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return json(400, { error: "title is required" });

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.trunc(v) : null;

  const target: PreRankTarget = {
    title,
    mediaType: typeof body.mediaType === "string" ? body.mediaType : "tv",
    season: num(body.season),
    episode: num(body.episode),
  };

  const currentInfoHash = normalizeInfoHash(
    typeof body.currentInfoHash === "string" ? body.currentInfoHash : null,
  );

  try {
    const candidates = await listCandidates(target, {
      currentInfoHash,
      // The measured verdicts live in the DB; read them here rather than letting
      // every candidate default to `unknown`. This is a cached read only — the
      // probe runs on its own schedule, never on this UI-latency path.
      readVerdicts: (hashes) => loadSwarmVerdicts(hashes),
    });
    return json(200, { candidates });
  } catch (err) {
    return json(500, {
      error: "Could not list candidates",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
