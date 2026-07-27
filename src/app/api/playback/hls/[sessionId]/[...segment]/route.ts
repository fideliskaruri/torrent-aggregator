/**
 * GET /api/playback/hls/[sessionId]/[...segment]
 *
 * Serves HLS manifests and fMP4 segments from active ffmpeg sessions — the
 * *incomplete torrent* path, where the timeline genuinely does not exist yet
 * and the playlist grows as ffmpeg produces. Completed files are served by
 * /api/playback/vod/[vodId]/[...file] instead, which does not restart anything
 * on a seek.
 *
 * Files are streamed, never `readFileSync`'d: a 4-second fMP4 segment of a 4K
 * HEVC remux is tens of megabytes, and reading it synchronously blocks the same
 * event loop that is feeding ffmpeg from the torrent — the transcode starves
 * itself while the server serves its own output.
 */
import { NextResponse } from "next/server";
import {
  contentTypeForSegment,
  parseSegmentRange,
  resolveWithinSessionDir,
  serveFileRange,
} from "@/lib/media/http-range";
import {
  getSessionById,
  waitForSessionFile,
  installSessionCleanup,
} from "@/lib/media/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Re-exported: these were part of this route's surface before the byte-range
// serving was shared with the VOD route, and they describe how it answers.
export { contentTypeForSegment, parseSegmentRange, resolveWithinSessionDir };
export type { ParsedRange } from "@/lib/media/http-range";

type RouteParams = {
  sessionId: string;
  segment?: string[];
};

type RouteContext = {
  params: RouteParams | Promise<RouteParams>;
};

/** How long to wait for a segment ffmpeg has not written yet. */
const SEGMENT_WAIT_MS = 20_000;

export async function GET(request: Request, context: RouteContext) {
  installSessionCleanup();

  const params = await context.params;
  const { sessionId } = params;
  const segmentParts = params.segment ?? [];

  const session = getSessionById(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const filename = segmentParts.length > 0 ? segmentParts.join("/") : "playlist.m3u8";
  const resolved = resolveWithinSessionDir(session.outputDir, filename);
  if (!resolved) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // A session that failed before writing anything has nothing to serve, but one
  // that stalled part way still has real segments the player can finish.
  const exists = await waitForSessionFile(session, resolved, SEGMENT_WAIT_MS);
  if (!exists) {
    if (session.state === "error" || session.state === "stalled") {
      return NextResponse.json(
        { error: "Session failed", state: session.state, message: session.error },
        { status: 503 },
      );
    }
    if (filename.endsWith(".m3u8")) {
      return NextResponse.json(
        { error: "Session is still starting, try again shortly", state: session.state },
        { status: 202 },
      );
    }
    return NextResponse.json({ error: "Segment not found" }, { status: 404 });
  }

  const isManifest = filename.endsWith(".m3u8");
  return serveFileRange(resolved, filename, request.headers.get("range"), {
    cacheControl: isManifest
      ? "no-cache, no-store, must-revalidate" // an EVENT playlist grows; never cache it
      : "private, max-age=31536000, immutable",
    bodyless: request.method === "HEAD",
  });
}

export async function HEAD(request: Request, context: RouteContext) {
  return GET(request, context);
}
