/**
 * GET /api/subtitles/[infoHash]?filePath=…            → the track list
 * GET /api/subtitles/[infoHash]?filePath=…&track=id   → that track as WebVTT
 *
 * Two deliberate properties:
 *
 * - **Listing is free.** It reads the `MediaProbe` row the playback plan
 *   already wrote and the torrent's own file index; neither touches the swarm.
 *   Only if no probe exists does it run one, bounded by `-probesize`, over head
 *   bytes the player has already downloaded.
 * - **Content is only produced when a viewer picks a track.** An embedded
 *   subtitle stream is interleaved through the container, so extracting it
 *   demuxes the whole file. Nothing does that speculatively.
 *
 * A track that cannot become WebVTT (image-based PGS/VobSub/DVB) is listed as
 * unsupported and has no content URL. Serving it would hand the browser bytes
 * it renders as nothing, which is indistinguishable from "this release has no
 * subtitles" — a lie in the same family as a buffer band that does not match
 * the buffer.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig, type ClientConnectionConfig } from "@/lib/clients";
import {
  acquireBuiltinStreamLease,
  findLiveBuiltinTorrentFile,
  type BuiltinStreamFile,
} from "@/lib/clients/builtin-engine";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import {
  probeUrl,
  requestOrigin,
  streamUrl,
  type ProbeStream,
} from "@/lib/media/probe";
import {
  buildSubtitleTracks,
  parseSubtitleTrackId,
  shiftVttCues,
  subtitleTrackSrc,
  type SubtitleTrack,
} from "@/lib/media/subtitles";
import { selectDefaultSubtitle, selectPreferredAudioStream } from "@/lib/media/decide";
import {
  MAX_SUBTITLE_BYTES,
  cacheSidecarVtt,
  convertSidecarSubtitle,
  extractEmbeddedSubtitle,
  readCachedSubtitle,
} from "@/lib/media/extract-subtitles";
import prisma from "@/lib/prisma";
import { markForegroundActive } from "@/lib/prewarm/foreground";
import {
  getCompletedMediaManifest,
  resolveCompletedMediaFile,
} from "@/lib/library/completed-media";
import { readDiskFileByPath } from "@/lib/clients/disk-fastpath";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".ts", ".m2ts", ".mpg", ".mpeg",
]);

function isVideoPath(p: string): boolean {
  const name = p.replace(/\\/g, "/").split("/").pop() ?? p;
  const dot = name.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function json(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status });
}

function vttResponse(vtt: string, method: string): Response {
  const bytes = new TextEncoder().encode(vtt);
  return new Response(method === "HEAD" ? null : bytes, {
    status: 200,
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Content-Length": String(bytes.length),
      // Extraction is expensive and the content never changes for a given
      // torrent file, so let the browser keep it for the tab's lifetime.
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** Read a whole (small) torrent file. Sidecars are KB, not GB. */
async function readTorrentFile(file: BuiltinStreamFile): Promise<Uint8Array | null> {
  if (file.length > MAX_SUBTITLE_BYTES) return null;
  const reader = file.stream({ start: 0, end: Math.max(file.length - 1, 1) }).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.length;
      if (total > MAX_SUBTITLE_BYTES) return null;
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.subarray(0, Math.min(file.length, total));
}

/** The probe's streams, from the cache the plan route writes when it can. */
async function cachedProbeStreams(
  infoHash: string,
  filePath: string,
): Promise<ProbeStream[] | null> {
  try {
    const row = await prisma.mediaProbe.findUnique({
      where: { infoHash_filePath: { infoHash, filePath } },
    });
    if (!row?.streamsJson) return null;
    const parsed = JSON.parse(row.streamsJson) as ProbeStream[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function handleSubtitlesRequest(
  request: Request,
  params: { infoHash: string },
): Promise<Response> {
  const infoHash = normalizeInfoHash(params.infoHash);
  const url = new URL(request.url);
  const filePath = (url.searchParams.get("filePath") ?? "").replace(/\\/g, "/").trim();
  const trackId = url.searchParams.get("track");

  if (!infoHash || !filePath) {
    return json(400, { error: "infoHash and filePath are required" });
  }
  if (filePath.split("/").some((s) => s === "." || s === "..")) {
    return json(400, { error: "Invalid file path" });
  }

  const session = await auth();
  if (!session?.user?.id) return json(401, { error: "Not authenticated" });
  const config = await getUserClientConfig(session.user.id);
  if (!config) return json(503, { error: "No torrent client configured" });
  const completedManifest = await getCompletedMediaManifest(
    session.user.id,
    infoHash,
  );
  let files: Array<{ path: string }>;
  if (completedManifest) {
    files = completedManifest.files.map((file) => ({
      path: file.relativePath,
    }));
  } else {
    if (config.clientType !== "builtin") {
      return json(409, {
        error: "Subtitles require the built-in client",
        message:
          "This title is not available as completed local media. Switch Settings → Built-in to inspect an active torrent.",
        clientType: config.clientType,
      });
    }
    const lookup = await findLiveBuiltinTorrentFile(config, infoHash);
    if (lookup.status === "not_found") return json(404, { error: "Torrent not found" });
    if (lookup.status === "metadata_pending") {
      return json(425, {
        error: "Torrent metadata is not ready yet",
        message: "The torrent is still fetching metadata; try again in a moment.",
      });
    }
    files = (lookup.torrent.files ?? []).map((f) => ({
      path: f.path.replace(/\\/g, "/"),
    }));
  }
  const soleVideo = files.filter((f) => isVideoPath(f.path)).length === 1;

  // ── Content: one track, as WebVTT ──
  if (trackId) {
    const rawOffset = Number(url.searchParams.get("offset") ?? "0");
    const offsetSec =
      Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(rawOffset, 24 * 3600) : 0;
    return serveTrack({
      request,
      config,
      userId: session.user.id,
      infoHash,
      filePath,
      trackId,
      files,
      soleVideo,
      origin: requestOrigin(request),
      offsetSec,
    });
  }

  // ── List ──
  let streams = await cachedProbeStreams(infoHash, filePath);
  let probeError: string | null = null;
  if (!streams) {
    // Bounded by -probesize/-analyzeduration, over head bytes the player has
    // already pulled — this is the same read the plan route performs, not a new
    // demand on the swarm.
    const outcome = await probeUrl(streamUrl(infoHash, filePath, requestOrigin(request)));
    if (outcome.ok) streams = outcome.result.streams;
    else probeError = outcome.error.error;
  }

  const tracks = buildSubtitleTracks({
    probeStreams: streams ?? undefined,
    files,
    videoPath: filePath,
    soleVideo,
  });

  // Default-subtitle decision, server-side, so an English viewer on foreign
  // audio never lands on a silent "Off". Uses the same auto audio selection the
  // playback plan does, then picks a default English subtitle from the same
  // track list the client is about to receive (ids match exactly).
  const audioStreamList = (streams ?? []).filter((s) => s.codecType === "audio");
  const selectedAudio = selectPreferredAudioStream(audioStreamList);
  const subtitleDefault = selectDefaultSubtitle(
    selectedAudio?.language ?? null,
    tracks.map((t) => ({
      id: t.id,
      language: t.language,
      forced: t.forced,
      supported: t.supported,
    })),
  );

  return NextResponse.json({
    tracks: tracks.map((track) => withSrc(track, infoHash, filePath)),
    /**
     * Track id the player should auto-enable on load, or null to stay Off.
     * `noEnglishAvailable` lets the UI say "no English subtitles available"
     * instead of silently sitting on Off when foreign audio has no English sub.
     */
    defaultTrackId: subtitleDefault.defaultTrackId,
    subtitleDefault,
    /**
     * Honest about what could not be inspected: with no probe there may be
     * embedded tracks we simply have not seen. An empty list is not the same as
     * "there are none".
     */
    embeddedInspected: streams !== null,
    probeError,
  });
}

function withSrc(track: SubtitleTrack, infoHash: string, filePath: string) {
  return {
    ...track,
    src: track.supported ? subtitleTrackSrc(infoHash, filePath, track.id) : null,
  };
}

async function serveTrack(input: {
  request: Request;
  config: ClientConnectionConfig;
  userId: string;
  infoHash: string;
  filePath: string;
  trackId: string;
  files: Array<{ path: string }>;
  soleVideo: boolean;
  origin: string;
  /**
   * Source position the caller's media timeline starts at. Cues are cached in
   * source time and rebased here, so one extraction serves every seek offset.
   */
  offsetSec: number;
}): Promise<Response> {
  const {
    request,
    config,
    userId,
    infoHash,
    filePath,
    trackId,
    origin,
    offsetSec,
  } = input;
  const parsed = parseSubtitleTrackId(trackId);
  if (!parsed) return json(400, { error: "Unknown subtitle track" });
  const rebase = (vtt: string) => shiftVttCues(vtt, -offsetSec);

  // Subtitle bytes deliberately count as foreground. They are not video bytes,
  // but they are served only because a human is watching this torrent, and the
  // work behind them can touch the same torrent, disk and ffmpeg budget as the
  // picture. The track-list endpoint above does not mark foreground; this body
  // endpoint does.
  const cached = readCachedSubtitle(infoHash, filePath, trackId);
  if (cached) {
    if (request.method !== "HEAD") markForegroundActive(infoHash);
    return vttResponse(rebase(cached), request.method);
  }

  if (parsed.kind === "sidecar") {
    // Only a file this video actually owns may be served — the track id comes
    // from the client, so it is a request, not a fact.
    const allowed = buildSubtitleTracks({
      files: input.files,
      videoPath: filePath,
      soleVideo: input.soleVideo,
    }).some((t) => t.id === trackId);
    if (!allowed) return json(404, { error: "Subtitle file not found for this video" });

    const persisted = await resolveCompletedMediaFile(
      userId,
      infoHash,
      parsed.filePath,
    );
    const bytes = persisted
      ? await readDiskFileByPath(
          persisted.path,
          persisted.length,
          persisted.mtimeMs,
          MAX_SUBTITLE_BYTES,
          persisted.rootPath,
        )
      : await (async () => {
          const found = await findLiveBuiltinTorrentFile(
            config,
            infoHash,
            parsed.filePath,
          );
          if (found.status !== "found") return null;
          const release = acquireBuiltinStreamLease(infoHash);
          try {
            return await readTorrentFile(found.file);
          } finally {
            release();
          }
        })();
    if (!bytes) {
      return json(503, {
        error: "Could not read the subtitle file",
        message: "The torrent did not deliver the subtitle file. Try again in a moment.",
      });
    }
    const ext = (parsed.filePath.split(".").pop() ?? "").toLowerCase();
    const converted = await convertSidecarSubtitle({ bytes, extension: ext });
    if (!converted.ok) {
      return json(converted.error === "timeout" ? 504 : 422, {
        error: "Could not convert the subtitle file",
        message: converted.message,
      });
    }
    cacheSidecarVtt(infoHash, filePath, trackId, converted.vtt);
    if (request.method !== "HEAD") markForegroundActive(infoHash);
    return vttResponse(rebase(converted.vtt), request.method);
  }

  // Embedded: the stream must exist *and* be text-based. An image-based track
  // has no WebVTT form, and answering with an empty file would render as
  // "subtitles are on and say nothing".
  const streams = await cachedProbeStreams(infoHash, filePath);
  if (streams) {
    const known = buildSubtitleTracks({ probeStreams: streams, videoPath: filePath }).find(
      (t) => t.id === trackId,
    );
    if (!known) return json(404, { error: "Subtitle track not found" });
    if (!known.supported) {
      return json(422, {
        error: "Unsupported subtitle track",
        message: known.unsupportedReason ?? "this track cannot be converted to WebVTT",
      });
    }
  }

  const outcome = await extractEmbeddedSubtitle({
    infoHash,
    filePath,
    streamIndex: parsed.streamIndex,
    sourceUrl: streamUrl(infoHash, filePath, origin),
  });
  if (!outcome.ok) {
    const status = outcome.error === "timeout" ? 504 : outcome.error === "empty" ? 422 : 503;
    return json(status, {
      error:
        outcome.error === "timeout"
          ? "Subtitle extraction timed out"
          : outcome.error === "empty"
            ? "That track contains no cues"
            : "Could not extract that subtitle track",
      message: outcome.message,
    });
  }
  if (request.method !== "HEAD") markForegroundActive(infoHash);
  return vttResponse(rebase(outcome.vtt), request.method);
}

type RouteContext = { params: { infoHash: string } | Promise<{ infoHash: string }> };

export async function GET(request: Request, context: RouteContext) {
  return handleSubtitlesRequest(request, await context.params);
}

export async function HEAD(request: Request, context: RouteContext) {
  return handleSubtitlesRequest(request, await context.params);
}
