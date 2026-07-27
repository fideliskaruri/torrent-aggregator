"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, Copy, Loader2, Maximize, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatBytes } from "@/lib/utils";
import { infoHashFromMagnet } from "@/lib/torrents/infohash";
import { SwarmChip } from "@/components/watch/swarm-chip";
import { subtitleListUrl, subtitleTrackSrc, type SubtitleTrack } from "@/lib/media/subtitles";
import type { ProgressUpdateBody } from "@/lib/browse/types";
import Hls from "hls.js";

// Re-export so existing consumers (tests, other components) keep working.
export { infoHashFromMagnet };

export type StreamFile = {
  path: string;
  length: number;
  index: number;
};

type StreamManifest = {
  files: StreamFile[];
  clientType?: string;
};

export type StreamProgress = {
  totalBytes?: number | null;
  downloadedBytes?: number | null;
  progress?: number | null;
  peers?: number | null;
};

type InlinePlayerProps = {
  infoHash: string;
  title: string;
  progress?: StreamProgress;
  /**
   * Where to pick playback up, in *source* seconds. Optional and backward
   * compatible: callers that know nothing about resume keep working unchanged,
   * and a value at or below `RESUME_MIN_SEC` is treated as "start from the
   * beginning" so a stray 0.4s ping can't make the film look half-watched.
   */
  resumeSec?: number;
  /** Season/episode/poster carried into progress writes when known. */
  season?: number | null;
  episode?: number | null;
  posterUrl?: string | null;
  watchListItemId?: string | null;
  className?: string;
  /**
   * How much of the player's own furniture to draw.
   *
   * `inline` is the original: a disclosure widget that sits in a list, closed,
   * with a Play button that expands it and a bordered panel around the result.
   * That is right on /client and /library, where the player is one row among
   * many and must not dominate.
   *
   * `theatre` is for when the viewer has already said "play this". The
   * disclosure has been answered by the click that got here, so re-rendering
   * its toggle produces a button whose only job is to undo the thing the user
   * just asked for — which is how a video player ended up with **Hide player**
   * as its loudest control. In theatre there is no toggle, no panel border and
   * no copy-URL escape hatch competing with the picture: the picture is the
   * interface.
   */
  chrome?: "inline" | "theatre";
};

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".ts",
  ".m2ts",
  ".mpg",
  ".mpeg",
]);

// Only WebVTT can drive a <track> element. `.srt` is included because the
// stream route converts it to WebVTT on the way out; `.ass`/`.ssa` are not,
// because their styling model has no faithful VTT equivalent and a silently
// broken track is worse than no track.
const SUBTITLE_EXTENSIONS = new Set([".vtt", ".srt"]);

type StreamProblem =
  | "browser-error"
  | "no-audio"
  | "wrong-client"
  | "metadata"
  | "stalled"
  | "missing"
  | "range"
  | "preparing"
  | "generic";

type PlaybackMode = "direct" | "hls";

type AudioTracksVideo = HTMLVideoElement & {
  audioTracks?: { length: number };
  // Chrome and Edge do not implement HTMLMediaElement.audioTracks at all, so the
  // spec API silently never fires there. These non-standard counters are the only
  // way those browsers will admit that an audio stream failed to decode.
  webkitAudioDecodedByteCount?: number;
  webkitVideoDecodedByteCount?: number;
};

/** Codec probe candidates sent to the server for capability negotiation. */
const CODEC_PROBES = [
  'video/mp4; codecs="avc1.640028,mp4a.40.2"',
  'video/mp4; codecs="avc1.640028,ac-3"',
  'video/mp4; codecs="avc1.640028,ec-3"',
  'video/mp4; codecs="avc1.640028"',
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1.2.4.L120.B0"',
  'video/mp4; codecs="hvc1.1.6.L93.B0,ac-3"',
  'video/mp4; codecs="av01.0.05M.08"',
  'video/mp4; codecs="vp09.00.10.08"',
  'video/webm; codecs="vp9,opus"',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="flac"',
  'audio/mp4; codecs="ac-3"',
  'audio/mp4; codecs="ec-3"',
  'audio/mp4; codecs="dtsc"',
  'audio/mp4; codecs="mlpa"',
  'video/x-matroska; codecs="avc1.640028,mp4a.40.2"',
] as const;

type ClientCodecEntry = {
  mime: string;
  canPlay: string;
  mse: boolean;
};

type ClientCapabilities = {
  ua?: string;
  codecs: ClientCodecEntry[];
  mseSupported: boolean;
};

type PlaybackPlanResponse = {
  plan: {
    rung: string;
    reason: string;
    cost: number;
    video: { codec: string; action: string; targetCodec?: string } | null;
    audio: Array<{
      streamIndex: number;
      codec: string;
      action: string;
      channels: number;
      targetCodec?: string;
      language: string | null;
      title: string | null;
    }>;
    selectedAudioIndex: number | null;
  };
  playUrl: string;
  sessionId: string | null;
  /** Seconds of source the HLS timeline is offset by. */
  startSec: number;
  /**
   * How the server chose to serve this file (`session` | `whole-file` |
   * `vod-segments`) and why. Optional so an older server that predates these
   * fields still plays instead of crashing on an undefined read.
   */
  strategy?: string;
  strategyReason?: string;
  probe: {
    container: string;
    duration: number | null;
    videoCodec: string | null;
    videoProfile: string | null;
    audioCodec: string | null;
    audioChannels: number | null;
    width: number | null;
    height: number | null;
  };
};

export type PlanAudioTrack = PlaybackPlanResponse["plan"]["audio"][number];

/** Label an audio track for the picker: "English · AC-3 5.1". */
export function audioTrackLabel(track: PlanAudioTrack, index: number): string {
  const parts: string[] = [];
  if (track.title) parts.push(track.title);
  else if (track.language) parts.push(track.language.toUpperCase());
  else parts.push(`Track ${index + 1}`);
  const layout =
    track.channels >= 8
      ? "7.1"
      : track.channels === 6
        ? "5.1"
        : track.channels === 2
          ? "Stereo"
          : track.channels === 1
            ? "Mono"
            : `${track.channels}ch`;
  parts.push(`${track.codec.toUpperCase()} ${layout}`);
  if (track.action === "transcode" && track.targetCodec) {
    parts.push(`→ ${track.targetCodec.toUpperCase()}`);
  }
  return parts.join(" · ");
}

function extensionOf(path: string) {
  const clean = path.split(/[\\/]/).pop() ?? path;
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot).toLowerCase() : "";
}

function basenameWithoutExtension(path: string) {
  const clean = path.replace(/\\/g, "/");
  const slash = clean.lastIndexOf("/");
  const filename = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(0, dot).toLowerCase() : filename.toLowerCase();
}

function directoryOf(path: string) {
  const clean = path.replace(/\\/g, "/");
  const slash = clean.lastIndexOf("/");
  return slash >= 0 ? clean.slice(0, slash).toLowerCase() : "";
}

export function isVideoFile(path: string) {
  return VIDEO_EXTENSIONS.has(extensionOf(path));
}

export function selectVideoFiles(files: StreamFile[]) {
  return files.filter((file) => isVideoFile(file.path));
}

export function findSidecarSubtitle(files: StreamFile[], videoPath: string) {
  const videoBase = basenameWithoutExtension(videoPath);
  const videoDir = directoryOf(videoPath);
  return files.find(
    (file) =>
      directoryOf(file.path) === videoDir &&
      basenameWithoutExtension(file.path) === videoBase &&
      SUBTITLE_EXTENSIONS.has(extensionOf(file.path)),
  );
}

export function encodeStreamFilePath(filePath: string) {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function streamPath(infoHash: string, filePath: string) {
  return `/api/stream/${encodeURIComponent(infoHash)}/${encodeStreamFilePath(filePath)}`;
}

export function streamStatusMessage(status: number): {
  problem: StreamProblem;
  message: string;
} {
  if (status === 409) {
    return {
      problem: "wrong-client",
      message: "Streaming only works with the built-in engine.",
    };
  }
  if (status === 425) {
    return {
      problem: "metadata",
      message: "Torrent metadata is still resolving. Try again in a moment.",
    };
  }
  if (status === 503) {
    return {
      problem: "stalled",
      message: "No peers are currently sending this part.",
    };
  }
  if (status === 404) {
    return {
      problem: "missing",
      message:
        "This release isn't in the built-in engine — download it first, then play.",
    };
  }
  if (status === 416) {
    return {
      problem: "range",
      message: "The browser could not request a playable byte range.",
    };
  }
  return {
    problem: "generic",
    message: "The stream is not available right now.",
  };
}

export function bufferingLabel(progress?: StreamProgress) {
  const total = progress?.totalBytes ?? null;
  const downloaded =
    progress?.downloadedBytes ??
    (total != null && progress?.progress != null
      ? Math.max(0, Math.min(total, total * progress.progress))
      : null);
  const peers = progress?.peers;
  const peerText =
    peers == null ? "" : ` · ${peers} ${peers === 1 ? "peer" : "peers"}`;

  if (downloaded != null && total != null) {
    return `buffering — ${formatBytes(downloaded)} / ${formatBytes(total)}${peerText}`;
  }
  if (downloaded != null) {
    return `buffering — ${formatBytes(downloaded)} downloaded${peerText}`;
  }
  if (progress?.progress != null) {
    return `buffering — ${Math.round(progress.progress * 1000) / 10}% downloaded${peerText}`;
  }
  return `buffering — waiting for torrent pieces${peerText}`;
}

async function readJson<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Detect what the current browser can actually decode.
 *
 * Memoised for the lifetime of the tab: `canPlayType` and
 * `MediaSource.isTypeSupported` are synchronous calls into the media stack, and
 * codec support cannot change while the page is open. Re-running this on every
 * file selection paid the cost repeatedly for an answer that is constant.
 */
let capabilitiesCache: ClientCapabilities | null = null;

export function detectCapabilities(): ClientCapabilities {
  if (capabilitiesCache) return capabilitiesCache;
  const video = document.createElement("video");
  const hasMSE = typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function";
  const codecs: ClientCodecEntry[] = CODEC_PROBES.map((mime) => ({
    mime,
    canPlay: video.canPlayType(mime) || "",
    mse: hasMSE ? MediaSource.isTypeSupported(mime) : false,
  }));
  capabilitiesCache = {
    ua: navigator.userAgent,
    codecs,
    mseSupported: hasMSE,
  };
  return capabilitiesCache;
}

/** Test seam — the cache would otherwise leak between cases. */
export function resetCapabilitiesCacheForTests() {
  capabilitiesCache = null;
}

/** `h:mm:ss` / `m:ss` clock for the source-timeline seek bar. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** A buffered span expressed in seconds on the *source* timeline. */
export type SourceRange = { start: number; end: number };

/**
 * Move `video.buffered` into the coordinate space the viewer is looking at.
 *
 * This is the whole correctness question for the buffered band. In HLS mode the
 * media element knows only about the window the current ffmpeg session has
 * produced, and that session was started with `-ss timelineOffset` and rebased
 * to zero — so `mediaTime + timelineOffset` is the source position. That is not
 * an assumption: it is the identical mapping the playhead already uses
 * (`onTimeUpdate` → `timelineOffset + currentTime`), which the seek test proves
 * end to end. Drawing the band in any other space would produce a confident lie
 * — a bar claiming the film is buffered to 0:20 while the viewer is at 1:50.
 *
 * Ranges are clamped to `[0, sourceDuration]` and empty/degenerate ones are
 * dropped, so nothing can be painted outside the bar it belongs to.
 */
export function bufferedSourceRanges(
  buffered: TimeRanges | null | undefined,
  timelineOffset: number,
  sourceDuration: number | null,
): SourceRange[] {
  if (!buffered || !sourceDuration || sourceDuration <= 0) return [];
  const out: SourceRange[] = [];
  for (let i = 0; i < buffered.length; i += 1) {
    let start: number;
    let end: number;
    try {
      start = buffered.start(i);
      end = buffered.end(i);
    } catch {
      // TimeRanges throws IndexSizeError if the element re-buffers mid-loop.
      break;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const s = Math.max(0, Math.min(sourceDuration, timelineOffset + start));
    const e = Math.max(0, Math.min(sourceDuration, timelineOffset + end));
    if (e - s <= 0.05) continue;
    out.push({ start: s, end: e });
  }
  return out;
}

/**
 * Seconds of continuous buffer ahead of `position`.
 *
 * "Continuous" is the point: a range that starts after a gap is not something
 * the viewer can watch into, so it does not count. Returns 0 when the playhead
 * is not inside any range, which is the truth during a re-buffer.
 */
export function bufferedAheadOf(ranges: SourceRange[], position: number): number {
  for (const range of ranges) {
    if (position >= range.start - 0.5 && position <= range.end) {
      return Math.max(0, range.end - position);
    }
  }
  return 0;
}

/**
 * Can this plan be played by the browser itself, with no MSE in the middle?
 *
 * Two independent signals, either of which is sufficient:
 *  - the ladder resolved to `direct`, which by definition means the container
 *    and codecs are natively decodable, so the byte-range stream endpoint is
 *    all that is needed; and
 *  - the URL the server handed back is not a playlist, so there is nothing for
 *    hls.js to parse anyway.
 *
 * This matters most for a file that is already fully on disk: native seeking is
 * a byte-range request the browser issues and resolves itself, where MSE has to
 * tear down buffers, refetch fragments and re-append — which is what the viewer
 * feels as a stutter when scrubbing a local file.
 */
export function canPlayNatively(rung: string, playUrl: string): boolean {
  if (rung === "direct") return true;
  return !/\.m3u8(?:$|[?#])/i.test(playUrl);
}

/** Below this, a stored position is noise rather than a place to resume. */
export const RESUME_MIN_SEC = 5;

/** Don't write a position that moved less than this since the last write. */
export const PROGRESS_MIN_DELTA_SEC = 5;

/** Steady-state cadence for progress writes during playback. */
export const PROGRESS_INTERVAL_MS = 10_000;

/**
 * Should a progress write actually go out?
 *
 * Pure so the throttle can be tested without a media element. `force` is the
 * pause/unload path: those are the writes that decide whether Continue Watching
 * is right, so they skip the cadence — but never the "did it actually move"
 * check, because re-posting an identical position is pure write amplification.
 */
export function shouldPostProgress(args: {
  positionSec: number;
  durationSec: number | null;
  lastPostedSec: number | null;
  lastPostedAtMs: number | null;
  nowMs: number;
  force?: boolean;
}): boolean {
  const { positionSec, durationSec, lastPostedSec, lastPostedAtMs, nowMs, force } = args;
  if (!Number.isFinite(positionSec) || positionSec < 0) return false;
  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return false;
  if (positionSec > durationSec) return false;
  if (lastPostedSec !== null && Math.abs(positionSec - lastPostedSec) < PROGRESS_MIN_DELTA_SEC) {
    return false;
  }
  if (force) return true;
  if (lastPostedAtMs === null) return true;
  return nowMs - lastPostedAtMs >= PROGRESS_INTERVAL_MS;
}

/** A track as the subtitles endpoint returns it: `src` is null when unusable. */export type SubtitleTrackWithSrc = SubtitleTrack & { src: string | null };

type SubtitleListResponse = {
  tracks?: SubtitleTrackWithSrc[];
  embeddedInspected?: boolean;
  probeError?: string | null;
};

type SubtitleStatus = "idle" | "loading" | "extracting" | "ready" | "error";

/** Human-readable label for what the playback ladder is doing. */function rungLabel(rung: string): string {
  switch (rung) {
    case "direct": return "Playing directly";
    case "remux": return "Remuxing for your browser…";
    case "transcode-audio": return "Transcoding audio…";
    case "transcode-full": return "Transcoding video + audio…";
    default: return "Preparing…";
  }
}

export function InlineStreamPlayer({
  infoHash,
  title,
  progress,
  resumeSec,
  season,
  episode,
  posterUrl,
  watchListItemId,
  className,
  chrome = "inline",
}: InlinePlayerProps) {
  const theatre = chrome === "theatre";
  const panelId = useId();
  // Theatre is entered by an explicit "play this", so it starts open. The old
  // route into this state was an effect in the overlay that reached into the
  // player's DOM and clicked its toggle for it; a component that has to be
  // puppeteered through its own public surface is one that was missing a prop.
  const [expanded, setExpanded] = useState(theatre);
  const [manifest, setManifest] = useState<StreamManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<StreamProblem | null>(null);
  const [playableSrc, setPlayableSrc] = useState<string | null>(null);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("direct");
  const [checkingStream, setCheckingStream] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [preparingLabel, setPreparingLabel] = useState<string | null>(null);
  const [audioTracks, setAudioTracks] = useState<PlanAudioTrack[]>([]);
  const [audioStreamIndex, setAudioStreamIndex] = useState<number | null>(null);
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  /**
   * Seconds of source the current HLS timeline starts at. The ffmpeg session is
   * restarted at an offset when the viewer seeks past what it has produced, and
   * its output is always rebased to zero — so every position shown to the user
   * is this plus `video.currentTime`.
   */
  const [timelineOffset, setTimelineOffset] = useState(0);
  const [currentSourceTime, setCurrentSourceTime] = useState(0);
  /**
   * Transport state for the HLS control bar. The native controls are suppressed
   * in HLS mode because their scrubber measures the *generated segment window*
   * (a few seconds), not the film — showing "0:00 / 0:04" beside a source
   * timeline reading "1:50 / 2:30". Two scrubbers that disagree is worse than
   * one, so we own the transport and drive the element directly.
   */
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  /**
   * Buffered spans in *source* seconds. Only populated in HLS mode: in direct
   * mode the native control bar is kept (there the media timeline *is* the
   * file), and the browser already paints an accurate band on it. Painting a
   * second one is how this player ended up showing two disagreeing scrubbers.
   */
  const [bufferedRanges, setBufferedRanges] = useState<SourceRange[]>([]);
  /** Subtitle tracks offered for the selected file, from `/api/subtitles`. */
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackWithSrc[]>([]);
  const [subtitleTrackId, setSubtitleTrackId] = useState<string>("");
  const [subtitleStatus, setSubtitleStatus] = useState<SubtitleStatus>("idle");
  const [subtitleNote, setSubtitleNote] = useState<string | null>(null);
  /** Bumped to force a re-plan (seek to a new offset, or an audio track change). */
  const [planNonce, setPlanNonce] = useState(0);
  /**
   * How the server is serving this file, and why.
   *
   * Diagnostics only: these land on the container as data attributes so a
   * stutter can be traced to the exact path that produced it. They are never
   * rendered as prose — the viewer does not need to be told about remuxing,
   * byte ranges or ffmpeg to watch a film.
   */
  const [strategy, setStrategy] = useState<string | null>(null);
  const [strategyReason, setStrategyReason] = useState<string | null>(null);
  const [playbackRung, setPlaybackRung] = useState<string | null>(null);
  /**
   * A seek is in flight. Rendered as a spinner over the frame: without it the
   * player holds the *old* frame while the new position loads, which reads as a
   * freeze rather than as work happening.
   */
  const [seeking, setSeeking] = useState(false);
  const hlsRef = useRef<Hls | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** Pending seek target on the source timeline, consumed by the next plan. */
  const pendingSeekRef = useRef(0);
  const seekInFlightRef = useRef(false);
  /**
   * Where to put the playhead once the *native* element has metadata. Native
   * playback needs no re-plan to seek — the file is addressed by byte range —
   * so a resume position becomes a single `currentTime` write instead of a new
   * ffmpeg session.
   */
  const pendingNativeSeekRef = useRef(0);
  /** The resume position is honoured once, for the first file opened. */
  const resumeConsumedRef = useRef(false);
  /** Detaches the seek-abort listener from the previous media element. */
  const hlsSeekAbortRef = useRef<(() => void) | null>(null);
  /** Live mirrors of playhead/duration, readable from unload handlers. */
  const currentSourceTimeRef = useRef(0);
  const sourceDurationRef = useRef<number | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const lastPostedSecRef = useRef<number | null>(null);
  const lastPostedAtRef = useRef<number | null>(null);
  /** Pending post-seek write, cancelled when another seek supersedes it. */
  const seekPostTimerRef = useRef<number | null>(null);

  const resumeTargetSec =
    typeof resumeSec === "number" && Number.isFinite(resumeSec) && resumeSec > RESUME_MIN_SEC
      ? Math.floor(resumeSec)
      : 0;

  const videoFiles = useMemo(
    () => (manifest ? selectVideoFiles(manifest.files) : []),
    [manifest],
  );
  const selectedFile = videoFiles.find((file) => file.path === selectedPath);
  /**
   * The subtitle file a release ships *next to* the video under the exact same
   * name. Direct mode used to mount this as a `default` `<track>`, so it is kept
   * as the picker's initial selection — losing an auto-enabled subtitle would be
   * a regression a viewer notices immediately.
   */
  const defaultSidecarPath = useMemo(
    () =>
      manifest && selectedPath
        ? findSidecarSubtitle(manifest.files, selectedPath)?.path ?? null
        : null,
    [manifest, selectedPath],
  );

  // Clean up HLS instance on unmount or source change
  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, []);

  /**
   * Read the element's buffered ranges into source coordinates.
   *
   * Driven from the media element's own `progress`/`timeupdate` events rather
   * than a timer: the browser fires `progress` exactly when the buffer changes,
   * so this costs nothing between changes and never runs while nothing is
   * downloading.
   */
  const readBuffered = useCallback(
    (video: HTMLVideoElement) => {
      const next = bufferedSourceRanges(video.buffered, timelineOffset, sourceDuration);
      setBufferedRanges((prev) => {
        if (
          prev.length === next.length &&
          prev.every(
            (r, i) =>
              Math.abs(r.start - next[i].start) < 0.05 &&
              Math.abs(r.end - next[i].end) < 0.05,
          )
        ) {
          return prev;
        }
        return next;
      });
    },
    [timelineOffset, sourceDuration],
  );

  // Mirror the values the unload handlers need. Those fire outside React's
  // render cycle (and `sendBeacon` gets one shot), so reading state through a
  // closure there would write whatever the last committed render happened to
  // hold — usually a position several seconds stale.
  useEffect(() => {
    currentSourceTimeRef.current = currentSourceTime;
  }, [currentSourceTime]);
  useEffect(() => {
    sourceDurationRef.current = sourceDuration;
  }, [sourceDuration]);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
    // A different file is a different progress row; the throttle must not carry
    // the previous file's position over and suppress the first write.
    lastPostedSecRef.current = null;
    lastPostedAtRef.current = null;
  }, [selectedPath]);

  /**
   * Write the playback position to `/api/progress`.
   *
   * This is what makes Continue Watching real: nothing else in the app posts
   * here, so without it every stored position stays at whatever it was and
   * "Resume" is decoration.
   *
   * Three rules, all deliberate:
   *  - it can never break playback. Every failure path is swallowed; a progress
   *    write is bookkeeping and the viewer must not lose their film over it.
   *  - it is throttled to `PROGRESS_INTERVAL_MS` and gated on real movement, so
   *    scrubbing does not fire a write per frame.
   *  - the final write uses `sendBeacon`, which the browser is obliged to
   *    deliver after the page is gone. `fetch` on `pagehide` is routinely
   *    cancelled mid-flight, which is exactly the write that matters most.
   */
  const postProgress = useCallback(
    (opts: { force?: boolean; beacon?: boolean } = {}) => {
      const filePath = selectedPathRef.current;
      const durationSec = sourceDurationRef.current ?? videoRef.current?.duration ?? null;
      const positionSec = Math.floor(currentSourceTimeRef.current);
      if (!filePath || !infoHash) return;
      const usableDuration =
        durationSec && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null;
      if (
        !shouldPostProgress({
          positionSec,
          durationSec: usableDuration,
          lastPostedSec: lastPostedSecRef.current,
          lastPostedAtMs: lastPostedAtRef.current,
          nowMs: Date.now(),
          force: opts.force,
        })
      ) {
        return;
      }
      if (usableDuration === null) return;

      const body: ProgressUpdateBody = {
        infoHash,
        filePath,
        positionSec,
        durationSec: Math.floor(usableDuration),
        title,
        season: season ?? null,
        episode: episode ?? null,
        posterUrl: posterUrl ?? null,
        watchListItemId: watchListItemId ?? null,
      };
      // Recorded before the request resolves on purpose: the throttle is about
      // how often we *ask*, and a failed write must not free the next tick to
      // hammer the endpoint.
      lastPostedSecRef.current = positionSec;
      lastPostedAtRef.current = Date.now();

      const payload = JSON.stringify(body);
      try {
        if (opts.beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
          const blob = new Blob([payload], { type: "application/json" });
          if (navigator.sendBeacon("/api/progress", blob)) return;
        }
        void fetch("/api/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {
          /* bookkeeping only — never surfaced, never fatal */
        });
      } catch {
        /* Blob/sendBeacon unavailable: the position is simply not stored */
      }
    },
    [infoHash, title, season, episode, posterUrl, watchListItemId],
  );

  /**
   * Flush the position when the tab goes away.
   *
   * `visibilitychange` and `pagehide` are used instead of `beforeunload`
   * because they are the two the mobile browsers actually fire — `beforeunload`
   * is skipped outright when an app is backgrounded and then killed, which is
   * the single most common way a viewer stops watching.
   */
  useEffect(() => {
    if (!expanded) return;
    const flush = () => postProgress({ force: true, beacon: true });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [expanded, postProgress]);

  /**
   * A seek only earns a write once it has settled.
   *
   * Scrubbing produces a burst of positions the viewer never watched. Delaying
   * the write and cancelling the previous timer means only the position they
   * landed on is stored — a seek that is immediately superseded writes nothing.
   */
  const scheduleSeekProgress = useCallback(() => {
    if (seekPostTimerRef.current !== null) window.clearTimeout(seekPostTimerRef.current);
    seekPostTimerRef.current = window.setTimeout(() => {
      seekPostTimerRef.current = null;
      postProgress({ force: true });
    }, 2000);
  }, [postProgress]);

  useEffect(() => {
    return () => {
      if (seekPostTimerRef.current !== null) window.clearTimeout(seekPostTimerRef.current);
    };
  }, []);

  const copyUrl = useCallback(
    async (path: string) => {
      const url = `${window.location.origin}${streamPath(infoHash, path)}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setMessage("Stream URL copied.");
      window.setTimeout(() => setCopied(false), 1600);
    },
    [infoHash],
  );

  const loadManifest = useCallback(async () => {
    if (manifest) return manifest;
    setManifestLoading(true);
    setMessage(null);
    setProblem(null);
    try {
      const res = await fetch(`/api/stream/${encodeURIComponent(infoHash)}`);
      if (!res.ok) {
        const mapped = streamStatusMessage(res.status);
        setProblem(mapped.problem);
        setMessage(mapped.message);
        return null;
      }
      const data = await readJson<StreamManifest>(res);
      if (data?.clientType && data.clientType !== "builtin") {
        setProblem("wrong-client");
        setMessage("Streaming only works with the built-in engine.");
        return null;
      }
      const files = Array.isArray(data?.files) ? data.files : [];
      const next = { files, clientType: data?.clientType };
      setManifest(next);
      const videos = selectVideoFiles(files);
      if (videos.length === 1) setSelectedPath(videos[0].path);
      if (videos.length === 0) {
        setProblem("missing");
        setMessage("No video file was listed for this torrent.");
      }
      return next;
    } catch {
      setProblem("generic");
      setMessage("Could not reach the stream endpoint.");
      return null;
    } finally {
      setManifestLoading(false);
    }
  }, [infoHash, manifest]);

  const copySelected = useCallback(async () => {
    const loaded = await loadManifest();
    if (!loaded) return;
    const videos = selectVideoFiles(loaded.files);
    const path = selectedPath ?? (videos.length === 1 ? videos[0].path : null);
    if (!path) {
      setExpanded(true);
      setMessage("Pick a file, then copy its stream URL.");
      return;
    }
    try {
      await copyUrl(path);
    } catch {
      setProblem("generic");
      setMessage("Could not copy the stream URL.");
    }
  }, [copyUrl, loadManifest, selectedPath]);

  const toggleExpanded = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    void loadManifest();
  }, [expanded, loadManifest]);

  // Theatre skips the toggle, so it also skips the manifest load the toggle
  // performed on the way through. Nothing else fetches it, so without this the
  // panel opens and sits on "Resolving files…" forever.
  useEffect(() => {
    if (!theatre) return;
    void loadManifest();
  }, [theatre, loadManifest]);

  /**
   * Fallback: try the direct stream endpoint when the plan endpoint is
   * unavailable.
   *
   * Declared above the playback effect that calls it, not below. As a hoisted
   * `function` it ran correctly, but reading a value defined later in the
   * component body hides whether the closure is current — and here it closes
   * over state setters, so the question is a fair one to ask. `useCallback([])`
   * over nothing but stable setters gives it a fixed identity, which lets it
   * sit in the effect's dependency list honestly instead of being omitted.
   */
  const tryDirectStream = useCallback(
    async (hash: string, filePath: string, signal: AbortSignal) => {
      try {
        const res = await fetch(streamPath(hash, filePath), {
          headers: { Range: "bytes=0-0" },
          signal,
        });
        await res.body?.cancel().catch(() => {});
        if (signal.aborted) return;
        if (res.ok || res.status === 206) {
          setPlaybackMode("direct");
          setPlayableSrc(streamPath(hash, filePath));
          return;
        }
        const mapped = streamStatusMessage(res.status);
        setProblem(mapped.problem);
        setMessage(mapped.message);
      } catch {
        if (!signal.aborted) {
          setProblem("generic");
          setMessage("Could not check the stream.");
        }
      }
    },
    [],
  );

  // The seek offset is a ref, so it is reset here rather than in the render-time
  // block below — a render may be discarded, and a discarded render must not
  // leave a mutation behind. Declared *before* the playback effect so it has
  // already run by the time that effect reads `pendingSeekRef.current`; it
  // deliberately keys on `selectedPath` only, so a seek (which bumps
  // `planNonce`) does not clobber the offset it just requested.
  //
  // A resume position is applied here, exactly once, to the first file opened:
  // it is the offset the *plan* should start at, and consuming it any later
  // would mean planning at 0 and then seeking — an ffmpeg session spawned at
  // the wrong offset and immediately thrown away. Picking a different file
  // afterwards starts that file at 0, because a position stored for one episode
  // is not a position in another.
  useEffect(() => {
    if (!selectedPath) return;
    if (!resumeConsumedRef.current && resumeTargetSec > 0) {
      resumeConsumedRef.current = true;
      pendingSeekRef.current = resumeTargetSec;
      return;
    }
    resumeConsumedRef.current = true;
    pendingSeekRef.current = 0;
  }, [selectedPath, resumeTargetSec]);

  // Main playback effect: when a file is selected, negotiate the playback plan.
  // Also re-runs on `planNonce` — bumped when the viewer seeks past what the
  // current ffmpeg session has produced, or picks a different audio track.
  useEffect(() => {
    if (!expanded || !selectedPath) return;
    const controller = new AbortController();
    const filePath = selectedPath;
    const startSec = pendingSeekRef.current;
    const requestedAudio = audioStreamIndex;

    void (async () => {
      // Reset state
      setPlayableSrc(null);
      setPlaybackMode("direct");
      setWaiting(false);
      setCheckingStream(true);
      setProblem(null);
      setMessage(null);
      setPreparingLabel(null);
      setSeeking(false);
      // A new session produces a new media element with an empty buffer; keeping
      // the old spans on screen for even one frame would be a stale claim.
      setBufferedRanges([]);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      try {
        // Detect browser capabilities
        const capabilities = detectCapabilities();

        // Ask the server for a playback plan
        const planRes = await fetch("/api/playback/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            infoHash,
            filePath,
            capabilities,
            startSec,
            audioStreamIndex: requestedAudio,
          }),
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;

        if (!planRes.ok) {
          // Fall back to direct stream check if the plan endpoint fails
          // (e.g. probe failed because torrent is cold)
          const errorData = await readJson<{ error?: string; probeError?: string; message?: string }>(planRes);
          if (planRes.status === 503 && errorData?.probeError === "timeout") {
            setProblem("stalled");
            setMessage("Waiting for torrent data to probe the file. Try again in a moment.");
            return;
          }
          // Try direct stream as fallback
          await tryDirectStream(infoHash, filePath, controller.signal);
          return;
        }

        const planData = await readJson<PlaybackPlanResponse>(planRes);
        if (!planData || controller.signal.aborted) return;

        setAudioTracks(planData.plan.audio);
        setAudioStreamIndex(planData.plan.selectedAudioIndex);
        setSourceDuration(planData.probe.duration);
        setStrategy(planData.strategy ?? null);
        setStrategyReason(planData.strategyReason ?? null);
        setPlaybackRung(planData.plan.rung);

        if (canPlayNatively(planData.plan.rung, planData.playUrl)) {
          /**
           * Native playback. No hls.js, no MSE, no session: the element gets a
           * plain URL and the browser owns seeking, which on a file that is
           * already on disk is a byte-range request it resolves itself.
           *
           * The URL is rebuilt rather than taken from the response because the
           * server only returns the byte-range endpoint when it plans at 0 — ask
           * it to resume at 20 minutes and it hands back an ffmpeg session for a
           * file the browser can decode as-is. The stream endpoint serves the
           * whole file for any offset, so the offset is a `currentTime` write
           * here and the timeline is the file's own: no rebasing.
           */
          const nativeUrl =
            planData.plan.rung === "direct"
              ? streamPath(infoHash, filePath)
              : planData.playUrl;
          setPlaybackMode("direct");
          setTimelineOffset(0);
          pendingNativeSeekRef.current = startSec > 0 ? startSec : 0;
          if (startSec > 0) setCurrentSourceTime(startSec);
          setPlayableSrc(nativeUrl);
        } else {
          // HLS — a genuinely incomplete file, or one that needs ffmpeg.
          setTimelineOffset(planData.startSec);
          pendingNativeSeekRef.current = 0;
          setPlaybackMode("hls");
          setPreparingLabel(rungLabel(planData.plan.rung));
          setPlayableSrc(planData.playUrl);
        }
      } catch {
        if (!controller.signal.aborted) {
          // Network error — fall back to direct stream check
          await tryDirectStream(infoHash, filePath, controller.signal).catch(() => {
            setProblem("generic");
            setMessage("Could not check the stream.");
          });
        }
      } finally {
        if (!controller.signal.aborted) setCheckingStream(false);
        seekInFlightRef.current = false;
      }
    })();

    return () => controller.abort();
  }, [expanded, infoHash, selectedPath, planNonce, audioStreamIndex, tryDirectStream]);

  // Selecting a different file must not inherit the previous file's seek offset
  // or audio-track choice.
  //
  // This runs *during render*, not in an effect, which is React's documented
  // way to adjust state when an input changes — and here it also fixes a real
  // bug. As an effect it committed one render too late: the playback effect
  // above lists `audioStreamIndex` in its dependencies, so on a file switch it
  // fired once with the **previous** file's audio index (requesting a track
  // that belongs to another file), and only then did the reset land and fire it
  // a second time. Adjusting during render means React re-renders before
  // committing, so the playback effect runs once, with the right values.
  const [resetForPath, setResetForPath] = useState(selectedPath);
  if (selectedPath !== resetForPath) {
    setResetForPath(selectedPath);
    setTimelineOffset(0);
    setAudioTracks([]);
    setAudioStreamIndex(null);
    setSourceDuration(null);
    setBufferedRanges([]);
    setSubtitleTracks([]);
    setSubtitleTrackId("");
    setSubtitleStatus("idle");
    setSubtitleNote(null);
  }

  /**
   * Ask what subtitles exist for the selected file.
   *
   * Deliberately separate from the playback plan and fired once per file, not
   * per session restart: listing is cheap (it reads the probe the plan route
   * already cached) but a seek must not re-run it, and a subtitle failure must
   * never be able to delay or break playback. Hence its own effect, its own
   * abort controller, and a swallowed error.
   *
   * It waits for the plan to resolve first. Asking earlier would race the plan
   * for the same probe and, on a cold cache, put a second ffprobe on the torrent
   * while ffmpeg is still trying to fill its first segment — subtitles are not
   * allowed to cost the viewer a slower start.
   */
  const planResolved = Boolean(playableSrc);
  useEffect(() => {
    if (!expanded || !selectedPath || !planResolved) return;
    const controller = new AbortController();
    const filePath = selectedPath;
    void (async () => {
      try {
        const res = await fetch(subtitleListUrl(infoHash, filePath), {
          signal: controller.signal,
        });
        if (!res.ok || controller.signal.aborted) return;
        const data = await readJson<SubtitleListResponse>(res);
        if (!data || controller.signal.aborted) return;
        const tracks = Array.isArray(data.tracks) ? data.tracks : [];
        setSubtitleTracks(tracks);
        // Preserve the old direct-mode behaviour: an exact-basename sidecar was
        // mounted as the default track, so it stays selected by default here.
        const preselect = tracks.find(
          (t) => t.kind === "sidecar" && t.filePath === defaultSidecarPath && t.src,
        );
        if (preselect) {
          setSubtitleTrackId(preselect.id);
          setSubtitleStatus("loading");
        }
        if (tracks.length > 0 && data.embeddedInspected === false) {
          setSubtitleNote("Embedded tracks could not be inspected — only files are listed.");
        }
      } catch {
        // No subtitles is a normal outcome; a failed listing must not surface as
        // a playback problem. The picker simply does not appear.
      }
    })();
    return () => controller.abort();
  }, [expanded, infoHash, selectedPath, defaultSidecarPath, planResolved]);

  /**
   * Restart the HLS session at `sourceSec`.
   *
   * ffmpeg only ever produced segments from `timelineOffset` onwards, so a seek
   * outside that window cannot be served by the current playlist — the segment
   * route would 404. Re-planning respawns ffmpeg with `-ss` at the new offset.
   */
  const seekToSource = useCallback((sourceSec: number) => {
    if (seekInFlightRef.current) return;
    seekInFlightRef.current = true;
    pendingSeekRef.current = Math.max(0, sourceSec);
    setPlanNonce((n) => n + 1);
  }, []);

  /** Play/pause the underlying element. State is synced from the media events,
   *  never assumed here, so an autoplay block or a stall can't desync the icon. */
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {
        /* autoplay refusal keeps the paused icon, which is the truth */
      });
    } else {
      video.pause();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  /**
   * Pick a subtitle track (or "" for off).
   *
   * `subtitleStatus` starts at "extracting" for an embedded track because that
   * is the truth — the server has to demux the container before a single cue
   * exists, and on a cold torrent that is not instant. It moves to "ready" only
   * when the `<track>` element reports its cues loaded, and to "error" when the
   * element reports a failure. Nothing here assumes success.
   */
  const selectSubtitleTrack = useCallback(
    (id: string) => {
      setSubtitleNote(null);
      setSubtitleTrackId(id);
      if (!id) {
        setSubtitleStatus("idle");
        return;
      }
      const track = subtitleTracks.find((t) => t.id === id);
      setSubtitleStatus(track?.needsExtraction ? "extracting" : "loading");
    },
    [subtitleTracks],
  );

  const activeSubtitle = useMemo(
    () => subtitleTracks.find((t) => t.id === subtitleTrackId && t.src) ?? null,
    [subtitleTracks, subtitleTrackId],
  );

  /**
   * The URL the `<track>` loads, carrying the offset the media timeline starts
   * at. Cues are stored in source time; in HLS mode the element's timeline is
   * rebased to zero at `timelineOffset`, so without this every line would be
   * `timelineOffset` seconds late — after a seek to 1:30 the subtitles would
   * simply never appear. Direct mode plays the file itself, so the offset is 0.
   */
  const activeSubtitleSrc = useMemo(() => {
    if (!activeSubtitle || !selectedPath) return null;
    const offset = playbackMode === "hls" ? timelineOffset : 0;
    return subtitleTrackSrc(infoHash, selectedPath, activeSubtitle.id, offset);
  }, [activeSubtitle, infoHash, selectedPath, playbackMode, timelineOffset]);

  /**
   * Turn the rendered `<track>` on.
   *
   * A `<track>` whose mode is "disabled" is never fetched by the browser, so
   * this is also what triggers the extraction request. Re-runs when the media
   * element is replaced (a seek restarts the session and remounts `<video>`),
   * because the new element's text tracks default to disabled again.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const apply = () => {
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i += 1) {
        tracks[i].mode = activeSubtitle ? "showing" : "disabled";
      }
    };
    apply();
    // The TextTrack list is populated asynchronously after the <track> element
    // is inserted, so one pass on mount can legitimately find nothing.
    const timer = window.setTimeout(apply, 150);
    return () => window.clearTimeout(timer);
  }, [activeSubtitle, playableSrc, playbackMode]);

  /**
   * "Ready" has to mean the browser actually has cues, not that an event
   * happened to fire.
   *
   * A `<track>` remounted with a URL the browser already holds can finish
   * loading without a fresh `load` event, which left "Extracting subtitles from
   * the file…" on screen *underneath subtitles that were already rendering* —
   * the app describing a state it had not re-checked. This watches the only
   * thing that settles the question. It reads an in-memory property and only
   * runs while something is genuinely pending.
   */
  useEffect(() => {
    if (subtitleStatus !== "extracting" && subtitleStatus !== "loading") return;
    const video = videoRef.current;
    if (!video) return;
    const timer = window.setInterval(() => {
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i += 1) {
        if ((tracks[i].cues?.length ?? 0) > 0) {
          setSubtitleStatus("ready");
          return;
        }
      }
    }, 300);
    return () => window.clearInterval(timer);
  }, [subtitleStatus, activeSubtitleSrc]);

  const goFullscreen = useCallback(() => {
    void videoRef.current?.requestFullscreen?.().catch(() => {
      /* denied outside a user gesture or in an unsupported browser */
    });
  }, []);

  /** Attach HLS.js to the video element when in HLS mode. */
  const attachHls = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    hlsSeekAbortRef.current?.();
    hlsSeekAbortRef.current = null;
    if (!video || !playableSrc || playbackMode !== "hls") return;

    // Destroy previous instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (!Hls.isSupported()) {
      // If MSE is not supported, fall back to native (Safari can sometimes do HLS natively)
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = playableSrc;
        return;
      }
      setProblem("browser-error");
      setMessage("Your browser does not support HLS playback.");
      return;
    }

    const hls = new Hls({
      /**
       * VOD, never live. Low-latency mode shrinks the buffer hls.js is willing
       * to hold and makes it chase the live edge — on a file we are seeking
       * around in, that is a smaller cushion and more refetching for a latency
       * figure nobody is watching.
       */
      lowLatencyMode: false,
      /**
       * Look-ahead. 30s is roughly three segments: enough that a slow fragment
       * is absorbed silently, short enough that a seek does not first have to
       * throw away a minute of work it already paid for. `maxMaxBufferLength`
       * is the ceiling hls.js may grow to when bandwidth is plentiful.
       */
      maxBufferLength: 30,
      maxMaxBufferLength: 90,
      /** Bytes matter more than seconds for HEVC 1080p; ~120 MB is a few minutes. */
      maxBufferSize: 120 * 1000 * 1000,
      /**
       * Keep 90s behind the playhead. hls.js defaults to evicting the back
       * buffer aggressively, so nudging back 10s re-downloaded a fragment the
       * browser had held moments earlier — the exact "stutter when I move"
       * complaint. Bounded, so a two-hour film cannot pin memory.
       */
      backBufferLength: 90,
      /**
       * How far off a fragment's declared start a seek may land and still be
       * served by that fragment. The default (0.25) plus keyframe-aligned VOD
       * boundaries means a seek near a boundary can miss and refetch; 0.5
       * absorbs the rounding without ever picking a fragment the target is not
       * actually inside.
       */
      maxFragLookUpTolerance: 0.5,
      /** Fetch the first fragment while the manifest is still being processed. */
      startFragPrefetch: true,
      startLevel: -1,
      // ffmpeg writes an EVENT playlist with no #EXT-X-ENDLIST until it finishes,
      // so hls.js classes the session as live and would start at the live edge.
      // On a file that remuxes faster than real time that means pressing play
      // drops the viewer 80s into the film. The session always begins at the
      // position we asked ffmpeg for, so the start of its timeline is always 0.
      startPosition: 0,
      /** A stall should be nudged through, not surfaced as a fatal error. */
      nudgeMaxRetry: 10,
      // Don't give up too quickly — torrent data can be slow
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 2000,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 2000,
    });

    hls.loadSource(playableSrc);
    hls.attachMedia(video);

    /**
     * Abandon the in-flight fragment on a seek.
     *
     * Without this the loader finishes fetching the fragment for the position
     * the viewer just left — on a slow segment that is seconds of head-of-line
     * blocking in front of the fragment they actually asked for, felt as the
     * player sitting on the old frame. `stopLoad` aborts the request outright
     * and `startLoad(position)` restarts the pipeline at the new target.
     *
     * Debounced because a drag emits `seeking` continuously: restarting the
     * loader per event would cancel each fetch with the next one and never
     * finish any of them.
     */
    let seekRestartTimer: number | null = null;
    const onSeeking = () => {
      if (seekRestartTimer !== null) window.clearTimeout(seekRestartTimer);
      seekRestartTimer = window.setTimeout(() => {
        seekRestartTimer = null;
        try {
          hls.stopLoad();
          hls.startLoad(video.currentTime);
        } catch {
          /* instance already destroyed by a re-plan */
        }
      }, 120);
    };
    video.addEventListener("seeking", onSeeking);
    hlsSeekAbortRef.current = () => {
      if (seekRestartTimer !== null) window.clearTimeout(seekRestartTimer);
      video.removeEventListener("seeking", onSeeking);
    };

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setPreparingLabel(null);
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // Retry once — the transcode session may still be starting
          hls.startLoad();
        } else {
          setProblem("browser-error");
          setMessage("Playback failed. The file may still be preparing.");
          hls.destroy();
          hlsRef.current = null;
        }
      }
    });

    hlsRef.current = hls;
  }, [playableSrc, playbackMode]);

  /**
   * Seek on the *source* timeline.
   *
   * In HLS mode the media element only knows about the window ffmpeg has
   * produced since `timelineOffset`, so a target inside that window is a plain
   * `currentTime` write and anything outside it needs a session restart. In
   * native mode the element holds the whole file, so every target is a plain
   * write the browser resolves as a byte range.
   *
   * The displayed position moves *first*, before any of that. A seek that
   * leaves the clock on the old value while the frame is also still the old one
   * is indistinguishable from a freeze.
   */
  const handleSourceSeek = useCallback(
    (sourceSec: number) => {
      const video = videoRef.current;
      const target = Math.max(0, sourceDuration ? Math.min(sourceSec, sourceDuration) : sourceSec);
      setCurrentSourceTime(target);
      currentSourceTimeRef.current = target;
      setSeeking(true);
      scheduleSeekProgress();
      if (playbackMode !== "hls" || !video) {
        if (video) video.currentTime = target;
        return;
      }
      const produced = Number.isFinite(video.duration) ? video.duration : 0;
      const relative = target - timelineOffset;
      if (relative >= 0 && relative <= produced) {
        video.currentTime = relative;
        return;
      }
      seekToSource(target);
    },
    [playbackMode, timelineOffset, seekToSource, sourceDuration, scheduleSeekProgress],
  );

  /** Nudge the playhead by `delta` seconds on the source timeline. */
  const seekRelative = useCallback(
    (delta: number) => {
      handleSourceSeek(currentSourceTimeRef.current + delta);
    },
    [handleSourceSeek],
  );

  /**
   * Transport keys, on the player container rather than the document, so a
   * second player on the same page never steals them.
   *
   * Typing targets are excluded: the file/audio/subtitle selects and the seek
   * slider have their own keyboard behaviour, and stealing space or the arrows
   * from them would break the control the viewer is actually focused on.
   */
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (!playableSrc) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el?.isContentEditable) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      // Space on a focused button is that button's activation, not a transport
      // command; taking it would make the viewer's click do two things.
      if ((e.key === " " || e.key === "Spacebar") && tag === "BUTTON") return;

      switch (key) {
        case " ":
        case "spacebar":
        case "k":
          e.preventDefault();
          togglePlay();
          return;
        case "arrowleft":
        case "j":
          e.preventDefault();
          seekRelative(key === "j" ? -10 : -5);
          return;
        case "arrowright":
        case "l":
          e.preventDefault();
          seekRelative(key === "l" ? 10 : 5);
          return;
        case "f":
          e.preventDefault();
          goFullscreen();
          return;
        case "m":
          e.preventDefault();
          toggleMute();
          return;
        default:
      }
    },
    [playableSrc, togglePlay, seekRelative, goFullscreen, toggleMute],
  );

  /**
   * Everything a media element has to report, in one place, for both modes.
   *
   * Native mode used to mount `<video>` with no ref at all, so `videoRef` was
   * null there — which silently disabled the transport, the keyboard and any
   * position reporting for the one path that plays a local file best.
   */
  const attachNativeVideo = useCallback(
    (video: HTMLVideoElement | null) => {
      videoRef.current = video;
      hlsSeekAbortRef.current?.();
      hlsSeekAbortRef.current = null;
      if (!video) return;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    },
    [],
  );

  /** Apply a resume/seek position once the native element can accept one. */
  const applyPendingNativeSeek = useCallback((video: HTMLVideoElement) => {
    const target = pendingNativeSeekRef.current;
    if (target <= 0) return;
    pendingNativeSeekRef.current = 0;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration > 0 && target >= duration) return;
    try {
      video.currentTime = target;
    } catch {
      /* the element rejected the position; playback simply starts at 0 */
    }
  }, []);

  const reportNoAudio = useCallback(() => {
    setProblem("no-audio");
    setMessage(
      "This file's audio can't be decoded in a browser (usually Dolby AC-3/E-AC-3 or DTS). The video is fine — open it in your player for sound.",
    );
    setPlayableSrc(null);
  }, []);

  // Safari and Firefox implement audioTracks, so a zero-length track list is a
  // definitive answer as soon as metadata lands.
  const checkAudioTracks = useCallback(
    (video: HTMLVideoElement) => {
      const el = video as AudioTracksVideo;
      if (el.readyState > 0 && "audioTracks" in el && el.audioTracks?.length === 0) {
        reportNoAudio();
      }
    },
    [reportNoAudio],
  );

  // Chrome and Edge only reveal an undecodable audio stream by decoding video
  // bytes while the audio byte counter stays pinned at zero. Wait for real
  // playback progress before believing it: the counters are both 0 before the
  // first frames land, so checking any earlier reports every file as silent.
  const checkDecodedAudio = useCallback(
    (video: HTMLVideoElement) => {
      // Skip audio checks for HLS — the decision engine already handled it
      if (playbackMode === "hls") return;
      const el = video as AudioTracksVideo;
      if (typeof el.webkitAudioDecodedByteCount !== "number") return;
      if (typeof el.webkitVideoDecodedByteCount !== "number") return;
      if (el.paused || el.currentTime < 2) return;
      if (el.webkitVideoDecodedByteCount <= 0) return;
      if (el.webkitAudioDecodedByteCount > 0) return;
      reportNoAudio();
    },
    [reportNoAudio, playbackMode],
  );

  return (
    <div
      className={cn("w-full space-y-2", theatre && "space-y-0", className)}
      data-inline-player
      data-player-chrome={chrome}
      data-infohash={infoHash}
      data-playback-mode={playbackMode}
      data-playback-strategy={strategy ?? undefined}
      data-playback-rung={playbackRung ?? undefined}
      data-strategy-reason={strategyReason ?? undefined}
      data-resume-sec={resumeTargetSec > 0 ? resumeTargetSec : undefined}
      onKeyDown={handleKeyDown}
    >
      <div className={cn("flex flex-wrap items-center gap-1.5", theatre && "hidden")}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void toggleExpanded()}
          aria-expanded={expanded}
          aria-controls={panelId}
          data-stream-play-toggle
        >
          <Play className="h-3.5 w-3.5" />
          {expanded ? "Hide player" : "Play"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void copySelected()}
          data-stream-copy
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy stream URL"}
        </Button>
      </div>

      {expanded ? (
        <div
          id={panelId}
          className={cn(
            "space-y-2",
            theatre
              ? "bg-transparent"
              : "rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2.5 motion-safe:animate-[inline-player-expand_140ms_ease-out]",
          )}
        >
          <style>{`
            @keyframes inline-player-expand {
              from { opacity: 0; transform: translateY(-4px); }
              to { opacity: 1; transform: translateY(0); }
            }
            @media (prefers-reduced-motion: reduce) {
              [data-inline-player] [id="${panelId}"] { animation: none; }
            }
            /*
              The buffered band is painted *behind* the scrubber, so the input's
              own UA-drawn track has to get out of the way. Suppressing the track
              also removes the accent fill, so the played portion is drawn
              explicitly alongside the band — one bar, three layers, all in the
              same source coordinate space.
            */
            [data-inline-player] [data-stream-seek] {
              -webkit-appearance: none;
              appearance: none;
              background: transparent;
              height: 12px;
              cursor: pointer;
            }
            [data-inline-player] [data-stream-seek]::-webkit-slider-runnable-track {
              height: 4px;
              background: transparent;
              border-radius: 999px;
            }
            [data-inline-player] [data-stream-seek]::-webkit-slider-thumb {
              -webkit-appearance: none;
              appearance: none;
              height: 11px;
              width: 11px;
              margin-top: -3.5px;
              border-radius: 999px;
              background: var(--accent);
              border: none;
            }
            [data-inline-player] [data-stream-seek]::-moz-range-track {
              height: 4px;
              background: transparent;
              border-radius: 999px;
            }
            [data-inline-player] [data-stream-seek]::-moz-range-thumb {
              height: 11px;
              width: 11px;
              border: none;
              border-radius: 999px;
              background: var(--accent);
            }
            [data-inline-player] [data-stream-seek]:focus-visible {
              outline: 2px solid var(--accent);
              outline-offset: 2px;
              border-radius: 999px;
            }
          `}</style>

          {manifestLoading ? (
            <p className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Resolving files…
            </p>
          ) : null}

          {videoFiles.length > 1 ? (
            <label className="block space-y-1 text-[11px] text-[var(--text-tertiary)]">
              File
              <select
                value={selectedPath ?? ""}
                onChange={(e) => setSelectedPath(e.target.value || null)}
                data-stream-file-select
                className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-muted)] px-2 text-[12px] text-[var(--text)]"
              >
                <option value="">Pick a video file…</option>
                {videoFiles.map((file) => (
                  <option key={file.index} value={file.path}>
                    {file.path} · {formatBytes(file.length)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {message ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              {problem === "browser-error" || problem === "no-audio" ? (
                <X className="h-3.5 w-3.5 text-[var(--danger)]" />
              ) : null}
              <span>{message}</span>
              {selectedPath && problem !== "preparing" ? (
                <button
                  type="button"
                  className="font-medium text-[var(--accent-text)] hover:underline"
                  onClick={() => void copySelected()}
                >
                  Open in your player →
                </button>
              ) : null}
            </div>
          ) : null}

          {checkingStream ? (
            <p className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Probing file…
            </p>
          ) : null}

          {preparingLabel && !checkingStream ? (
            <p className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {preparingLabel}
            </p>
          ) : null}

          {playableSrc && selectedFile ? (
            <div className="space-y-1.5">
              <div className="relative">
              {playbackMode === "hls" ? (
                <video
                  data-stream-video
                  key={playableSrc}
                  ref={attachHls}
                  preload="auto"
                  className={cn(
                    "w-full bg-black",
                    theatre ? "max-h-[100dvh] object-contain" : "rounded-md",
                  )}
                  title={title}
                  onClick={togglePlay}
                  onError={() => {
                    if (!hlsRef.current) {
                      setProblem("browser-error");
                      setMessage("This release won't play in the browser.");
                      setPlayableSrc(null);
                    }
                  }}
                  onWaiting={() => setWaiting(true)}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => {
                    setIsPlaying(false);
                    postProgress({ force: true });
                  }}
                  onSeeking={() => setSeeking(true)}
                  onPlaying={() => { setWaiting(false); setSeeking(false); setPreparingLabel(null); }}
                  onCanPlay={(e) => { setWaiting(false); setPreparingLabel(null); readBuffered(e.currentTarget); }}
                  onProgress={(e) => readBuffered(e.currentTarget)}
                  onSeeked={(e) => { setSeeking(false); readBuffered(e.currentTarget); }}
                  onTimeUpdate={(e) => {
                    const position = timelineOffset + e.currentTarget.currentTime;
                    setCurrentSourceTime(position);
                    currentSourceTimeRef.current = position;
                    readBuffered(e.currentTarget);
                    postProgress();
                  }}
                >
                  {activeSubtitle ? (
                    <track
                      key={activeSubtitleSrc ?? activeSubtitle.id}
                      kind="subtitles"
                      src={activeSubtitleSrc ?? undefined}
                      srcLang={activeSubtitle.language ?? undefined}
                      label={activeSubtitle.label}
                      onLoad={() => setSubtitleStatus("ready")}
                      onError={() => {
                        setSubtitleStatus("error");
                        setSubtitleNote("That subtitle track could not be loaded.");
                      }}
                    />
                  ) : null}
                </video>
              ) : (
                <video
                  data-stream-video
                  key={playableSrc}
                  ref={attachNativeVideo}
                  controls
                  preload="metadata"
                  className={cn(
                    "w-full bg-black",
                    theatre ? "max-h-[100dvh] object-contain" : "rounded-md",
                  )}
                  src={playableSrc}
                  title={title}
                  onError={() => {
                    setProblem("browser-error");
                    setMessage("This release won't play in the browser.");
                    setPlayableSrc(null);
                  }}
                  onWaiting={() => setWaiting(true)}
                  onPlaying={() => { setWaiting(false); setSeeking(false); }}
                  onCanPlay={() => setWaiting(false)}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => {
                    setIsPlaying(false);
                    postProgress({ force: true });
                  }}
                  onSeeking={() => setSeeking(true)}
                  onSeeked={(e) => {
                    setSeeking(false);
                    readBuffered(e.currentTarget);
                    scheduleSeekProgress();
                  }}
                  onProgress={(e) => readBuffered(e.currentTarget)}
                  onLoadedMetadata={(e) => {
                    checkAudioTracks(e.currentTarget);
                    // Resume lands here rather than in the plan: the file is
                    // addressed by byte range, so the position is a single
                    // write the browser resolves — no ffmpeg session, no
                    // rebased timeline, nothing to tear down.
                    applyPendingNativeSeek(e.currentTarget);
                    if (!sourceDuration && Number.isFinite(e.currentTarget.duration)) {
                      setSourceDuration(e.currentTarget.duration);
                    }
                  }}
                  onLoadedData={(e) => checkAudioTracks(e.currentTarget)}
                  onTimeUpdate={(e) => {
                    checkDecodedAudio(e.currentTarget);
                    // Native mode plays the file itself, so the media timeline
                    // *is* the source timeline — no offset to add back.
                    const position = e.currentTarget.currentTime;
                    setCurrentSourceTime(position);
                    currentSourceTimeRef.current = position;
                    readBuffered(e.currentTarget);
                    postProgress();
                  }}
                >
                  {/*
                    No buffered band here on purpose: the native control bar is
                    kept in direct mode because the media timeline *is* the file,
                    and the browser already paints an accurate buffer on it. A
                    second bar would be the "two scrubbers" bug again.
                  */}
                  {activeSubtitle ? (
                    <track
                      key={activeSubtitleSrc ?? activeSubtitle.id}
                      kind="subtitles"
                      src={activeSubtitleSrc ?? undefined}
                      srcLang={activeSubtitle.language ?? undefined}
                      label={activeSubtitle.label}
                      default
                      onLoad={() => setSubtitleStatus("ready")}
                      onError={() => {
                        setSubtitleStatus("error");
                        setSubtitleNote("That subtitle track could not be loaded.");
                      }}
                    />
                  ) : null}
                </video>
              )}
              {seeking ? (
                <span
                  data-stream-seeking
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 grid place-items-center rounded-md bg-black/25"
                >
                  <Loader2 className="h-6 w-6 animate-spin text-white/90" />
                </span>
              ) : null}
              {playbackMode !== "hls" ? (
                /*
                  The native control bar already paints an accurate buffered
                  band in this mode — the media timeline *is* the file — so a
                  second visible bar would be the "two disagreeing scrubbers"
                  bug again. The ranges are still published, so a test (or a
                  reader debugging a stall) can read what is instant.
                */
                <span
                  hidden
                  data-stream-buffered
                  data-ranges={JSON.stringify(
                    bufferedRanges.map((r) => [
                      Math.round(r.start * 100) / 100,
                      Math.round(r.end * 100) / 100,
                    ]),
                  )}
                  data-ahead={
                    Math.round(bufferedAheadOf(bufferedRanges, currentSourceTime) * 100) / 100
                  }
                />
              ) : null}
              </div>
              {playbackMode === "hls" ? (
                <div data-stream-transport-row className="flex items-center gap-2">
                  <button
                    type="button"
                    data-stream-transport
                    onClick={togglePlay}
                    aria-label={isPlaying ? "Pause" : "Play"}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-black transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  >
                    {isPlaying ? (
                      <Pause className="h-3.5 w-3.5 fill-current" />
                    ) : (
                      <Play className="h-3.5 w-3.5 translate-x-px fill-current" />
                    )}
                  </button>
                  {sourceDuration && sourceDuration > 0 ? (
                    <>
                      <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                        {formatClock(currentSourceTime)}
                      </span>
                      <span className="relative flex min-w-0 flex-1 items-center">
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--border)]"
                        />
                        {/*
                          The buffered band, in *source* seconds. `data-ranges`
                          is the same array the bar is drawn from, so a test can
                          check the claim against `video.buffered` instead of
                          trusting a pixel.
                        */}
                        <span
                          data-stream-buffered
                          data-ranges={JSON.stringify(
                            bufferedRanges.map((r) => [
                              Math.round(r.start * 100) / 100,
                              Math.round(r.end * 100) / 100,
                            ]),
                          )}
                          data-ahead={
                            Math.round(bufferedAheadOf(bufferedRanges, currentSourceTime) * 100) / 100
                          }
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2"
                        >
                          {bufferedRanges.map((range) => (
                            <span
                              key={`${range.start}-${range.end}`}
                              data-stream-buffered-range
                              className="absolute top-0 h-full rounded-full bg-[var(--text-tertiary)]/70"
                              style={{
                                left: `${(range.start / sourceDuration) * 100}%`,
                                width: `${((range.end - range.start) / sourceDuration) * 100}%`,
                              }}
                            />
                          ))}
                        </span>
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--accent)]"
                          style={{
                            width: `${Math.max(0, Math.min(100, (currentSourceTime / sourceDuration) * 100))}%`,
                          }}
                        />
                        <input
                          type="range"
                          aria-label="Seek"
                          data-stream-seek
                          className="relative w-full min-w-0"
                          min={0}
                          max={Math.floor(sourceDuration)}
                          step={1}
                          value={Math.min(Math.floor(currentSourceTime), Math.floor(sourceDuration))}
                          onChange={(e) => setCurrentSourceTime(Number(e.target.value))}
                          onMouseUp={(e) => handleSourceSeek(Number(e.currentTarget.value))}
                          onKeyUp={(e) => handleSourceSeek(Number(e.currentTarget.value))}
                          onTouchEnd={(e) => handleSourceSeek(Number(e.currentTarget.value))}
                        />
                      </span>
                      <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                        {formatClock(sourceDuration)}
                      </span>
                    </>
                  ) : (
                    <span className="flex-1 text-[11px] text-[var(--text-tertiary)]">
                      Live position
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={toggleMute}
                    aria-label={muted ? "Unmute" : "Mute"}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded text-[var(--text-tertiary)] transition hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  >
                    {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={goFullscreen}
                    aria-label="Full screen"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded text-[var(--text-tertiary)] transition hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  >
                    <Maximize className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
              {audioTracks.length > 1 ? (
                <label className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
                  <span>Audio</span>
                  <select
                    className="min-w-0 flex-1 truncate rounded border border-[var(--border)] bg-transparent px-1.5 py-1 text-[11px]"
                    value={audioStreamIndex ?? ""}
                    data-stream-audio-select
                    onChange={(e) => {
                      // Restart at the current position so switching language
                      // doesn't throw the viewer back to the beginning.
                      pendingSeekRef.current = currentSourceTime;
                      setAudioStreamIndex(Number(e.target.value));
                    }}
                  >
                    {audioTracks.map((track, i) => (
                      <option key={track.streamIndex} value={track.streamIndex}>
                        {audioTrackLabel(track, i)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {subtitleTracks.length > 0 ? (
                <label className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
                  <span>Subtitles</span>
                  <select
                    className="min-w-0 flex-1 truncate rounded border border-[var(--border)] bg-transparent px-1.5 py-1 text-[11px]"
                    value={subtitleTrackId}
                    data-stream-subtitle-select
                    aria-label="Subtitles"
                    onChange={(e) => selectSubtitleTrack(e.target.value)}
                  >
                    <option value="">Off</option>
                    {subtitleTracks.map((track) => (
                      // A track that cannot become WebVTT is shown, because
                      // hiding it would make the release look like it has no
                      // subtitles at all — but it is not selectable, because
                      // selecting it could only ever render nothing.
                      <option key={track.id} value={track.id} disabled={!track.src}>
                        {track.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {subtitleStatus === "extracting" || subtitleStatus === "loading" ? (
                <p
                  data-stream-subtitle-status={subtitleStatus}
                  className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]"
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {subtitleStatus === "extracting"
                    ? "Extracting subtitles from the file…"
                    : "Loading subtitles…"}
                </p>
              ) : null}
              {subtitleNote ? (
                <p
                  data-stream-subtitle-status={subtitleStatus}
                  className="text-[11px] text-[var(--text-tertiary)]"
                >
                  {subtitleNote}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <SwarmChip infoHash={infoHash} active={Boolean(playableSrc)} />
                <p className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-tertiary)]">
                  {selectedFile.path} · {formatBytes(selectedFile.length)}
                </p>
              </div>
              {waiting ? (
                <p className="text-[12px] text-[var(--text-tertiary)] tabular-nums">
                  {bufferingLabel(progress)}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
