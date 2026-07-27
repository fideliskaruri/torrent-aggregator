/**
 * GET /api/playback/vod/[vodId]/[...file]
 *
 * Serves playback for files that are already 100% on local disk.
 *
 * The difference from the session route is the whole point of this module: the
 * playlist here is `#EXT-X-PLAYLIST-TYPE:VOD` with an `#EXT-X-ENDLIST`, so the
 * player knows the entire timeline at t=0. A seek is a segment fetch — no new
 * session key, no new ffmpeg with `-ss`, no playlist rebased to zero, and so
 * nothing for hls.js to tear down and reload. That reload is what the viewer
 * experiences as a stutter when scrubbing a file that is already downloaded.
 *
 * Two shapes come through here:
 *
 *   whole-file    playlist.m3u8 + data.m4s  (one background ffmpeg pass; every
 *                 segment is a byte range of the single file)
 *   vod-segments  playlist.m3u8 + init.mp4 + segNNNNN.m4s (each segment made by
 *                 a short-lived ffmpeg the first time it is asked for)
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import { auth } from "@/lib/auth";
import { resolveWithinSessionDir, serveFileRange } from "@/lib/media/http-range";
import {
  ensureInit,
  ensureSegment,
  getVodEntry,
  parseSegmentIndex,
  type VodEntry,
} from "@/lib/media/vod-runtime";
import { trimVodPlaylist, WHOLE_FILE_DATA, WHOLE_FILE_PLAYLIST } from "@/lib/media/vod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = {
  vodId: string;
  file?: string[];
};

type RouteContext = {
  params: RouteParams | Promise<RouteParams>;
};

function json(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status });
}

type Located =
  | { ok: true; absolutePath: string }
  | { ok: false; status: number; message: string };

/**
 * Resolve a requested name to a file on disk, producing it if the strategy
 * makes segments on demand.
 */
async function locate(entry: VodEntry, filename: string): Promise<Located> {
  const resolved = resolveWithinSessionDir(entry.dir, filename);
  if (!resolved) return { ok: false, status: 400, message: "Invalid path" };

  if (entry.strategy === "whole-file") {
    // Nothing is made on demand here: either the conversion finished and every
    // byte is on disk, or the caller should still be on the session path.
    if (entry.status !== "ready") {
      return {
        ok: false,
        status: entry.status === "error" ? 503 : 202,
        message: entry.error ?? "Conversion is still running",
      };
    }
    if (filename !== WHOLE_FILE_PLAYLIST && filename !== WHOLE_FILE_DATA) {
      return { ok: false, status: 404, message: "Not part of this conversion" };
    }
    return fs.existsSync(resolved)
      ? { ok: true, absolutePath: resolved }
      : { ok: false, status: 404, message: "Not found" };
  }

  if (filename === WHOLE_FILE_PLAYLIST) {
    // A segment entry publishes its playlist only once the source's keyframe
    // index has been read, so "still preparing" is a real state here and 202
    // is the honest answer — the caller is meanwhile watching on the session
    // path and will be handed this entry on its next plan request.
    if (entry.status !== "ready") {
      return {
        ok: false,
        status: entry.status === "error" ? 503 : 202,
        message: entry.error ?? "Preparing the timeline",
      };
    }
    return fs.existsSync(resolved)
      ? { ok: true, absolutePath: resolved }
      : { ok: false, status: 404, message: "Playlist missing" };
  }
  if (filename === "init.mp4") {
    const init = await ensureInit(entry);
    return init.ok
      ? { ok: true, absolutePath: init.absolutePath }
      : { ok: false, status: init.status, message: init.message };
  }
  const index = parseSegmentIndex(filename);
  if (index === null) return { ok: false, status: 404, message: "Not found" };
  const segment = await ensureSegment(entry, index);
  return segment.ok
    ? { ok: true, absolutePath: segment.absolutePath }
    : { ok: false, status: segment.status, message: segment.message };
}

export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) return json(401, { error: "Not authenticated" });

  const params = await context.params;
  const parts = params.file ?? [];
  const filename = parts.length > 0 ? parts.join("/") : WHOLE_FILE_PLAYLIST;

  const entry = getVodEntry(params.vodId);
  if (!entry) return json(404, { error: "Not found" });

  const located = await locate(entry, filename);
  if (!located.ok) {
    return json(located.status, { error: located.message, state: entry.status });
  }

  // `?from=` trims the playlist so media time zero *is* the seek target. The
  // player always attaches hls.js at position zero, so a mid-watch switch from
  // the session path to this one would otherwise throw the seek away and
  // restart the file. The plan route computes the same trim to report the
  // matching timeline offset, so the two cannot disagree.
  if (filename === WHOLE_FILE_PLAYLIST) {
    const from = Number(new URL(request.url).searchParams.get("from") ?? "0");
    if (Number.isFinite(from) && from > 0) {
      let raw: string;
      try {
        raw = fs.readFileSync(located.absolutePath, "utf8");
      } catch {
        return json(404, { error: "Playlist missing" });
      }
      const { text } = trimVodPlaylist(raw, from);
      return new Response(request.method === "HEAD" ? null : text, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      });
    }
  }

  // Everything served here is immutable once written: a VOD playlist never
  // changes, and neither does a produced segment. That is what makes scrubbing
  // back through already-watched material free.
  return serveFileRange(located.absolutePath, filename, request.headers.get("range"), {
    cacheControl: "private, max-age=31536000, immutable",
    bodyless: request.method === "HEAD",
  });
}

export async function HEAD(request: Request, context: RouteContext) {
  return GET(request, context);
}
