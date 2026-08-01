/**
 * POST /api/playback/plan
 *
 * The client sends its codec capabilities; the server probes the file (cached),
 * runs the decision engine, and returns the playback plan plus the URL to play.
 * For direct playback the URL is the existing byte-range stream endpoint. For
 * remux/transcode it starts an ffmpeg session and returns the HLS manifest URL.
 *
 * ## Why probing still goes over loopback HTTP
 *
 * ffprobe and ffmpeg need a *seekable* source. Reading the file in-process and
 * piping it to stdin would work for a linear read and break everything else:
 * MKV keeps its Cues at the tail, so ffprobe seeks backwards on the very first
 * open, and `-ss` seeking depends on byte-range jumps. Piping would turn every
 * seek into a full re-read of the torrent.
 *
 * The deadlock the loopback hop was suspected of does not exist here. The
 * stream route is fully async — it awaits WebTorrent reads and never blocks the
 * event loop — and `auth()` is a local no-op that does not need a cookie, so the
 * self-request authenticates like any other. Node serves the probe's range
 * requests concurrently with the request that started it.
 *
 * What *was* real is the cost of guessing the origin: the hop is only safe
 * because the origin now comes from the incoming request instead of a hardcoded
 * port 3000, and because the probe is bounded by `-rw_timeout` + an execFile
 * timeout so a cold torrent cannot hold the request open indefinitely.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig } from "@/lib/clients";
import { parseCapabilities } from "@/lib/media/capabilities";
import {
  probeUrl,
  streamUrl,
  requestOrigin,
  normalizeContainer,
  type ProbeResult,
} from "@/lib/media/probe";
import { decidePlayback } from "@/lib/media/decide";
import {
  getOrCreateSession,
  installSessionCleanup,
  SEGMENT_SECONDS,
} from "@/lib/media/session";
import { resolveCompleteLocalFile } from "@/lib/media/local-file";
import { chooseStrategy, trimVodPlaylist, WHOLE_FILE_PLAYLIST } from "@/lib/media/vod";
import { playlistPath, prepareVod } from "@/lib/media/vod-runtime";
import fs from "node:fs";
import prisma from "@/lib/prisma";
import {
  numberField,
  objectField,
  readMutationObject,
  requestFailureResponse,
  stringField,
} from "@/lib/http/request";
import { normalizeInfoHash } from "@/lib/torrents/infohash";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status });
}

/** Try to load a cached probe result from the database. */
async function getCachedProbe(infoHash: string, filePath: string): Promise<ProbeResult | null> {
  try {
    const cached = await prisma.mediaProbe.findUnique({
      where: { infoHash_filePath: { infoHash, filePath } },
    });
    if (!cached?.streamsJson) return null;
    const streams = JSON.parse(cached.streamsJson);
    return {
      container: cached.container ?? "unknown",
      duration: cached.durationSec,
      streams,
    };
  } catch {
    return null;
  }
}

/** Save a probe result to the database. Returns true on a successful write. */
async function cacheProbe(infoHash: string, filePath: string, result: ProbeResult): Promise<boolean> {
  const video = result.streams.find((s) => s.codecType === "video");
  const audio = result.streams.find((s) => s.codecType === "audio");
  try {
    await prisma.mediaProbe.upsert({
      where: { infoHash_filePath: { infoHash, filePath } },
      create: {
        infoHash,
        filePath,
        container: result.container,
        durationSec: result.duration,
        videoCodec: video?.codec ?? null,
        videoProfile: video?.profile ?? null,
        width: video?.width ?? null,
        height: video?.height ?? null,
        colorTransfer: video?.colorTransfer ?? null,
        audioCodec: audio?.codec ?? null,
        audioChannels: audio?.channels ?? null,
        audioLayout: audio?.channelLayout ?? null,
        streamsJson: JSON.stringify(result.streams),
      },
      update: {
        container: result.container,
        durationSec: result.duration,
        videoCodec: video?.codec ?? null,
        videoProfile: video?.profile ?? null,
        width: video?.width ?? null,
        height: video?.height ?? null,
        colorTransfer: video?.colorTransfer ?? null,
        audioCodec: audio?.codec ?? null,
        audioChannels: audio?.channels ?? null,
        audioLayout: audio?.channelLayout ?? null,
        streamsJson: JSON.stringify(result.streams),
        updatedAt: new Date(),
      },
    });
    return true;
  } catch (err) {
    // A cache-write failure is not fatal to THIS request, but swallowing it
    // silently means every subsequent play cold-probes again and eats the same
    // latency (I34). Surface it to the caller instead of hiding it behind 200.
    console.warn("[playback] Failed to cache probe:", err);
    return false;
  }
}

export async function POST(request: Request) {
  // Auth — same pattern as the stream route
  const session = await auth();
  if (!session?.user?.id) {
    return json(401, { error: "Not authenticated" });
  }
  const parsedBody = await readMutationObject(request);
  if (!parsedBody.ok) return requestFailureResponse(parsedBody);
  const body = parsedBody.value;

  const rawInfoHash = stringField(body, "infoHash", {
    required: true,
    maxLength: 64,
  });
  if (!rawInfoHash.ok) return requestFailureResponse(rawInfoHash);
  const infoHash = normalizeInfoHash(rawInfoHash.value);
  if (!infoHash) {
    return json(400, {
      error: "infoHash must be a 40-character hex or 32-character base32 hash",
      field: "infoHash",
    });
  }
  const filePathResult = stringField(body, "filePath", {
    required: true,
    maxLength: 4096,
  });
  if (!filePathResult.ok) return requestFailureResponse(filePathResult);
  const filePath = filePathResult.value ?? "";
  const pathSegments = filePath.replace(/\\/g, "/").split("/");
  if (
    filePath.includes("\0") ||
    filePath.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(filePath) ||
    pathSegments.some((segment) => segment === "..")
  ) {
    return json(400, {
      error: "filePath must be a safe path inside the torrent",
      field: "filePath",
    });
  }

  const audioStreamIndexResult = numberField(body, "audioStreamIndex", {
    integer: true,
    min: 0,
    max: 10_000,
  });
  if (!audioStreamIndexResult.ok) return requestFailureResponse(audioStreamIndexResult);
  const startSecResult = numberField(body, "startSec", {
    min: 0,
    max: 1_000_000_000,
  });
  if (!startSecResult.ok) return requestFailureResponse(startSecResult);

  const capabilitiesObject = objectField(body, "capabilities");
  if (!capabilitiesObject.ok) return requestFailureResponse(capabilitiesObject);
  if (capabilitiesObject.value) {
    const ua = stringField(capabilitiesObject.value, "ua", { maxLength: 2000 });
    if (!ua.ok) return requestFailureResponse(ua);
    const mseSupported = capabilitiesObject.value.get("mseSupported");
    if (mseSupported !== undefined && typeof mseSupported !== "boolean") {
      return json(400, {
        error: "capabilities.mseSupported must be a boolean",
        field: "capabilities",
      });
    }
    const codecs = capabilitiesObject.value.get("codecs");
    if (codecs !== undefined) {
      if (!Array.isArray(codecs)) {
        return json(400, {
          error: "capabilities.codecs must be an array",
          field: "capabilities",
        });
      }
      if (codecs.length > 128) {
        return json(400, {
          error: "capabilities.codecs may contain at most 128 entries",
          field: "capabilities",
        });
      }
      for (let index = 0; index < codecs.length; index += 1) {
        const entry = codecs[index];
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          return json(400, {
            error: `capabilities.codecs[${index}] must be an object`,
            field: "capabilities",
          });
        }
        const entryFields = new Map(Object.entries(entry));
        const mime = stringField(entryFields, "mime", { required: true, maxLength: 500 });
        const canPlay = stringField(entryFields, "canPlay", { required: true, maxLength: 32 });
        if (!mime.ok) return requestFailureResponse(mime);
        if (!canPlay.ok) return requestFailureResponse(canPlay);
        const mse = entryFields.get("mse");
        if (typeof mse !== "boolean") {
          return json(400, {
            error: `capabilities.codecs[${index}].mse must be a boolean`,
            field: "capabilities",
          });
        }
      }
    }
  }

  installSessionCleanup();
  const config = await getUserClientConfig(session.user.id);
  if (!config) {
    return json(503, { error: "No torrent client configured" });
  }
  if (config.clientType !== "builtin") {
    return json(409, {
      error: "Playback planning requires the built-in client",
      clientType: config.clientType,
    });
  }

  const capabilities = parseCapabilities(body.get("capabilities"));
  const audioStreamIndex = audioStreamIndexResult.value ?? null;
  const requestedStartSec = Math.floor(startSecResult.value ?? 0);

  // ── Step 1: Probe (cached) ──
  const origin = requestOrigin(request);
  // Diagnostics for the probe cache: "hit" served from cache (no write),
  // "written" freshly probed and persisted, "failed" freshly probed but the
  // cache write was rejected (so the next play will cold-probe again). Surfaced
  // in the response so a persistently failing cache is visible, not hidden (I34).
  let probeCache: "hit" | "written" | "failed" = "hit";
  let probeResult = await getCachedProbe(infoHash, filePath);
  if (!probeResult) {
    const url = streamUrl(infoHash, filePath, origin);
    const outcome = await probeUrl(url);
    if (!outcome.ok) {
      return json(503, {
        error: "Could not probe file",
        probeError: outcome.error.error,
        message: outcome.error.message,
      });
    }
    probeResult = outcome.result;
    probeCache = (await cacheProbe(infoHash, filePath, probeResult)) ? "written" : "failed";
  }

  // ── Step 2: Decide ──
  const plan = decidePlayback(probeResult, capabilities, { audioStreamIndex });

  // Never seek past the end: ffmpeg would produce an empty session that only
  // ever reports "still starting".
  const duration = probeResult.duration;
  const startSec =
    duration !== null && duration > 0
      ? Math.min(requestedStartSec, Math.max(0, Math.floor(duration - SEGMENT_SECONDS)))
      : requestedStartSec;

  // ── Step 3: Build playback URL ──

  /**
   * The single exit for a successful plan. Both the VOD path and the session
   * path have to answer with the same shape — the client reads `plan`, `probe`
   * and `startSec` regardless of how the media is being served — so neither
   * branch is allowed to hand-roll its own body and drift from the other.
   */
  function respond(result: {
    playUrl: string;
    sessionId: string | null;
    startSec: number;
    strategy: string;
    strategyReason: string;
  }): Response {
    const video = probeResult!.streams.find((s) => s.codecType === "video");
    const primaryAudio = probeResult!.streams.find((s) => s.codecType === "audio");

    return NextResponse.json({
      plan: {
        rung: plan.rung,
        reason: plan.reason,
        cost: plan.cost,
        video: plan.video,
        audio: plan.audio.map((a) => ({
          streamIndex: a.streamIndex,
          codec: a.codec,
          action: a.action,
          channels: a.channels,
          targetCodec: a.targetCodec,
          language: a.language,
          title: a.title,
        })),
        selectedAudioIndex: plan.selectedAudioIndex,
        /**
         * Default-subtitle decision. The player auto-enables `defaultTrackId`
         * (embedded/sidecar) when the selected audio is not English, and shows a
         * "no English subtitles available" state when `noEnglishAvailable` is
         * set — never a silent Off.
         */
        subtitle: plan.subtitle,
      },
      playUrl: result.playUrl,
      sessionId: result.sessionId,
      /**
       * Seconds of source the HLS timeline is offset by. HLS output is always
       * rebased to zero, so the player adds this to `video.currentTime` to show
       * a position on the real timeline.
       */
      startSec: result.startSec,
      /** How this file is being served, and why — surfaced for diagnosis. */
      strategy: result.strategy,
      strategyReason: result.strategyReason,
      probe: {
        container: normalizeContainer(probeResult!.container),
        duration: probeResult!.duration,
        videoCodec: video?.codec ?? null,
        videoProfile: video?.profile ?? null,
        audioCodec: primaryAudio?.codec ?? null,
        audioChannels: primaryAudio?.channels ?? null,
        width: video?.width ?? null,
        height: video?.height ?? null,
      },
      /**
       * Probe-cache write status for this request (I34): "hit" (served from
       * cache), "written" (freshly probed + persisted) or "failed" (freshly
       * probed but the write was rejected, so the next play cold-probes again).
       */
      probeCache,
    });
  }

  let playUrl: string;
  let sessionId: string | null = null;
  const timelineOffset = startSec;

  // ── Step 2b: complete-file strategy ──
  //
  // A file that is 100% on disk has a timeline that is fully known up front, so
  // there is no reason to key a session by seek offset and restart ffmpeg with
  // `-ss` every time the viewer scrubs. That restart — new session, new EVENT
  // playlist rebased to zero, hls.js tearing down and reloading — is what the
  // viewer feels as a stutter. For complete files we serve a real VOD playlist
  // instead, and a seek becomes an ordinary byte range.
  //
  // Anything this cannot serve falls through to the session path untouched.
  const local = await resolveCompleteLocalFile({ config, infoHash, filePath });
  const decision = chooseStrategy({ complete: local.ok, plan, duration });
  let strategy = decision.strategy;
  let strategyReason = local.ok ? decision.reason : `${decision.reason}: ${local.reason}`;

  if (strategy !== "session" && local.ok && duration !== null) {
    const entry = prepareVod({
      strategy,
      infoHash,
      filePath,
      audioStreamIndex: plan.selectedAudioIndex,
      sourcePath: local.absolutePath,
      duration,
      plan,
    });

    if (entry.status === "ready") {
      // The player attaches hls.js at position zero, so a mid-file switch has
      // to hand over a playlist whose zero *is* the seek target. The route
      // applies the same trim to the same file, so the offset reported here and
      // the media it serves cannot disagree.
      let offset = 0;
      if (startSec > 0) {
        try {
          offset = trimVodPlaylist(fs.readFileSync(playlistPath(entry), "utf8"), startSec)
            .offsetSeconds;
        } catch {
          offset = 0;
        }
      }
      const query = startSec > 0 ? `?from=${startSec}` : "";
      return respond({
        playUrl: `/api/playback/vod/${entry.id}/${WHOLE_FILE_PLAYLIST}${query}`,
        sessionId: null,
        startSec: offset,
        strategy,
        strategyReason,
      });
    }

    // Not ready yet. The viewer must never wait on a spinner for a background
    // conversion, so play through the session path now; the next plan request
    // (a seek, or the next time this file is opened) picks up the VOD entry.
    strategyReason = `${strategy} still ${entry.status}: ${entry.error ?? "converting"}`;
    strategy = "session";
  }

  if (plan.rung === "direct" && startSec === 0) {
    // Use the existing byte-range stream endpoint — the browser seeks natively.
    const segments = filePath
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    playUrl = `/api/stream/${encodeURIComponent(infoHash)}/${segments}`;
  } else {
    /**
     * Feed ffmpeg the file itself when we have it.
     *
     * For an incomplete torrent the loopback hop is the only option — only the
     * engine knows which pieces exist. For a file that is 100% on disk it is
     * pure overhead: disk → torrent engine → HTTP → ffmpeg, rebuilt on every
     * seek. `resolveCompleteLocalFile` has already proved the path exists and
     * that its size matches the torrent's, and `spawn` passes it as a single
     * argv element with no shell, so spaces (`Season 01`) and apostrophes need
     * no quoting. Anything unproven falls back to the URL.
     */
    const sourceUrl = local.ok ? local.absolutePath : streamUrl(infoHash, filePath, origin);
    if (local.ok) {
      strategyReason = `${strategyReason}; ffmpeg reads the file directly from disk`;
    }
    const result = getOrCreateSession(infoHash, filePath, plan, sourceUrl, { startSec });
    if (!result.ok) {
      return json(503, { error: result.error });
    }
    sessionId = result.session.id;
    playUrl = `/api/playback/hls/${result.session.id}/playlist.m3u8`;
  }

  return respond({ playUrl, sessionId, startSec, strategy, strategyReason });
}
