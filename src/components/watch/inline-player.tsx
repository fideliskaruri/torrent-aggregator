"use client";

import {
  Component,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SyntheticEvent as ReactSyntheticEvent,
} from "react";
import {
  Captions,
  Check,
  ChevronDown,
  Copy,
  Gauge,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";
import { cn, formatBytes } from "@/lib/utils";
import { infoHashFromMagnet } from "@/lib/torrents/infohash";
import { SwarmChip, swarmHealth, type SwarmSample } from "@/components/watch/swarm-chip";
import { subtitleListUrl, subtitleTrackSrc, type SubtitleTrack } from "@/lib/media/subtitles";
import type { ProgressUpdateBody } from "@/lib/browse/types";
import { parseEpisode } from "@/lib/torrents/episodes";
import { parseResolution, parseSourceTier, SOURCE_TIER } from "@/lib/torrents/quality";
import Hls from "hls.js";

// Re-export so existing consumers (tests, other components) keep working.
export { infoHashFromMagnet };

export type StreamFile = {
  path: string;
  length: number;
  index: number;
  downloadedRanges?: ByteRange[];
};

type StreamManifest = {
  infoHash: string;
  files: StreamFile[];
  clientType?: string;
  swarm?: SwarmSample;
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
   * Kept only for legacy embedded surfaces; the client row now opens theatre
   * directly because watching must not be a collapsible accessory of a torrent
   * management row.
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

type CandidateVerdict = "good" | "weak" | "dead" | "unknown";
type CandidatePlayability = "direct" | "transcode" | "unknown";

export const PLAYER_CONTROL_SET = [
  "play-pause",
  "skip-back",
  "skip-forward",
  "clock",
  "timeline",
  "volume",
  "speed",
  "subtitles",
  "audio-settings",
  "quality",
  "fullscreen",
] as const;

export type PlayerControlId = (typeof PLAYER_CONTROL_SET)[number];

export function playerControlsForMode(_mode: "inline" | "theatre" | "fullscreen"): readonly PlayerControlId[] {
  return PLAYER_CONTROL_SET;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function qualitySelectorEmptyCopy(loading: boolean, count: number): string | null {
  if (count > 0) return null;
  return loading ? "Checking cached releases…" : "No other cached releases yet.";
}

/**
 * Shared box model for every quality-selector row. Pinning the same
 * `min-h` on the loaded button and the loading skeleton keeps a row's
 * height identical across the load transition, so the panel reserves its
 * space up front and never jitters as candidates arrive.
 */
const QUALITY_ROW_BASE =
  "flex w-full min-h-[77px] items-start gap-3 rounded-xl px-3 py-2.5 text-left";

/**
 * Placeholder row rendered while cached releases load. It mirrors the loaded
 * row's dot + three text lines so the reserved space matches the real result.
 */
function QualityCandidateSkeletonRow() {
  return (
    <div data-quality-skeleton aria-hidden className={cn(QUALITY_ROW_BASE, "cursor-default")}>
      <SkeletonBlock className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <SkeletonBlock className="h-[15px] w-1/2 rounded" />
        <SkeletonBlock className="mt-2 h-[13px] w-3/4 rounded" />
        <SkeletonBlock className="mt-2 h-[12px] w-2/3 rounded" />
      </div>
    </div>
  );
}

type PlaybackCandidate = {
  infoHash: string;
  title: string;
  resolution: number | null;
  sourceLabel: "BluRay" | "WEB-DL" | "WEBRip" | "HDTV" | "Unknown";
  sizeBytes: number | null;
  sizeLabel: string | null;
  codec: string | null;
  audio: string | null;
  playability: CandidatePlayability;
  seeders: number;
  isCurrent: boolean;
  verdict: CandidateVerdict;
};

type CandidatesResponse = {
  candidates?: PlaybackCandidate[];
};

type SwitchResponse =
  | { ok: true; infoHash: string; positionSec: number | null }
  | { ok: false; reason: "not-a-candidate" | "start-failed" };

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

export function candidateVerdictLabel(verdict: CandidateVerdict): string {
  if (verdict === "good") return "Fast";
  if (verdict === "weak") return "Slow";
  if (verdict === "dead") return "Not delivering";
  return "Untested";
}

export function candidatePlayabilityLabel(playability: CandidatePlayability): string {
  if (playability === "direct") return "Plays instantly";
  if (playability === "transcode") return "Needs converting";
  return "Compatibility unknown";
}

export function candidateQualityShape(candidate: PlaybackCandidate): string {
  return [
    candidate.resolution ? `${candidate.resolution}p` : null,
    candidate.sourceLabel !== "Unknown" ? candidate.sourceLabel : null,
    candidate.codec,
    candidate.audio,
    candidate.sizeLabel ?? (candidate.sizeBytes ? formatBytes(candidate.sizeBytes) : null),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function isUpNextPlayableEnoughToAdvance(
  availability: UpNextAvailability | null | undefined,
): boolean {
  return availability === "ready" || availability === "downloading";
}

export function nextViewerWaitingState(
  current: boolean,
  event: "waiting" | "playing" | "canplay" | "advancing",
  active: boolean,
): boolean {
  if (!active) return current;
  return event === "waiting";
}

export function shouldShowViewerBuffering(args: {
  waiting: boolean;
  activeVideoAdvancing: boolean;
}): boolean {
  return args.waiting && !args.activeVideoAdvancing;
}

export function shouldShowFullscreenStatusOverlay(args: {
  hasVisibleVideo: boolean;
  viewerWaiting: boolean;
  preparing: boolean;
  activeVideoAdvancing: boolean;
}): boolean {
  if (args.hasVisibleVideo && args.activeVideoAdvancing) return false;
  return !args.hasVisibleVideo || args.viewerWaiting || args.preparing;
}

export function shouldShowSeekSpinner(args: {
  seeking: boolean;
  activeVideoAdvancing: boolean;
}): boolean {
  return args.seeking && !args.activeVideoAdvancing;
}

/**
 * Minimum forward `currentTime` growth that counts as the picture advancing.
 * Kept just above float noise and well under one frame (~0.033s) so that slow,
 * throttled-but-advancing playback keeps renewing the motion lease.
 */
const MEDIA_ADVANCE_EPSILON = 0.01;

export type MediaErrorKind = "aborted" | "network" | "decode" | "unsupported" | "unknown";

export function mediaErrorKindFromCode(code: number | null | undefined): MediaErrorKind {
  switch (code) {
    case 1:
      return "aborted";
    case 2:
      return "network";
    case 3:
      return "decode";
    case 4:
      return "unsupported";
    default:
      return "unknown";
  }
}

export function interpretMediaElementError(error: Pick<MediaError, "code" | "message"> | null | undefined): {
  kind: MediaErrorKind;
  recoverable: boolean;
  problem: StreamProblem | null;
  title: string;
  detail: string;
} {
  const kind = mediaErrorKindFromCode(error?.code);
  const browserMessage = error?.message?.trim();
  if (kind === "aborted") {
    return {
      kind: "aborted",
      recoverable: true,
      problem: null,
      title: "Playback was interrupted.",
      detail: browserMessage || "The browser interrupted the stream. Reconnecting from your current position.",
    };
  }
  if (kind === "network") {
    return {
      kind: "network",
      recoverable: true,
      problem: null,
      title: "This release isn't delivering.",
      detail: browserMessage || "The stream connection dropped. Reconnecting from your current position.",
    };
  }
  if (kind === "decode") {
    return {
      kind: "decode",
      recoverable: false,
      problem: "browser-error",
      title: "This release won't play in the browser.",
      detail: browserMessage || "The browser reported a decode error after receiving the file.",
    };
  }
  if (kind === "unsupported") {
    return {
      kind: "unsupported",
      recoverable: false,
      problem: "browser-error",
      title: "This release won't play in the browser.",
      detail: browserMessage || "The browser does not support this stream's container or codecs.",
    };
  }
  return {
    kind: "unknown",
    recoverable: false,
    problem: "browser-error",
    title: "This release won't play in the browser.",
    detail: browserMessage || "The browser stopped playback without a specific media error code.",
  };
}

export function terminalPlaybackCopy(args: {
  problem: StreamProblem | null;
  message: string | null;
  deliveryDetail: string;
}): { title: string | null; detail: string | null } {
  const { problem, message, deliveryDetail } = args;
  const title =
    problem === "stalled" || problem === "preparing"
      ? "This release isn't delivering."
      : problem === "browser-error" || problem === "no-audio"
        ? "This release won't play in the browser."
        : message
          ? "Playback cannot start yet."
          : null;
  const fallback =
    problem === "stalled" || problem === "preparing"
      ? `This release isn't delivering — ${deliveryDetail}.`
      : problem === "browser-error"
        ? "The browser reported a playback error for this release."
        : problem === "no-audio"
          ? "The browser cannot decode the selected audio track."
          : message;
  const repeatsTitle = (value: string | null | undefined) =>
    Boolean(title && value && value.trim() === title.trim());
  const detail = message && !repeatsTitle(message) ? message : fallback && !repeatsTitle(fallback) ? fallback : null;
  return { title, detail };
}

export function upNextUnavailableActionLabel(): string {
  return "Not fetched yet";
}

export type SeekIntent = {
  targetSec: number;
  actualSec: number;
  attempts: number;
  elapsedMs: number;
};

export function nextSeekIntentAction(
  intent: SeekIntent | null,
  toleranceSec = 2,
  retryDelayMs = 700,
  maxAttempts = 3,
): "none" | "settled" | "wait" | "retry" | "failed" {
  if (!intent) return "none";
  if (Math.abs(intent.targetSec - intent.actualSec) <= toleranceSec) return "settled";
  if (intent.attempts >= maxAttempts) return "failed";
  if (intent.elapsedMs < retryDelayMs) return "wait";
  return "retry";
}

/**
 * Decide what a source-timeline seek should do when a session restart may
 * already be in flight.
 *
 * In HLS mode a seek past the produced window respawns ffmpeg, which takes a
 * moment. The old code guarded that respawn with a boolean and *dropped* any
 * seek that arrived while it was busy, so a viewer tapping the arrow keys had to
 * press three times: the first started a restart, the second was silently
 * discarded, and only the third — after the restart settled — took effect.
 *
 * Instead, never drop: if nothing is in flight, `start`; if a restart is in
 * flight toward a *different* target, `replan` (abort the stale plan and restart
 * toward the newest target so the last gesture always wins); only `ignore` a
 * repeat of the target already being planned, which would just thrash ffmpeg.
 */
export function nextSeekRestartAction(
  args: {
    inFlight: boolean;
    inFlightTargetSec: number | null;
    requestedTargetSec: number;
  },
  toleranceSec = 2,
): "start" | "replan" | "ignore" {
  if (!args.inFlight) return "start";
  if (
    args.inFlightTargetSec != null &&
    Math.abs(args.inFlightTargetSec - args.requestedTargetSec) <= toleranceSec
  ) {
    return "ignore";
  }
  return "replan";
}

export function canAutoAdvanceToUpNext(
  next: UpNextEpisodeCard | null,
  cancelled: boolean,
): boolean {
  return Boolean(!cancelled && next?.infoHash && isUpNextPlayableEnoughToAdvance(next.availability));
}

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

function episodeFromFilePath(path: string): { season: number; episode: number } | null {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const patterns = [
    /(?:^|[^a-z0-9])s0*([1-9]\d*)[\s._-]*e0*([1-9]\d*)(?=$|[^a-z0-9])/i,
    /(?:^|[^a-z0-9])0*([1-9]\d*)x0*([1-9]\d*)(?=$|[^a-z0-9])/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(name);
    if (!match) continue;
    return {
      season: Number(match[1]),
      episode: Number(match[2]),
    };
  }
  const parsed = parseEpisode(name);
  if (parsed.season != null && parsed.episode != null) {
    return { season: parsed.season, episode: parsed.episode };
  }
  return null;
}

export function resolveVideoFileSelection(
  files: StreamFile[],
  target: { season?: number | null; episode?: number | null },
): StreamFile | null {
  const videos = selectVideoFiles(files);
  if (videos.length === 1) return videos[0];
  if (videos.length === 0) return null;
  const season = target.season;
  const episode = target.episode;
  if (season == null || episode == null) return null;
  const matches = videos.filter((file) => {
    const parsed = episodeFromFilePath(file.path);
    return parsed?.season === season && parsed.episode === episode;
  });
  return matches.length === 1 ? matches[0] : null;
}

function videoFileForPath(files: StreamFile[], path: string | null): StreamFile | null {
  if (!path) return null;
  return selectVideoFiles(files).find((file) => file.path === path) ?? null;
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

export type UpNextAvailability = "ready" | "downloading" | "not-fetched";

type UpNextEpisodeCard = {
  title: string;
  label: string;
  season: number;
  episode: number;
  availability: UpNextAvailability;
  infoHash: string | null;
  progress: number | null;
};

type UpNextResponse = {
  ok?: boolean;
  next?: UpNextEpisodeCard | null;
};

type CurrentTarget = {
  infoHash: string;
  title: string;
  resumeSec?: number;
  season?: number | null;
  episode?: number | null;
  posterUrl?: string | null;
  watchListItemId?: string | null;
};

const AUTO_ADVANCE_SECONDS = 8;
const SEEK_RETRY_DELAY_MS = 700;
const SEEK_TOLERANCE_SECONDS = 2;
const SEEK_MAX_ATTEMPTS = 3;

function sourceChip(title: string): string | null {
  const tier = parseSourceTier(title);
  if (tier === SOURCE_TIER.WEBDL) return "WEB-DL";
  if (tier === SOURCE_TIER.WEBRIP) return /\bweb[-_. ]?rip\b/i.test(title) ? "WEBRip" : null;
  if (tier === SOURCE_TIER.HDTV) return "HDTV";
  if (tier === SOURCE_TIER.BLURAY) return "BluRay";
  return null;
}

function audioChip(title: string): string | null {
  const t = title.replace(/[._-]+/g, " ");
  if (/\bddp?\s*5\s*\.?\s*1\b/i.test(t) || /\be[- ]?ac[- ]?3\b/i.test(t)) return "DDP5.1";
  if (/\bac[- ]?3\b/i.test(t)) return "AC-3";
  if (/\baac\s*5\s*\.?\s*1\b/i.test(t)) return "AAC 5.1";
  if (/\baac\b/i.test(t)) return "AAC";
  if (/\bdts(?:[- ]?hd)?\b/i.test(t)) return "DTS";
  if (/\bflac\b/i.test(t)) return "FLAC";
  if (/\bopus\b/i.test(t)) return "Opus";
  return null;
}

function videoCodecChip(title: string): string | null {
  const t = title.replace(/[._-]+/g, " ");
  if (/\b(?:h\s*\.?\s*264|x264|avc)\b/i.test(t)) return "H.264";
  if (/\b(?:h\s*\.?\s*265|x265|hevc)\b/i.test(t)) return "H.265";
  if (/\bav1\b/i.test(t)) return "AV1";
  if (/\bvp9\b/i.test(t)) return "VP9";
  return null;
}

/**
 * Technical identity belongs in diagnostics, not as the viewer's label. The
 * release path can be a tracker wrapper folder plus a scene filename, which is
 * why the old chip read like a filesystem accident. These chips reuse the same
 * episode and quality parsers the rest of the app trusts, then show only facts a
 * viewer can use: resolution, source, audio/video shape and size.
 */
export function releaseDetailChips(path: string, bytes: number): string[] {
  const filename = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
  const withoutExt = filename.replace(/\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts|mpe?g)$/i, "");
  const parsed = parseEpisode(withoutExt);
  void parsed;
  const chips: string[] = [];
  const resolution = parseResolution(withoutExt);
  if (resolution) chips.push(`${resolution}p`);
  const source = sourceChip(withoutExt);
  if (source) chips.push(source);
  const audio = audioChip(withoutExt);
  if (audio) chips.push(audio);
  const codec = videoCodecChip(withoutExt);
  if (codec) chips.push(codec);
  if (Number.isFinite(bytes) && bytes > 0) chips.push(formatBytes(bytes));
  return chips;
}

export function upNextStatusSentence(state: UpNextAvailability): string {
  if (state === "ready") return "Ready to play now.";
  if (state === "downloading") {
    return "Still downloading — you can start streaming, but it may buffer.";
  }
  return "Not fetched yet.";
}

export function streamStateSentence(args: {
  checking: boolean;
  preparing: boolean;
  waiting: boolean;
  playing: boolean;
  playable?: boolean;
  swarm?: SwarmSample | null;
  minimumStreamBps?: number;
}): string {
  if (args.checking) return "Checking whether this file can play now.";
  if (args.preparing) {
    return "Preparing playback — this usually takes under a minute once pieces arrive.";
  }
  const health = swarmHealth(args.swarm ?? null, args.minimumStreamBps ?? 0);
  if (args.waiting && health === "thin" && (args.swarm?.downloadSpeedBps ?? 0) > 0) {
    return "Too slow to stream — downloading in the background.";
  }
  if (args.waiting) return "Buffering — waiting for enough of the file.";
  if (args.playing) return "Playing now.";
  if (args.playable) return "Ready to play.";
  return "Waiting for a playable file.";
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
export type ByteRange = { start: number; end: number };

function sameRanges(a: SourceRange[], b: SourceRange[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (r, i) =>
        Math.abs(r.start - b[i].start) < 0.05 &&
        Math.abs(r.end - b[i].end) < 0.05,
    )
  );
}

export function byteRangesToSourceRanges(
  byteRanges: ByteRange[] | null | undefined,
  fileLength: number,
  sourceDuration: number | null,
): SourceRange[] {
  if (!byteRanges || !fileLength || fileLength <= 0 || !sourceDuration || sourceDuration <= 0) {
    return [];
  }
  const out: SourceRange[] = [];
  for (const range of byteRanges) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) continue;
    const startByte = Math.max(0, Math.min(fileLength, range.start));
    const endByte = Math.max(0, Math.min(fileLength, range.end));
    if (endByte <= startByte) continue;
    const next = {
      start: (startByte / fileLength) * sourceDuration,
      end: (endByte / fileLength) * sourceDuration,
    };
    const last = out[out.length - 1];
    if (last && next.start <= last.end + 0.05) {
      last.end = Math.max(last.end, next.end);
    } else {
      out.push(next);
    }
  }
  return out;
}

export function sourceTimeInRanges(ranges: SourceRange[], position: number): boolean {
  return ranges.some((range) => position >= range.start - 0.5 && position <= range.end + 0.5);
}

function roundedRangeData(ranges: SourceRange[]): string {
  return JSON.stringify(
    ranges.map((r) => [
      Math.round(r.start * 100) / 100,
      Math.round(r.end * 100) / 100,
    ]),
  );
}

function TimelineBands({
  sourceDuration,
  bufferedRanges,
  downloadedRanges,
  currentSourceTime,
}: {
  sourceDuration: number;
  bufferedRanges: SourceRange[];
  downloadedRanges: SourceRange[];
  currentSourceTime: number;
}) {
  return (
    <>
      <span
        data-stream-downloaded
        data-ranges={roundedRangeData(downloadedRanges)}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2"
      >
        {downloadedRanges.map((range) => (
          <span
            key={`downloaded-${range.start}-${range.end}`}
            data-stream-downloaded-range
            className="absolute top-0 h-full rounded-full bg-[var(--accent)]/35"
            style={{
              left: `${(range.start / sourceDuration) * 100}%`,
              width: `${((range.end - range.start) / sourceDuration) * 100}%`,
            }}
          />
        ))}
      </span>
      <span
        data-stream-buffered
        data-ranges={roundedRangeData(bufferedRanges)}
        data-ahead={Math.round(bufferedAheadOf(bufferedRanges, currentSourceTime) * 100) / 100}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2"
      >
        {bufferedRanges.map((range) => (
          <span
            key={`buffered-${range.start}-${range.end}`}
            data-stream-buffered-range
            className="absolute top-0 h-full rounded-full bg-white/70"
            style={{
              left: `${(range.start / sourceDuration) * 100}%`,
              width: `${((range.end - range.start) / sourceDuration) * 100}%`,
            }}
          />
        ))}
      </span>
    </>
  );
}

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
  /** Track id the server chose to auto-enable (English sub on foreign audio). */
  defaultTrackId?: string | null;
  /** Full default-subtitle decision, incl. `noEnglishAvailable`. */
  subtitleDefault?: { noEnglishAvailable?: boolean } | null;
  embeddedInspected?: boolean;
  probeError?: string | null;
};

type SubtitleStatus = "idle" | "loading" | "extracting" | "ready" | "error";

/** Human-readable label for what the playback ladder is doing. */function rungLabel(rung: string): string {
  switch (rung) {
    case "direct": return "Playing directly";
    case "remux":
    case "transcode-audio":
    case "transcode-full":
      return "Preparing playback — this usually takes under a minute once pieces arrive.";
    default: return "Preparing playback…";
  }
}

class InlinePlayerErrorBoundary extends Component<
  { children: ReactNode; title: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        data-inline-player-error
        className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-[12px] text-[var(--text-secondary)]"
      >
        <p className="font-medium text-[var(--text-primary)]">The player hit an error.</p>
        <p className="mt-1">
          {this.props.title} is still in your library. Retry the player, or use the other title
          actions while this recovers.
        </p>
        <button
          type="button"
          className="mt-2 rounded-full border border-[var(--border)] px-3 py-1 text-[12px] font-medium text-[var(--accent-text)]"
          onClick={() => this.setState({ failed: false })}
        >
          Retry player
        </button>
      </div>
    );
  }
}

export function InlineStreamPlayer(props: InlinePlayerProps) {
  return (
    <InlinePlayerErrorBoundary key={props.infoHash} title={props.title}>
      <InlineStreamPlayerInner {...props} />
    </InlinePlayerErrorBoundary>
  );
}

function InlineStreamPlayerInner({
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
  const [target, setTarget] = useState<CurrentTarget>({
    infoHash,
    title,
    resumeSec,
    season,
    episode,
    posterUrl,
    watchListItemId,
  });
  const activeInfoHash = target.infoHash;
  const activeTitle = target.title;
  const activeSeason = target.season;
  const activeEpisode = target.episode;
  const activePosterUrl = target.posterUrl;
  const activeWatchListItemId = target.watchListItemId;
  const searchHref = useMemo(
    () => `/search?q=${encodeURIComponent(activeTitle.trim() || title)}`,
    [activeTitle, title],
  );
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
  const [activeVideoAdvancing, setActiveVideoAdvancing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [preparingLabel, setPreparingLabel] = useState<string | null>(null);
  const [swarmSample, setSwarmSample] = useState<SwarmSample | null>(null);
  const [upNext, setUpNext] = useState<UpNextEpisodeCard | null>(null);
  const [upNextLoading, setUpNextLoading] = useState(false);
  const [ended, setEnded] = useState(false);
  const [transitioningTitle, setTransitioningTitle] = useState<string | null>(null);
  const [autoAdvanceCancelled, setAutoAdvanceCancelled] = useState(false);
  const [advanceCountdown, setAdvanceCountdown] = useState(AUTO_ADVANCE_SECONDS);
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
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [fullscreenActive, setFullscreenActive] = useState(false);
  /**
   * Buffered spans in *source* seconds: decoded bytes the media element can play
   * immediately. This is deliberately separate from downloaded spans; a torrent
   * can hold far-ahead sparse islands that are not in the decoder buffer yet.
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
   const [theatreControlsVisible, setTheatreControlsVisible] = useState(true);
   const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false);
   const [audioMenuOpen, setAudioMenuOpen] = useState(false);
   const [volumeMenuOpen, setVolumeMenuOpen] = useState(false);
   const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
   const [qualityCandidates, setQualityCandidates] = useState<PlaybackCandidate[]>([]);
   const [qualityLoading, setQualityLoading] = useState(false);
   const [qualityError, setQualityError] = useState<string | null>(null);
   const [switchingInfoHash, setSwitchingInfoHash] = useState<string | null>(null);
   const [seekHoverTime, setSeekHoverTime] = useState<number | null>(null);
   const [playPulse, setPlayPulse] = useState<"play" | "pause" | null>(null);
   const hlsRef = useRef<Hls | null>(null);
   const videoRef = useRef<HTMLVideoElement | null>(null);
   const fullscreenSurfaceRef = useRef<HTMLDivElement | null>(null);
   const motionLeaseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
   const lastActiveMediaTimeRef = useRef<number | null>(null);
   const requestedSeekRef = useRef<{ targetSec: number; attempts: number; attemptedAt: number } | null>(null);
   const seekRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Pending seek target on the source timeline, consumed by the next plan. */
  const pendingSeekRef = useRef(0);
  const seekInFlightRef = useRef(false);
  /** Target of the HLS session restart currently in flight, for coalescing. */
  const seekPlanTargetRef = useRef<number | null>(null);
  const controlsIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playPulseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    typeof target.resumeSec === "number" &&
    Number.isFinite(target.resumeSec) &&
    target.resumeSec > RESUME_MIN_SEC
      ? Math.floor(target.resumeSec)
      : 0;

  useEffect(() => {
    setTarget({
      infoHash,
      title,
      resumeSec,
      season,
      episode,
      posterUrl,
      watchListItemId,
    });
  }, [infoHash, title, resumeSec, season, episode, posterUrl, watchListItemId]);

  const activeManifest = manifest?.infoHash === activeInfoHash ? manifest : null;
  const videoFiles = useMemo(
    () => (activeManifest ? selectVideoFiles(activeManifest.files) : []),
    [activeManifest],
  );
  const selectedFile = activeManifest
    ? videoFileForPath(activeManifest.files, selectedPath)
    : null;
  const effectiveSelectedPath = selectedFile?.path ?? null;
  const parsedCurrentEpisode = useMemo(() => {
    const fromFile = selectedFile ? parseEpisode(selectedFile.path) : null;
    if (fromFile?.season != null && fromFile.episode != null) {
      return { season: fromFile.season, episode: fromFile.episode };
    }
    const fromTitle = parseEpisode(activeTitle);
    if (fromTitle.season != null && fromTitle.episode != null) {
      return { season: fromTitle.season, episode: fromTitle.episode };
    }
    return null;
  }, [selectedFile, activeTitle]);
  const currentSeason = activeSeason ?? parsedCurrentEpisode?.season ?? null;
  const currentEpisode = activeEpisode ?? parsedCurrentEpisode?.episode ?? null;
  const requestedEpisode = useMemo(() => {
    if (currentSeason != null && currentEpisode != null) {
      return { season: currentSeason, episode: currentEpisode };
    }
    return episodeFromFilePath(activeTitle);
  }, [currentSeason, currentEpisode, activeTitle]);
  const currentMediaType = currentSeason != null || currentEpisode != null ? "tv" : "movie";
  const downloadedRanges = useMemo(
    () =>
      selectedFile
        ? byteRangesToSourceRanges(
            selectedFile.downloadedRanges,
            selectedFile.length,
            sourceDuration,
          )
        : [],
    [selectedFile, sourceDuration],
  );
  const currentTimeHeld = downloadedRanges.length > 0
    ? sourceTimeInRanges(downloadedRanges, currentSourceTime)
    : null;
  const minimumStreamBps =
    selectedFile && sourceDuration && sourceDuration > 0
      ? (selectedFile.length / sourceDuration) * 1.15
      : 0;
  const viewerWaiting = shouldShowViewerBuffering({ waiting, activeVideoAdvancing });
  const stateSentence = streamStateSentence({
    checking: checkingStream,
    preparing: Boolean(preparingLabel),
    waiting: viewerWaiting,
    playing: isPlaying,
    playable: Boolean(playableSrc),
    swarm: swarmSample,
    minimumStreamBps,
  });
  const releaseChips = selectedFile
    ? releaseDetailChips(selectedFile.path, selectedFile.length)
    : [];
  /**
   * The subtitle file a release ships *next to* the video under the exact same
   * name. Direct mode used to mount this as a `default` `<track>`, so it is kept
   * as the picker's initial selection — losing an auto-enabled subtitle would be
   * a regression a viewer notices immediately.
   */
  const defaultSidecarPath = useMemo(
    () =>
      activeManifest && effectiveSelectedPath
        ? findSidecarSubtitle(activeManifest.files, effectiveSelectedPath)?.path ?? null
        : null,
    [activeManifest, effectiveSelectedPath],
  );
  const clearMotionLease = useCallback(() => {
    if (motionLeaseRef.current) {
      clearTimeout(motionLeaseRef.current);
      motionLeaseRef.current = null;
    }
  }, []);

  const clearSeekRetry = useCallback(() => {
    if (seekRetryTimerRef.current) {
      clearTimeout(seekRetryTimerRef.current);
      seekRetryTimerRef.current = null;
    }
  }, []);

  const activeMediaEvent = useCallback(
    (video: HTMLVideoElement, event: "waiting" | "playing" | "canplay" | "advancing") => {
      const active = video === videoRef.current;
      setWaiting((current) => nextViewerWaitingState(current, event, active));
      if (!active) return false;
      if (event === "advancing") {
        setActiveVideoAdvancing(true);
        clearMotionLease();
        motionLeaseRef.current = setTimeout(() => {
          motionLeaseRef.current = null;
          setActiveVideoAdvancing(false);
        }, 1500);
      }
      return true;
    },
    [clearMotionLease],
  );

  const noteActiveMediaTime = useCallback(
    (video: HTMLVideoElement, sourceTime: number) => {
      if (video !== videoRef.current) return false;
      const previous = lastActiveMediaTimeRef.current;
      lastActiveMediaTimeRef.current = sourceTime;
      // Any real forward progress renews the motion lease. The threshold only
      // needs to clear float/precision noise — it must stay well under a single
      // frame (~0.033s) so that slow, throttled-but-advancing playback (where
      // timeupdate deltas dip below a frame) still counts as advancing and never
      // flashes the buffering overlay over a moving picture.
      if (previous != null && sourceTime > previous + MEDIA_ADVANCE_EPSILON) {
        activeMediaEvent(video, "advancing");
      }
      return true;
    },
    [activeMediaEvent],
  );

  useEffect(() => {
    setManifest(null);
    setManifestLoading(false);
    setSelectedPath(null);
    setMessage(null);
    setProblem(null);
    setPlayableSrc(null);
    setPlaybackMode("direct");
    setCheckingStream(false);
    setWaiting(false);
    setActiveVideoAdvancing(false);
    setPreparingLabel(null);
    setSwarmSample(null);
    setUpNext(null);
    setUpNextLoading(false);
    setEnded(false);
    setAutoAdvanceCancelled(false);
    setAdvanceCountdown(AUTO_ADVANCE_SECONDS);
    setCurrentSourceTime(0);
    setSourceDuration(null);
    setTimelineOffset(0);
    setBufferedRanges([]);
    setQualityMenuOpen(false);
    setQualityCandidates([]);
    setQualityLoading(false);
    setQualityError(null);
    setSwitchingInfoHash(null);
    setPlanNonce((n) => n + 1);
    resumeConsumedRef.current = false;
    pendingSeekRef.current = 0;
    pendingNativeSeekRef.current = 0;
    lastActiveMediaTimeRef.current = null;
    requestedSeekRef.current = null;
    clearMotionLease();
    clearSeekRetry();
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, [activeInfoHash, clearMotionLease, clearSeekRetry]);

  // Clean up HLS instance on unmount or source change
  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      clearMotionLease();
      clearSeekRetry();
    };
  }, [clearMotionLease, clearSeekRetry]);

  useEffect(() => {
    setWaiting(false);
    setActiveVideoAdvancing(false);
    lastActiveMediaTimeRef.current = null;
    requestedSeekRef.current = null;
    clearMotionLease();
    clearSeekRetry();
  }, [playableSrc, clearMotionLease, clearSeekRetry]);

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
        if (sameRanges(prev, next)) return prev;
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
    selectedPathRef.current = effectiveSelectedPath;
    // A different file is a different progress row; the throttle must not carry
    // the previous file's position over and suppress the first write.
    lastPostedSecRef.current = null;
    lastPostedAtRef.current = null;
  }, [effectiveSelectedPath]);

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
      if (!filePath || !activeInfoHash) return;
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
        infoHash: activeInfoHash,
        filePath,
        positionSec,
        durationSec: Math.floor(usableDuration),
        title: activeTitle,
        season: currentSeason,
        episode: currentEpisode,
        posterUrl: activePosterUrl ?? null,
        watchListItemId: activeWatchListItemId ?? null,
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
    [
      activeInfoHash,
      activeTitle,
      currentSeason,
      currentEpisode,
      activePosterUrl,
      activeWatchListItemId,
    ],
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
      const url = `${window.location.origin}${streamPath(activeInfoHash, path)}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (!theatre) setMessage("Stream URL copied.");
      window.setTimeout(() => setCopied(false), 1600);
    },
    [activeInfoHash, theatre],
  );

  const loadManifest = useCallback(async () => {
    if (manifest?.infoHash === activeInfoHash) return manifest;
    setManifestLoading(true);
    setMessage(null);
    setProblem(null);
    try {
      const res = await fetch(`/api/stream/${encodeURIComponent(activeInfoHash)}`);
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
      const next: StreamManifest = { infoHash: activeInfoHash, files, clientType: data?.clientType };
      setManifest(next);
      const videos = selectVideoFiles(files);
      const requested = resolveVideoFileSelection(files, {
        season: requestedEpisode?.season,
        episode: requestedEpisode?.episode,
      });
      if (requested) {
        setSelectedPath(requested.path);
      } else if (videos.length > 1) {
        setProblem(null);
        setMessage("Choose the episode to play from this season pack.");
      }
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
  }, [activeInfoHash, manifest, requestedEpisode]);

  const fetchPlayerSample = useCallback(
    async (signal: AbortSignal): Promise<SwarmSample | null> => {
      const params = new URLSearchParams({ poll: "1" });
      if (effectiveSelectedPath) params.set("file", effectiveSelectedPath);
      const res = await fetch(`/api/stream/${encodeURIComponent(activeInfoHash)}?${params}`, {
        signal,
        cache: "no-store",
      });
      if (!res.ok && res.status !== 425) return null;
      const body = await readJson<StreamManifest>(res);
      if (!body) return null;
      if (Array.isArray(body.files)) {
        setManifest((prev) => ({
          infoHash: activeInfoHash,
          files: body.files.map((file) => {
            if ("downloadedRanges" in file) return file;
            const previous = prev?.infoHash === activeInfoHash
              ? prev.files.find((p) => p.path === file.path)
              : null;
            return previous?.downloadedRanges ? { ...file, downloadedRanges: previous.downloadedRanges } : file;
          }),
          clientType: body.clientType ?? prev?.clientType,
        }));
      }
      const swarm = body.swarm;
      if (!swarm || typeof swarm !== "object") return null;
      return {
        peers: typeof swarm.peers === "number" ? swarm.peers : null,
        downloadSpeedBps:
          typeof swarm.downloadSpeedBps === "number" ? swarm.downloadSpeedBps : null,
        progress: typeof swarm.progress === "number" ? swarm.progress : null,
        observedAt: typeof swarm.observedAt === "number" ? swarm.observedAt : Date.now(),
      };
    },
    [activeInfoHash, effectiveSelectedPath],
  );

  const copySelected = useCallback(async () => {
    const loaded = await loadManifest();
    if (!loaded) return;
    const inferred = resolveVideoFileSelection(loaded.files, {
      season: requestedEpisode?.season,
      episode: requestedEpisode?.episode,
    });
    const path = effectiveSelectedPath ?? inferred?.path ?? null;
    if (!path) {
      setExpanded(true);
      setMessage("Pick an episode, then copy its stream URL.");
      return;
    }
    try {
      await copyUrl(path);
    } catch {
      setProblem("generic");
      setMessage("Could not copy the stream URL.");
    }
  }, [copyUrl, loadManifest, effectiveSelectedPath, requestedEpisode]);

  const toggleExpanded = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    void loadManifest();
  }, [expanded, loadManifest]);

  const loadUpNext = useCallback(
    async (signal?: AbortSignal) => {
      if (!activeInfoHash || !activeTitle.trim()) return null;
      setUpNextLoading(true);
      try {
        const res = await fetch("/api/prewarm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "next",
            infoHash: activeInfoHash,
            title: selectedFile?.path ?? activeTitle,
            season: currentSeason,
            episode: currentEpisode,
            watchListItemId: activeWatchListItemId ?? null,
          }),
          signal,
        });
        const data = await readJson<UpNextResponse>(res);
        if (!res.ok || signal?.aborted) return null;
        const next = data?.next ?? null;
        setUpNext(next);
        return next;
      } catch {
        if (!signal?.aborted) setUpNext(null);
        return null;
      } finally {
        if (!signal?.aborted) setUpNextLoading(false);
      }
    },
    [
      activeInfoHash,
      activeTitle,
      selectedFile,
      currentSeason,
      currentEpisode,
      activeWatchListItemId,
    ],
  );

  useEffect(() => {
    if (!playableSrc || !effectiveSelectedPath) return;
    const controller = new AbortController();
    void loadUpNext(controller.signal);
    return () => controller.abort();
  }, [playableSrc, effectiveSelectedPath, loadUpNext]);

  const playUpNext = useCallback(
    (next: UpNextEpisodeCard | null = upNext) => {
      if (!next?.infoHash) return;
      setTransitioningTitle(next.title);
      setEnded(false);
      setAutoAdvanceCancelled(false);
      setAdvanceCountdown(AUTO_ADVANCE_SECONDS);
      setTarget({
        infoHash: next.infoHash,
        title: next.title,
        season: next.season,
        episode: next.episode,
        watchListItemId: activeWatchListItemId,
        posterUrl: activePosterUrl,
        resumeSec: 0,
      });
    },
    [upNext, currentSeason, currentEpisode, activeWatchListItemId, activePosterUrl],
  );

  const fetchUpNext = useCallback(async () => {
    if (!upNext || upNext.infoHash) return;
    setUpNextLoading(true);
    try {
      await fetch("/api/prewarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "trigger",
          next: {
            title: upNext.title,
            season: upNext.season,
            episode: upNext.episode,
            source: "playing-episode",
          },
          protectHashes: [activeInfoHash],
        }),
      }).catch(() => null);
      await loadUpNext();
    } finally {
      setUpNextLoading(false);
    }
  }, [upNext, activeInfoHash, loadUpNext]);

  const candidateRequestBody = useCallback(
    (chosenInfoHash?: string) => ({
      title: activeTitle,
      mediaType: currentMediaType,
      season: currentSeason,
      episode: currentEpisode,
      currentInfoHash: activeInfoHash,
      ...(chosenInfoHash ? { chosenInfoHash } : {}),
    }),
    [activeTitle, currentMediaType, currentSeason, currentEpisode, activeInfoHash],
  );

  const loadQualityCandidates = useCallback(async () => {
    setQualityLoading(true);
    setQualityError(null);
    try {
      const res = await fetch("/api/playback/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(candidateRequestBody()),
      });
      const data = await readJson<CandidatesResponse>(res);
      if (!res.ok) {
        setQualityError("Could not load other releases.");
        return;
      }
      setQualityCandidates(Array.isArray(data?.candidates) ? data.candidates : []);
    } catch {
      setQualityError("Could not load other releases.");
    } finally {
      setQualityLoading(false);
    }
  }, [candidateRequestBody]);

  const chooseQualityCandidate = useCallback(
    async (candidate: PlaybackCandidate) => {
      if (candidate.isCurrent || candidate.infoHash.toLowerCase() === activeInfoHash.toLowerCase()) {
        setQualityMenuOpen(false);
        return;
      }
      setSwitchingInfoHash(candidate.infoHash);
      setQualityError(null);
      try {
        const res = await fetch("/api/playback/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(candidateRequestBody(candidate.infoHash)),
        });
        const data = await readJson<SwitchResponse>(res);
        if (!res.ok || !data?.ok) {
          const reason = data && "reason" in data ? data.reason : null;
          setQualityError(
            reason === "not-a-candidate"
              ? "That release is no longer available for this title."
              : "That release could not be started. Current playback is unchanged.",
          );
          return;
        }
        const resumeAt =
          typeof data.positionSec === "number" && Number.isFinite(data.positionSec)
            ? data.positionSec
            : currentSourceTimeRef.current;
        setQualityMenuOpen(false);
        setTarget({
          infoHash: data.infoHash,
          title: activeTitle,
          season: currentSeason,
          episode: currentEpisode,
          posterUrl: activePosterUrl,
          watchListItemId: activeWatchListItemId,
          resumeSec: resumeAt,
        });
      } catch {
        setQualityError("That release could not be started. Current playback is unchanged.");
      } finally {
        setSwitchingInfoHash(null);
      }
    },
    [
      activeInfoHash,
      activeTitle,
      currentSeason,
      currentEpisode,
      activePosterUrl,
      activeWatchListItemId,
      candidateRequestBody,
    ],
  );

  useEffect(() => {
    if (!qualityMenuOpen || qualityCandidates.length > 0 || qualityLoading) return;
    void loadQualityCandidates();
  }, [qualityMenuOpen, qualityCandidates.length, qualityLoading, loadQualityCandidates]);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    setEnded(true);
    setAutoAdvanceCancelled(false);
    setAdvanceCountdown(AUTO_ADVANCE_SECONDS);
    postProgress({ force: true });
    void loadUpNext();
  }, [postProgress, loadUpNext]);

  useEffect(() => {
    if (!ended || !canAutoAdvanceToUpNext(upNext, autoAdvanceCancelled)) return;
    if (advanceCountdown <= 0) {
      playUpNext(upNext);
      return;
    }
    const timer = window.setTimeout(() => {
      setAdvanceCountdown((n) => Math.max(0, n - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [ended, autoAdvanceCancelled, upNext, advanceCountdown, playUpNext]);

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
  // deliberately keys on the effective selected path only, so a seek (which bumps
  // `planNonce`) does not clobber the offset it just requested.
  //
  // A resume position is applied here, exactly once, to the first file opened:
  // it is the offset the *plan* should start at, and consuming it any later
  // would mean planning at 0 and then seeking — an ffmpeg session spawned at
  // the wrong offset and immediately thrown away. Picking a different file
  // afterwards starts that file at 0, because a position stored for one episode
  // is not a position in another.
  useEffect(() => {
    if (!effectiveSelectedPath) return;
    if (!resumeConsumedRef.current && resumeTargetSec > 0) {
      resumeConsumedRef.current = true;
      pendingSeekRef.current = resumeTargetSec;
      return;
    }
    resumeConsumedRef.current = true;
    pendingSeekRef.current = 0;
  }, [effectiveSelectedPath, resumeTargetSec]);

  // Main playback effect: when a file is selected, negotiate the playback plan.
  // Also re-runs on `planNonce` — bumped when the viewer seeks past what the
  // current ffmpeg session has produced, or picks a different audio track.
  useEffect(() => {
    if (!expanded || !effectiveSelectedPath) return;
    const controller = new AbortController();
    const filePath = effectiveSelectedPath;
    const startSec = pendingSeekRef.current;
    const requestedAudio = audioStreamIndex;

    void (async () => {
      // Reset state
      setPlayableSrc(null);
      setPlaybackMode("direct");
      setWaiting(false);
      setActiveVideoAdvancing(false);
      setCheckingStream(true);
      setProblem(null);
      setMessage(null);
      setPreparingLabel(null);
      setSeeking(false);
      lastActiveMediaTimeRef.current = null;
      clearMotionLease();
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
            infoHash: activeInfoHash,
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
          await tryDirectStream(activeInfoHash, filePath, controller.signal);
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
        if (/whole-file.*failed after/i.test(planData.strategyReason ?? "")) {
          setProblem("generic");
          setMessage(
            `Optimized local playback failed: ${planData.strategyReason}. Playing through the fallback stream instead.`,
          );
        }

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
              ? streamPath(activeInfoHash, filePath)
              : planData.playUrl;
          setPlaybackMode("direct");
          setTimelineOffset(0);
          pendingNativeSeekRef.current = startSec > 0 ? startSec : 0;
          if (startSec > 0) setCurrentSourceTime(startSec);
          setPlayableSrc(nativeUrl);
          setTransitioningTitle(null);
        } else {
          // HLS — a genuinely incomplete file, or one that needs ffmpeg.
          setTimelineOffset(planData.startSec);
          pendingNativeSeekRef.current = 0;
          setPlaybackMode("hls");
          setPreparingLabel(rungLabel(planData.plan.rung));
          setPlayableSrc(planData.playUrl);
          setTransitioningTitle(null);
        }
      } catch {
        if (!controller.signal.aborted) {
          // Network error — fall back to direct stream check
          await tryDirectStream(activeInfoHash, filePath, controller.signal).catch(() => {
            setProblem("generic");
            setMessage("Could not check the stream.");
          });
        }
      } finally {
        // Only the plan that actually settled may clear the in-flight flag. A
        // plan aborted because a newer seek superseded it must leave the flag
        // set so the replacement plan stays owned and its target is not lost.
        if (!controller.signal.aborted) {
          setCheckingStream(false);
          seekInFlightRef.current = false;
          seekPlanTargetRef.current = null;
        }
      }
    })();

    return () => controller.abort();
  }, [expanded, activeInfoHash, effectiveSelectedPath, planNonce, audioStreamIndex, tryDirectStream, clearMotionLease]);

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
  const [resetForPath, setResetForPath] = useState(effectiveSelectedPath);
  if (effectiveSelectedPath !== resetForPath) {
    setResetForPath(effectiveSelectedPath);
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
    if (!expanded || !effectiveSelectedPath || !planResolved) return;
    const controller = new AbortController();
    const filePath = effectiveSelectedPath;
    void (async () => {
      try {
        const res = await fetch(subtitleListUrl(activeInfoHash, filePath), {
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
        // Otherwise apply the server-chosen default: an English subtitle when
        // the selected audio is not English. This is the fix for an English
        // viewer landing on foreign audio with subtitles silently Off.
        const serverDefault =
          !preselect && data.defaultTrackId
            ? tracks.find((t) => t.id === data.defaultTrackId && t.src)
            : undefined;
        const chosen = preselect ?? serverDefault;
        if (chosen) {
          setSubtitleTrackId(chosen.id);
          setSubtitleStatus(chosen.needsExtraction ? "extracting" : "loading");
        } else if (data.subtitleDefault?.noEnglishAvailable) {
          // Foreign audio and no English subtitle exists: say so out loud rather
          // than sit on a silent "Off".
          setSubtitleNote("No English subtitles available for this release.");
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
  }, [expanded, activeInfoHash, effectiveSelectedPath, defaultSidecarPath, planResolved]);

  /**
   * Restart the HLS session at `sourceSec`.
   *
   * ffmpeg only ever produced segments from `timelineOffset` onwards, so a seek
   * outside that window cannot be served by the current playlist — the segment
   * route would 404. Re-planning respawns ffmpeg with `-ss` at the new offset.
   */
  const seekToSource = useCallback((sourceSec: number) => {
    const target = Math.max(0, sourceSec);
    const decision = nextSeekRestartAction(
      {
        inFlight: seekInFlightRef.current,
        inFlightTargetSec: seekPlanTargetRef.current,
        requestedTargetSec: target,
      },
      SEEK_TOLERANCE_SECONDS,
    );
    // Only a repeat of the target already being planned is dropped; a new target
    // aborts the stale plan (via the effect's AbortController) and restarts, so
    // the viewer's latest press always wins instead of being silently swallowed.
    if (decision === "ignore") return;
    seekInFlightRef.current = true;
    seekPlanTargetRef.current = target;
    pendingSeekRef.current = target;
    setPlanNonce((n) => n + 1);
  }, []);

  const issueRequestedSeek = useCallback(
    (target: number) => {
      clearSeekRetry();
      const previous = requestedSeekRef.current;
      const sameTarget = previous && Math.abs(previous.targetSec - target) <= SEEK_TOLERANCE_SECONDS;
      const attempts = sameTarget ? previous.attempts + 1 : 1;
      requestedSeekRef.current = { targetSec: target, attempts, attemptedAt: Date.now() };
      setSeeking(true);
      const video = videoRef.current;
      if (playbackMode !== "hls") {
        if (video) video.currentTime = target;
        return;
      }
      // HLS. A target inside the produced window is a plain `currentTime` write —
      // but only when the element is present and no session restart is already
      // in flight. If the element is mid-teardown (null) or a restart is running,
      // fall through to `seekToSource` so this press coalesces into the (re)plan
      // and the newest target wins instead of being dropped.
      if (video && !seekInFlightRef.current) {
        const produced = Number.isFinite(video.duration) ? video.duration : 0;
        const relative = target - timelineOffset;
        if (relative >= 0 && relative <= produced) {
          video.currentTime = relative;
          return;
        }
      }
      seekToSource(target);
    },
    [clearSeekRetry, playbackMode, seekToSource, timelineOffset],
  );

  const reconcileRequestedSeek = useCallback(
    (actualSourceTime: number) => {
      const requested = requestedSeekRef.current;
      if (!requested) return;
      const action = nextSeekIntentAction(
        {
          targetSec: requested.targetSec,
          actualSec: actualSourceTime,
          attempts: requested.attempts,
          elapsedMs: Date.now() - requested.attemptedAt,
        },
        SEEK_TOLERANCE_SECONDS,
        SEEK_RETRY_DELAY_MS,
        SEEK_MAX_ATTEMPTS,
      );
      if (action === "settled") {
        requestedSeekRef.current = null;
        clearSeekRetry();
        setMessage((current) => current === "Fetching that position — retrying as pieces arrive." ? null : current);
        setSeeking(false);
        return;
      }
      if (action === "failed") {
        requestedSeekRef.current = null;
        clearSeekRetry();
        setMessage("That position is still arriving. The engine is fetching it; try again in a moment.");
        setSeeking(false);
        return;
      }
      if (action === "retry" && !seekRetryTimerRef.current) {
        setMessage("Fetching that position — retrying as pieces arrive.");
        seekRetryTimerRef.current = setTimeout(() => {
          seekRetryTimerRef.current = null;
          const latest = requestedSeekRef.current;
          if (latest) issueRequestedSeek(latest.targetSec);
        }, SEEK_RETRY_DELAY_MS);
      }
    },
    [clearSeekRetry, issueRequestedSeek],
  );

  const controlsPinned =
    !isPlaying ||
    viewerWaiting ||
    seeking ||
    Boolean(preparingLabel) ||
    subtitleMenuOpen ||
    audioMenuOpen ||
    volumeMenuOpen ||
    qualityMenuOpen;

  const showTheatreControls = useCallback(() => {
    setTheatreControlsVisible(true);
    if (controlsIdleRef.current) clearTimeout(controlsIdleRef.current);
    if (controlsPinned) return;
    controlsIdleRef.current = setTimeout(() => setTheatreControlsVisible(false), 3000);
  }, [controlsPinned]);

  useEffect(() => {
    if (controlsPinned) {
      setTheatreControlsVisible(true);
      if (controlsIdleRef.current) clearTimeout(controlsIdleRef.current);
      return;
    }
    showTheatreControls();
    return () => {
      if (controlsIdleRef.current) clearTimeout(controlsIdleRef.current);
    };
  }, [controlsPinned, showTheatreControls]);

  useEffect(() => {
    const syncFullscreen = () => {
      const surface = fullscreenSurfaceRef.current;
      setFullscreenActive(Boolean(surface && document.fullscreenElement === surface));
    };
    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const triggerPlayPulse = useCallback((kind: "play" | "pause") => {
    setPlayPulse(kind);
    if (playPulseRef.current) clearTimeout(playPulseRef.current);
    playPulseRef.current = setTimeout(() => setPlayPulse(null), 520);
  }, []);

  const cancelAutoAdvance = useCallback(() => {
    if (ended) setAutoAdvanceCancelled(true);
  }, [ended]);

  /** Play/pause the underlying element. State is synced from the media events,
   *  never assumed here, so an autoplay block or a stall can't desync the icon. */
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    cancelAutoAdvance();
    if (video.paused) {
      void video.play().catch(() => {
        /* autoplay refusal keeps the paused icon, which is the truth */
      });
      triggerPlayPulse("play");
    } else {
      video.pause();
      triggerPlayPulse("pause");
    }
  }, [cancelAutoAdvance, triggerPlayPulse]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    cancelAutoAdvance();
    video.muted = !video.muted;
    setMuted(video.muted);
  }, [cancelAutoAdvance]);

  const changeVolume = useCallback((value: number) => {
    cancelAutoAdvance();
    const next = Math.max(0, Math.min(1, value));
    const video = videoRef.current;
    if (video) {
      video.volume = next;
      video.muted = next === 0;
    }
    setVolume(next);
    setMuted(next === 0);
  }, [cancelAutoAdvance]);

  const changePlaybackRate = useCallback((value: number) => {
    cancelAutoAdvance();
    const next = PLAYBACK_RATES.includes(value as (typeof PLAYBACK_RATES)[number]) ? value : 1;
    const video = videoRef.current;
    if (video) video.playbackRate = next;
    setPlaybackRate(next);
  }, [cancelAutoAdvance]);

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
    if (!activeSubtitle || !effectiveSelectedPath) return null;
    const offset = playbackMode === "hls" ? timelineOffset : 0;
    return subtitleTrackSrc(activeInfoHash, effectiveSelectedPath, activeSubtitle.id, offset);
  }, [activeSubtitle, activeInfoHash, effectiveSelectedPath, playbackMode, timelineOffset]);

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
    const surface = fullscreenSurfaceRef.current;
    if (!surface) return;
    if (document.fullscreenElement === surface) {
      void document.exitFullscreen?.().catch(() => {
        /* the browser owns fullscreen denial */
      });
      return;
    }
    void surface.requestFullscreen?.().catch(() => {
      /* denied outside a user gesture or in an unsupported browser */
    });
  }, []);

  /** Attach HLS.js to the video element when in HLS mode. */
  const attachHls = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    hlsSeekAbortRef.current?.();
    hlsSeekAbortRef.current = null;
    if (!video || !playableSrc || playbackMode !== "hls") return;
    video.playbackRate = playbackRate;

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
  }, [playableSrc, playbackMode, playbackRate]);

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
      cancelAutoAdvance();
      const target = Math.max(0, sourceDuration ? Math.min(sourceSec, sourceDuration) : sourceSec);
      setCurrentSourceTime(target);
      currentSourceTimeRef.current = target;
      scheduleSeekProgress();
      issueRequestedSeek(target);
    },
    [cancelAutoAdvance, issueRequestedSeek, sourceDuration, scheduleSeekProgress],
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
      video.playbackRate = playbackRate;
    },
    [playbackRate],
  );

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate, playableSrc]);

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
      "This file's audio can't be decoded in a browser (usually Dolby AC-3/E-AC-3 or DTS). Another release will likely play with sound here.",
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

  const handleMediaElementError = useCallback(
    (event: ReactSyntheticEvent<HTMLVideoElement>) => {
      const video = event.currentTarget;
      if (video !== videoRef.current) return;
      if (playbackMode === "hls" && hlsRef.current) return;
      const verdict = interpretMediaElementError(video.error);
      if (verdict.recoverable) {
        const resumeAt =
          playbackMode === "hls"
            ? timelineOffset + video.currentTime
            : currentSourceTimeRef.current || video.currentTime;
        pendingSeekRef.current = Math.max(0, Number.isFinite(resumeAt) ? resumeAt : currentSourceTimeRef.current);
        setProblem(null);
        setMessage(verdict.detail);
        setPreparingLabel("Reconnecting to the stream…");
        setWaiting(false);
        setActiveVideoAdvancing(false);
        lastActiveMediaTimeRef.current = null;
        clearMotionLease();
        setPlanNonce((n) => n + 1);
        return;
      }
      setProblem(verdict.problem);
      setMessage(verdict.detail);
      setPlayableSrc(null);
    },
    [clearMotionLease, playbackMode, timelineOffset],
  );

  const handleMediaTimeUpdate = useCallback(
    (video: HTMLVideoElement) => {
      if (playbackMode === "direct") checkDecodedAudio(video);
      const position = playbackMode === "hls" ? timelineOffset + video.currentTime : video.currentTime;
      // While an HLS session restart is in flight the outgoing element still
      // reports the pre-seek position. Honouring it would snap the scrubber and
      // clock back to where the viewer just left — the visible "snap-back". Hold
      // the requested target until the new session reports its own position.
      if (!seekInFlightRef.current) {
        setCurrentSourceTime(position);
        currentSourceTimeRef.current = position;
        noteActiveMediaTime(video, position);
        reconcileRequestedSeek(position);
      }
      readBuffered(video);
      postProgress();
    },
    [checkDecodedAudio, noteActiveMediaTime, playbackMode, postProgress, readBuffered, reconcileRequestedSeek, timelineOffset],
  );

  const mediaElementHandlers = useMemo(
    () => ({
      onError: handleMediaElementError,
      onWaiting: (event: ReactSyntheticEvent<HTMLVideoElement>) => activeMediaEvent(event.currentTarget, "waiting"),
      onPlay: () => {
        setIsPlaying(true);
        setEnded(false);
      },
      onPause: () => {
        setIsPlaying(false);
        postProgress({ force: true });
      },
      onEnded: handleEnded,
      onSeeking: (event: ReactSyntheticEvent<HTMLVideoElement>) => {
        if (event.currentTarget === videoRef.current) setSeeking(true);
      },
      onPlaying: (event: ReactSyntheticEvent<HTMLVideoElement>) => {
        activeMediaEvent(event.currentTarget, "playing");
        setSeeking(false);
        setPreparingLabel(null);
      },
      onCanPlay: (event: ReactSyntheticEvent<HTMLVideoElement>) => {
        activeMediaEvent(event.currentTarget, "canplay");
        setPreparingLabel(null);
        readBuffered(event.currentTarget);
      },
      onProgress: (event: ReactSyntheticEvent<HTMLVideoElement>) => readBuffered(event.currentTarget),
      onSeeked: (event: ReactSyntheticEvent<HTMLVideoElement>) => {
        const video = event.currentTarget;
        if (video === videoRef.current) {
          const position = playbackMode === "hls" ? timelineOffset + video.currentTime : video.currentTime;
          reconcileRequestedSeek(position);
          if (!requestedSeekRef.current) setSeeking(false);
        }
        readBuffered(video);
        scheduleSeekProgress();
      },
      onTimeUpdate: (event: ReactSyntheticEvent<HTMLVideoElement>) => handleMediaTimeUpdate(event.currentTarget),
    }),
    [
      activeMediaEvent,
      handleEnded,
      handleMediaElementError,
      handleMediaTimeUpdate,
      playbackMode,
      postProgress,
      readBuffered,
      reconcileRequestedSeek,
      scheduleSeekProgress,
      timelineOffset,
    ],
  );

  const renderStreamVideo = useCallback(
    (options: { className: string; defaultSubtitleTrack?: boolean }) =>
      playbackMode === "hls" ? (
        <video
          data-stream-video
          key={playableSrc}
          ref={attachHls}
          preload="auto"
          className={options.className}
          aria-label={activeTitle}
          onClick={togglePlay}
          {...mediaElementHandlers}
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
          controls={false}
          preload="metadata"
          className={options.className}
          src={playableSrc ?? undefined}
          aria-label={activeTitle}
          {...mediaElementHandlers}
          onLoadedMetadata={(e) => {
            checkAudioTracks(e.currentTarget);
            applyPendingNativeSeek(e.currentTarget);
            if (!sourceDuration && Number.isFinite(e.currentTarget.duration)) {
              setSourceDuration(e.currentTarget.duration);
            }
          }}
          onLoadedData={(e) => checkAudioTracks(e.currentTarget)}
        >
          {activeSubtitle ? (
            <track
              key={activeSubtitleSrc ?? activeSubtitle.id}
              kind="subtitles"
              src={activeSubtitleSrc ?? undefined}
              srcLang={activeSubtitle.language ?? undefined}
              label={activeSubtitle.label}
              default={options.defaultSubtitleTrack}
              onLoad={() => setSubtitleStatus("ready")}
              onError={() => {
                setSubtitleStatus("error");
                setSubtitleNote("That subtitle track could not be loaded.");
              }}
            />
          ) : null}
        </video>
      ),
    [
      activeSubtitle,
      activeSubtitleSrc,
      activeTitle,
      applyPendingNativeSeek,
      attachHls,
      attachNativeVideo,
      checkAudioTracks,
      mediaElementHandlers,
      playableSrc,
      playbackMode,
      sourceDuration,
      togglePlay,
    ],
  );

  const compactSelectClass = cn(
    "h-8 min-w-0 appearance-none truncate py-1 pl-3 pr-8 text-[11px] outline-none transition focus-visible:ring-2",
    theatre
      ? "w-40 rounded-full border border-white/15 bg-white/10 text-white focus-visible:ring-white/25"
      : "input-field flex-1 px-1.5 focus-visible:ring-[var(--accent-dim)]",
  );
  const selectChevron = (
    <ChevronDown
      aria-hidden
      className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-current opacity-60"
    />
  );
  const audioControl =
    audioTracks.length > 1 ? (
      <label
        className={cn(
          "flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]",
          theatre && "text-white/70",
        )}
      >
        <span>Audio</span>
        <span className="relative min-w-0">
          <select
            className={compactSelectClass}
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
              <option
                key={track.streamIndex}
                value={track.streamIndex}
                className="bg-[var(--bg-elevated)]"
              >
                {audioTrackLabel(track, i)}
              </option>
            ))}
          </select>
          {selectChevron}
        </span>
      </label>
    ) : (
      <button
        type="button"
        disabled
        aria-label="Audio settings unavailable"
        className={cn(
          "grid shrink-0 cursor-not-allowed place-items-center rounded-full opacity-40",
          theatre ? "h-10 w-10 text-white/70" : "h-8 w-8 text-white/60",
        )}
      >
        <SlidersHorizontal className={theatre ? "h-5 w-5" : "h-4 w-4"} />
      </button>
    );
  const subtitleControl =
    subtitleTracks.length > 0 ? (
      <label
        className={cn(
          "flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]",
          theatre && "text-white/70",
        )}
      >
        <span>Subtitles</span>
        <span className="relative min-w-0">
          <select
            className={compactSelectClass}
            value={subtitleTrackId}
            data-stream-subtitle-select
            aria-label="Subtitles"
            onChange={(e) => selectSubtitleTrack(e.target.value)}
          >
            <option value="" className="bg-[var(--bg-elevated)]">Off</option>
            {subtitleTracks.map((track) => (
              // A track that cannot become WebVTT is shown, because hiding it
              // would make the release look like it has no subtitles at all.
              <option
                key={track.id}
                value={track.id}
                disabled={!track.src}
                className="bg-[var(--bg-elevated)]"
              >
                {track.label}
              </option>
            ))}
          </select>
          {selectChevron}
        </span>
      </label>
    ) : (
      <button
        type="button"
        disabled
        aria-label="Subtitles unavailable"
        className={cn(
          "grid shrink-0 cursor-not-allowed place-items-center rounded-full opacity-40",
          theatre ? "h-10 w-10 text-white/70" : "h-8 w-8 text-white/60",
        )}
      >
        <Captions className={theatre ? "h-5 w-5" : "h-4 w-4"} />
      </button>
    );

  const unifiedControlBar = (variant: "theatre" | "inline") => {
    const large = variant === "theatre";
    const buttonClass = cn(
      "grid shrink-0 place-items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2",
      large
        ? "h-10 w-10 text-white/80 hover:bg-white/12 hover:text-white focus-visible:outline-white"
        : "h-8 w-8 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline-[var(--accent)]",
    );
    const playButtonClass = cn(
      "grid shrink-0 place-items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2",
      large
        ? "h-10 w-10 bg-white text-black hover:scale-105 focus-visible:outline-white"
        : "h-8 w-8 bg-[var(--accent)] text-black hover:brightness-110 focus-visible:outline-[var(--accent)]",
    );
    const iconClass = large ? "h-5 w-5" : "h-4 w-4";
    return (
      <div
        data-stream-transport-row
        className={cn(
          "flex items-center gap-2",
          large
            ? "text-white"
            : "mx-auto w-full max-w-6xl flex-wrap rounded-xl border border-white/10 bg-black/70 px-3 py-2 text-white shadow-[var(--shadow-md)] backdrop-blur",
        )}
      >
        <button type="button" data-stream-transport onClick={togglePlay} disabled={!playableSrc} aria-label={isPlaying ? "Pause" : "Play"} className={playButtonClass}>
          {isPlaying ? <Pause className={cn(iconClass, "fill-current")} /> : <Play className={cn(iconClass, "translate-x-px fill-current")} />}
        </button>
        <button type="button" onClick={() => seekRelative(-10)} disabled={!playableSrc} aria-label="Back 10 seconds" className={buttonClass}>
          <RotateCcw className={iconClass} />
        </button>
        <button type="button" onClick={() => seekRelative(10)} disabled={!playableSrc} aria-label="Forward 10 seconds" className={buttonClass}>
          <RotateCw className={iconClass} />
        </button>
        <span className={cn("tabular-nums", large ? "min-w-[84px] text-[12px] text-white/80" : "text-[11px] text-white/70")}>
          {formatClock(currentSourceTime)} / {sourceDuration && sourceDuration > 0 ? formatClock(sourceDuration) : "0:00"}
        </span>
        {sourceDuration && sourceDuration > 0 ? (
          <span className={cn("relative flex flex-1 items-center", large ? "min-w-[200px]" : "min-w-[180px]")}>
            <span aria-hidden="true" className={cn("pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full", large ? "bg-white/18" : "bg-[var(--border)]")} />
            <TimelineBands sourceDuration={sourceDuration} bufferedRanges={bufferedRanges} downloadedRanges={downloadedRanges} currentSourceTime={currentSourceTime} />
            <span aria-hidden="true" className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(0, Math.min(100, (currentSourceTime / sourceDuration) * 100))}%` }} />
            <input
              type="range"
              aria-label="Seek"
              data-stream-seek
              data-current-held={currentTimeHeld ?? "unknown"}
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
        ) : (
          <span className={cn("flex-1", large ? "text-[12px] text-white/60" : "text-[11px] text-white/60")}>Resolving timeline…</span>
        )}
        <button type="button" onClick={toggleMute} disabled={!playableSrc} aria-label={muted ? "Unmute" : "Mute"} className={buttonClass}>
          {muted ? <VolumeX className={iconClass} /> : <Volume2 className={iconClass} />}
        </button>
        <input data-stream-volume type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume" className={cn("w-20", !large && "hidden sm:block")} onChange={(e) => changeVolume(Number(e.target.value))} />
        <label className={cn("flex shrink-0 items-center gap-1.5 text-[11px]", large ? "text-white/70" : "text-white/65")}>
          <span>Speed</span>
          <select
            data-stream-speed-select
            aria-label="Playback speed"
            value={playbackRate}
            onChange={(e) => changePlaybackRate(Number(e.target.value))}
            className={cn(
              "h-8 appearance-none rounded-full border px-2 text-[11px] outline-none focus-visible:ring-2",
              large
                ? "border-white/15 bg-white/10 text-white focus-visible:ring-white/25"
                : "border-white/10 bg-black/40 text-white focus-visible:ring-[var(--accent-dim)]",
            )}
          >
            {PLAYBACK_RATES.map((rate) => (
              <option key={rate} value={rate} className="bg-[var(--bg-elevated)]">
                {rate === 1 ? "1×" : `${rate}×`}
              </option>
            ))}
          </select>
        </label>
        {subtitleControl}
        {audioControl}
        <div className="relative">
          <button type="button" onClick={() => setQualityMenuOpen((open) => !open)} aria-label="Quality" aria-expanded={qualityMenuOpen} className={buttonClass}>
            <Gauge className={iconClass} />
          </button>
          {qualityMenuOpen ? (
            <div data-quality-selector className="absolute bottom-full right-0 mb-2 max-h-[60vh] w-[28rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-white/10 bg-black/90 p-2 text-sm text-white shadow-2xl backdrop-blur">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">Quality</p>
                <button type="button" onClick={() => void loadQualityCandidates()} disabled={qualityLoading} className="text-[11px] font-medium text-white/55 hover:text-white disabled:cursor-wait disabled:opacity-50">
                  Refresh
                </button>
              </div>
              {qualityError ? <p className="mx-2 mb-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-100">{qualityError}</p> : null}
              {qualityLoading && qualityCandidates.length === 0 ? (
                <PageSkeletonFrame
                  aria-label={qualitySelectorEmptyCopy(true, qualityCandidates.length) ?? "Loading releases"}
                >
                  <QualityCandidateSkeletonRow />
                  <QualityCandidateSkeletonRow />
                  <QualityCandidateSkeletonRow />
                </PageSkeletonFrame>
              ) : null}
              {qualityCandidates.map((candidate) => {
                const switching = switchingInfoHash === candidate.infoHash;
                return (
                  <button
                    key={candidate.infoHash}
                    type="button"
                    data-quality-candidate
                    disabled={Boolean(switchingInfoHash)}
                    onClick={() => void chooseQualityCandidate(candidate)}
                    className={cn(QUALITY_ROW_BASE, "transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-60", candidate.isCurrent && "bg-white/10")}
                  >
                    <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", candidate.verdict === "good" && "bg-emerald-400", candidate.verdict === "weak" && "bg-amber-300", candidate.verdict === "dead" && "bg-red-400", candidate.verdict === "unknown" && "bg-sky-300")} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-semibold text-white">{candidateQualityShape(candidate) || candidate.title}</span>
                        {candidate.isCurrent ? <span className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70">Current</span> : null}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[12px] text-white/58">
                        <span>{candidateVerdictLabel(candidate.verdict)}</span><span>·</span><span>{candidatePlayabilityLabel(candidate.playability)}</span><span>·</span><span>{candidate.seeders} seeders</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-white/35">{candidate.title}</span>
                    </span>
                    {switching ? <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-white/70" /> : candidate.isCurrent ? <Check className="mt-1 h-4 w-4 shrink-0 text-[var(--accent)]" /> : null}
                  </button>
                );
              })}
              {!qualityLoading && qualityCandidates.length === 0 ? (
                <p className="flex min-h-[5.5rem] items-center px-3 py-3 text-[13px] text-white/55">
                  {qualitySelectorEmptyCopy(false, qualityCandidates.length)}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <button type="button" onClick={goFullscreen} disabled={!playableSrc} aria-label={fullscreenActive ? "Exit full screen" : "Full screen"} className={buttonClass}>
          {fullscreenActive ? <Minimize className={iconClass} /> : <Maximize className={iconClass} />}
        </button>
      </div>
    );
  };

  if (theatre) {
    const hasVisibleVideo = Boolean(playableSrc && selectedFile);
    const showStageStatus = shouldShowFullscreenStatusOverlay({
      hasVisibleVideo,
      viewerWaiting,
      preparing: Boolean(preparingLabel),
      activeVideoAdvancing,
    });
    const showSeekSpinner = shouldShowSeekSpinner({ seeking, activeVideoAdvancing });
    const chromeVisible = theatreControlsVisible || controlsPinned;
    const controlsOpacity = chromeVisible ? "opacity-100" : "opacity-0";
    const pointerWhenHidden = chromeVisible ? "pointer-events-auto" : "pointer-events-none focus-within:opacity-100";
    const selectedAudioLabel =
      audioTracks.find((track) => track.streamIndex === audioStreamIndex)
        ? audioTrackLabel(
            audioTracks.find((track) => track.streamIndex === audioStreamIndex)!,
            audioTracks.findIndex((track) => track.streamIndex === audioStreamIndex),
          )
        : "Audio";
    const selectedSubtitleLabel =
      subtitleTracks.find((track) => track.id === subtitleTrackId)?.label ?? "Off";
    const closeMenus = () => {
      setSubtitleMenuOpen(false);
      setAudioMenuOpen(false);
      setVolumeMenuOpen(false);
      setQualityMenuOpen(false);
    };
    const peerCount = swarmSample?.peers ?? null;
    const rateBps = swarmSample?.downloadSpeedBps ?? null;
    const deliveryDetail =
      peerCount == null && rateBps == null
        ? "the swarm is not sending enough data"
        : `${peerCount === 1 ? "one peer" : `${peerCount ?? 0} peers`}, ${
            rateBps != null && rateBps >= 1024 ? `${formatBytes(rateBps)}/s` : "almost no data"
          }`;
    const { title: terminalTitle, detail: terminalDetail } = terminalPlaybackCopy({
      problem,
      message,
      deliveryDetail,
    });
    const statusTitle = terminalTitle
      ? terminalTitle
      : transitioningTitle && !playableSrc
        ? `Preparing ${transitioningTitle}`
      : manifestLoading
        ? "Resolving files…"
      : !playableSrc && selectedFile
        ? "Preparing playback — this usually takes under a minute once pieces arrive."
      : checkingStream || preparingLabel || !playableSrc
        ? stateSentence
        : null;

    return (
      <div
        className={cn(
          "flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden px-4 pb-4 pt-14 sm:px-6",
          !theatreControlsVisible && !controlsPinned && "cursor-none",
          className,
        )}
        data-inline-player
        data-player-chrome={chrome}
        data-infohash={activeInfoHash}
        data-playback-mode={playbackMode}
        data-playback-strategy={strategy ?? undefined}
        data-playback-rung={playbackRung ?? undefined}
        data-strategy-reason={strategyReason ?? undefined}
        data-resume-sec={resumeTargetSec > 0 ? resumeTargetSec : undefined}
        onKeyDown={handleKeyDown}
        onPointerMove={showTheatreControls}
        onFocusCapture={showTheatreControls}
      >
        <style>{`
          @keyframes inline-player-pulse {
            from { opacity: 0; transform: scale(.82); }
            25% { opacity: 1; }
            to { opacity: 0; transform: scale(1.08); }
          }
          [data-player-chrome="theatre"] [data-stream-seek],
          [data-inline-player] [data-stream-volume] {
            -webkit-appearance: none;
            appearance: none;
            background: transparent;
            height: 12px;
            cursor: pointer;
          }
          [data-player-chrome="theatre"] [data-stream-seek]::-webkit-slider-runnable-track,
          [data-inline-player] [data-stream-volume]::-webkit-slider-runnable-track {
            height: 3px;
            background: transparent;
            border-radius: 999px;
            transition: height 180ms ease;
          }
          [data-player-chrome="theatre"] [data-stream-seek]::-webkit-slider-thumb,
          [data-inline-player] [data-stream-volume]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            height: 13px;
            width: 13px;
            margin-top: -5px;
            border-radius: 999px;
            background: var(--accent);
            border: none;
            opacity: 0;
            transition: opacity 160ms ease, transform 160ms ease;
          }
          [data-player-chrome="theatre"] [data-stream-seek]:hover::-webkit-slider-runnable-track,
          [data-player-chrome="theatre"] [data-stream-seek]:focus-visible::-webkit-slider-runnable-track {
            height: 6px;
          }
          [data-player-chrome="theatre"] [data-stream-seek]:hover::-webkit-slider-thumb,
          [data-player-chrome="theatre"] [data-stream-seek]:focus-visible::-webkit-slider-thumb,
          [data-inline-player] [data-stream-volume]:hover::-webkit-slider-thumb,
          [data-inline-player] [data-stream-volume]:focus-visible::-webkit-slider-thumb {
            opacity: 1;
          }
          [data-player-chrome="theatre"] [data-stream-seek]::-moz-range-track,
          [data-inline-player] [data-stream-volume]::-moz-range-track {
            height: 3px;
            background: transparent;
            border-radius: 999px;
          }
          [data-player-chrome="theatre"] [data-stream-seek]::-moz-range-thumb,
          [data-inline-player] [data-stream-volume]::-moz-range-thumb {
            height: 13px;
            width: 13px;
            border: none;
            border-radius: 999px;
            background: var(--accent);
            opacity: 0;
          }
          [data-player-chrome="theatre"] [data-stream-seek]:hover::-moz-range-thumb,
          [data-player-chrome="theatre"] [data-stream-seek]:focus-visible::-moz-range-thumb,
          [data-inline-player] [data-stream-volume]:hover::-moz-range-thumb,
          [data-inline-player] [data-stream-volume]:focus-visible::-moz-range-thumb {
            opacity: 1;
          }
          [data-player-chrome="theatre"] [data-stream-seek]:focus-visible,
          [data-inline-player] [data-stream-volume]:focus-visible {
            outline: 2px solid var(--accent);
            outline-offset: 2px;
            border-radius: 999px;
          }
          [data-player-fullscreen-surface]:fullscreen {
            width: 100vw;
            height: 100vh;
            max-width: none;
            max-height: none;
            border: 0;
            border-radius: 0;
            background: #000;
            display: flex;
            flex-direction: column;
          }
          [data-player-fullscreen-surface]:fullscreen[data-stream-stage],
          [data-player-fullscreen-surface]:fullscreen [data-stream-stage] {
            flex: 1 1 auto;
            min-height: 0;
            width: 100%;
            max-width: none;
            max-height: none;
            border: 0;
            border-radius: 0;
          }
        `}</style>

        <div className="mx-auto flex h-full min-h-0 w-full max-w-[calc((100dvh-5rem)*16/9)] flex-col gap-3">
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div
              ref={fullscreenSurfaceRef}
              data-stream-stage
              data-player-fullscreen-surface
              className="relative flex aspect-video w-full max-h-full items-center justify-center overflow-hidden rounded-2xl border border-white/12 bg-black bg-cover bg-center shadow-[0_24px_90px_rgba(0,0,0,0.68)] ring-1 ring-black/50"
              style={
                activePosterUrl
                  ? { backgroundImage: `linear-gradient(rgba(0,0,0,.66), rgba(0,0,0,.72)), url(${activePosterUrl})` }
                  : undefined
              }
            >
              {playableSrc && selectedFile ? (
                renderStreamVideo({
                  className: "absolute inset-0 h-full w-full bg-black object-contain",
                  defaultSubtitleTrack: true,
                })
              ) : null}

              {!playableSrc ? (
                <div
                  data-stream-preparing
                  key={`preparing-${activeInfoHash}`}
                  aria-hidden="true"
                  className="absolute inset-0 bg-transparent"
                />
              ) : null}

              {showStageStatus ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08),rgba(0,0,0,0.55)_62%)] px-6 text-center">
                  <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-white/10 bg-black/45 px-6 py-5 text-white/75 shadow-2xl backdrop-blur-md">
                    {terminalTitle ? (
                      <X className="h-7 w-7 text-white/70" />
                    ) : (
                      <span className="grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-white/8">
                        <Loader2 className="h-6 w-6 animate-spin text-white/85" />
                      </span>
                    )}
                    <p className="text-sm font-medium text-white">{statusTitle}</p>
                    {terminalDetail ? <p className="text-[12px] text-white/60">{terminalDetail}</p> : null}
                    {terminalTitle ? (
                      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setQualityMenuOpen(true);
                            showTheatreControls();
                          }}
                          className="inline-flex h-9 items-center rounded-full bg-white px-4 text-[12px] font-semibold text-black transition hover:bg-white/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                        >
                          Try another release
                        </button>
                        <button
                          type="button"
                          onClick={() => void copySelected()}
                          className="inline-flex h-9 items-center rounded-full border border-white/15 px-4 text-[12px] font-medium text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                        >
                          Open in your player
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div
                className={cn(
                  "pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/80 via-black/30 to-transparent p-5 transition-opacity duration-200",
                  controlsOpacity,
                )}
              >
                <div className="pointer-events-auto flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-white drop-shadow">{activeTitle}</p>
                    <p className="mt-0.5 truncate text-[12px] text-white/65">
                      {[currentSeason != null && currentEpisode != null ? `S${String(currentSeason).padStart(2, "0")}E${String(currentEpisode).padStart(2, "0")}` : null, releaseChips[0]]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {videoFiles.length > 1 ? (
                    <label className="pointer-events-auto flex max-w-[min(26rem,45vw)] shrink-0 items-center gap-2 rounded-full border border-white/12 bg-black/45 px-3 py-2 text-[11px] text-white/70 shadow-2xl backdrop-blur-md">
                      <span className="shrink-0 font-medium uppercase tracking-[0.14em] text-white/45">
                        Episode
                      </span>
                      <select
                        value={effectiveSelectedPath ?? ""}
                        onChange={(e) => setSelectedPath(e.target.value || null)}
                        data-stream-file-select
                        aria-label="Video file"
                        className="min-w-0 flex-1 appearance-none truncate bg-transparent text-[12px] font-medium text-white outline-none"
                      >
                        <option value="" className="bg-[var(--bg-elevated)]">Pick a video file…</option>
                        {videoFiles.map((file) => (
                          <option key={file.index} value={file.path} className="bg-[var(--bg-elevated)]">
                            {file.path} · {formatBytes(file.length)}
                          </option>
                        ))}
                      </select>
                      <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-white/50" />
                    </label>
                  ) : null}
                </div>
              </div>

              <div
                className={cn(
                  "absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-5 pb-4 pt-24 transition-opacity duration-200",
                  controlsOpacity,
                  pointerWhenHidden,
                )}
              >
                {ended && upNext ? (
                  <div
                    data-up-next-card
                    className="absolute bottom-28 right-5 w-80 overflow-hidden rounded-2xl border border-white/15 bg-black/80 p-3 text-white shadow-[0_18px_60px_rgba(0,0,0,.55)] backdrop-blur"
                  >
                    <div className="flex gap-3">
                      <div
                        className="h-16 w-24 shrink-0 rounded-lg bg-white/10 bg-cover bg-center"
                        style={activePosterUrl ? { backgroundImage: `url(${activePosterUrl})` } : undefined}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
                          Up next
                        </p>
                        <p className="mt-1 truncate text-sm font-semibold">{upNext.title}</p>
                        <p className="text-[12px] text-white/65">{upNext.label}</p>
                        <p className="mt-1 text-[12px] text-white/65">
                          {canAutoAdvanceToUpNext(upNext, autoAdvanceCancelled)
                            ? `Playing in ${advanceCountdown}…`
                            : upNextStatusSentence(upNext.availability)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      {upNext.infoHash ? (
                        <button
                          type="button"
                          onClick={() => playUpNext(upNext)}
                          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-3 text-[12px] font-semibold text-black"
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                          Play now
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void fetchUpNext()}
                          disabled={upNextLoading}
                          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-white/15 px-3 text-[12px] font-semibold text-white/80 disabled:cursor-wait disabled:opacity-60"
                        >
                          {upNextLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                          Fetch next
                        </button>
                      )}
                      {canAutoAdvanceToUpNext(upNext, autoAdvanceCancelled) ? (
                        <button
                          type="button"
                          onClick={() => setAutoAdvanceCancelled(true)}
                          className="h-9 rounded-full border border-white/15 px-3 text-[12px] text-white/75 hover:bg-white/10"
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {unifiedControlBar("theatre")}

                <div className="mt-3 flex min-h-6 items-center justify-between gap-3 text-[11px] text-white/55">
                  <div className="flex min-w-0 items-center gap-2">
                    {selectedFile ? (
                      <SwarmChip
                        infoHash={activeInfoHash}
                        active={Boolean(playableSrc)}
                        minimumStreamBps={minimumStreamBps}
                        onSample={setSwarmSample}
                        fetchSample={fetchPlayerSample}
                      />
                    ) : null}
                    <span className="truncate">
                      {[selectedAudioLabel !== "Audio" ? selectedAudioLabel : null, selectedSubtitleLabel !== "Off" ? selectedSubtitleLabel : "Subtitles off"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  <span className="hidden min-w-0 truncate text-right md:block">
                    {releaseChips.length > 0 ? releaseChips.join(" · ") : selectedFile ? formatBytes(selectedFile.length) : ""}
                  </span>
                </div>
              </div>

              {playPulse ? (
                <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center">
                  <span className="grid h-24 w-24 animate-[inline-player-pulse_520ms_ease-out] place-items-center rounded-full bg-black/45 text-white shadow-2xl backdrop-blur">
                    {playPulse === "play" ? (
                      <Play className="h-10 w-10 translate-x-0.5 fill-current" />
                    ) : (
                      <Pause className="h-10 w-10 fill-current" />
                    )}
                  </span>
                </div>
              ) : null}

              {showSeekSpinner ? (
                <span
                  data-stream-seeking
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-md bg-black/25"
                >
                  <Loader2 className="h-6 w-6 animate-spin text-white/90" />
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "w-full space-y-2",
        theatre && "flex h-full min-h-0 items-stretch px-4 py-14 sm:px-6",
        className,
      )}
      data-inline-player
      data-player-chrome={chrome}
      data-infohash={activeInfoHash}
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
              ? "mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col justify-center gap-3 bg-transparent"
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
            [data-player-fullscreen-surface]:fullscreen {
              width: 100vw;
              height: 100vh;
              max-width: none;
              max-height: none;
              border: 0;
              border-radius: 0;
              background: #000;
              padding: 0.75rem;
              display: flex;
              flex-direction: column;
              gap: 0.5rem;
            }
            [data-player-fullscreen-surface]:fullscreen [data-stream-stage] {
              flex: 1 1 auto;
              min-height: 0;
              width: 100%;
              max-width: none;
              max-height: none;
              border: 0;
              border-radius: 0;
            }
          `}</style>

          {!theatre && manifestLoading ? (
            <p className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
              <span className="h-2 w-2 rounded-full bg-[var(--accent)]" aria-hidden="true" />
              Resolving files…
            </p>
          ) : null}

          {videoFiles.length > 1 ? (
            <label className="block space-y-1 text-[11px] text-[var(--text-tertiary)]">
              File
              <select
                value={effectiveSelectedPath ?? ""}
                onChange={(e) => setSelectedPath(e.target.value || null)}
                data-stream-file-select
                className="input-field h-8 w-full px-2 text-[12px]"
              >
                <option value="" className="bg-[var(--bg-elevated)]">Pick a video file…</option>
                {videoFiles.map((file) => (
                  <option key={file.index} value={file.path} className="bg-[var(--bg-elevated)]">
                    {file.path} · {formatBytes(file.length)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {!theatre && message ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              {problem === "browser-error" || problem === "no-audio" ? (
                <X className="h-3.5 w-3.5 text-[var(--danger)]" />
              ) : null}
              <span>{message}</span>
              {effectiveSelectedPath && problem !== "preparing" ? (
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

          {!theatre && checkingStream ? (
            <p className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
              <span className="h-2 w-2 rounded-full bg-[var(--accent)]" aria-hidden="true" />
              {stateSentence}
            </p>
          ) : null}

          {!theatre && preparingLabel && !checkingStream ? (
            <p className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
              <span className="h-2 w-2 rounded-full bg-[var(--accent)]" aria-hidden="true" />
              {stateSentence}
            </p>
          ) : null}

          {theatre && !playableSrc ? (
            <div
              data-stream-stage
              className="relative mx-auto flex aspect-video w-full max-h-[calc(100dvh-13rem)] min-h-[240px] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
            >
              <div className="flex flex-col items-center gap-3 px-6 text-center text-white/75">
                {message ? (
                  <X className="h-7 w-7 text-white/70" />
                ) : (
                  <Loader2 className="h-7 w-7 animate-spin text-white/80" />
                )}
                <p className="text-sm font-medium text-white">
                  {message
                    ? "Playback cannot start yet."
                    : manifestLoading
                    ? "Resolving files…"
                    : checkingStream || preparingLabel
                      ? stateSentence
                      : "Pick a video file to start playback."}
                </p>
                {message ? <p className="max-w-md text-[12px] text-white/55">{message}</p> : null}
                {message ? (
                  problem === "missing" ? (
                    <a
                      href={searchHref}
                      className="inline-flex h-8 items-center rounded-full bg-white px-3 text-[12px] font-semibold text-black transition hover:bg-white/90"
                    >
                      Find a release
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setMessage(null);
                        setProblem(null);
                        void loadManifest();
                      }}
                      className="inline-flex h-8 items-center rounded-full bg-white px-3 text-[12px] font-semibold text-black transition hover:bg-white/90"
                    >
                      Try again
                    </button>
                  )
                ) : null}
              </div>
            </div>
          ) : null}

          {playableSrc && selectedFile ? (
            <div
              ref={fullscreenSurfaceRef}
              data-player-fullscreen-surface
              className={cn("space-y-1.5", theatre && "flex h-full min-h-0 flex-col gap-2")}
            >
              <div
                data-stream-stage
                className={cn(
                  "relative",
                  theatre &&
                    "mx-auto flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black shadow-[0_24px_80px_rgba(0,0,0,0.55)]",
                )}
              >
              {renderStreamVideo({
                className: "w-full rounded-md bg-black",
              })}
              {shouldShowSeekSpinner({ seeking, activeVideoAdvancing }) ? (
                <span
                  data-stream-seeking
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 grid place-items-center rounded-md bg-black/25"
                >
                  <Loader2 className="h-6 w-6 animate-spin text-white/90" />
                </span>
              ) : null}
              {ended && upNext ? (
                <div
                  data-up-next-card
                  className="absolute inset-x-3 bottom-3 z-10 rounded-xl border border-white/15 bg-black/80 p-3 text-white shadow-[var(--shadow-md)] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-80"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/60">
                    Up next
                  </p>
                  <p className="mt-1 truncate text-sm font-semibold">{upNext.title}</p>
                  <p className="text-[12px] text-white/70">{upNext.label}</p>
                  <p className="mt-1 text-[12px] text-white/70">
                    {upNextStatusSentence(upNext.availability)}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    {upNext.infoHash ? (
                      <button
                        type="button"
                        onClick={() => playUpNext(upNext)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-[12px] font-semibold text-black"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                        Play now
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled
                        className="inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-full bg-white/20 px-3 text-[12px] font-semibold text-white/60"
                      >
                        {upNextUnavailableActionLabel()}
                      </button>
                    )}
                    {canAutoAdvanceToUpNext(upNext, autoAdvanceCancelled) ? (
                      <button
                        type="button"
                        onClick={() => setAutoAdvanceCancelled(true)}
                        className="h-8 rounded-full border border-white/20 px-3 text-[12px] text-white/80"
                      >
                        Cancel autoplay ({advanceCountdown})
                      </button>
                    ) : upNext.infoHash && autoAdvanceCancelled ? (
                      <span className="text-[12px] text-white/60">Autoplay cancelled.</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {ended && upNextLoading ? (
                <div
                  data-up-next-loading
                  className="absolute inset-x-3 bottom-3 z-10 rounded-xl border border-white/15 bg-black/75 p-3 text-[12px] text-white/70 sm:inset-x-auto sm:right-4 sm:bottom-4"
                >
                  Checking for the next episode…
                </div>
              ) : null}
              </div>
              {playbackMode !== "hls" && sourceDuration && sourceDuration > 0 ? (
                <div
                  data-stream-availability
                  data-current-held={currentTimeHeld ?? "unknown"}
                  className="space-y-1"
                >
                  <div className="relative h-2 rounded-full bg-[var(--border)]">
                    <TimelineBands
                      sourceDuration={sourceDuration}
                      bufferedRanges={bufferedRanges}
                      downloadedRanges={downloadedRanges}
                      currentSourceTime={currentSourceTime}
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 h-2 w-0.5 -translate-y-1/2 rounded-full bg-[var(--text-primary)]"
                      style={{
                        left: `${Math.max(0, Math.min(100, (currentSourceTime / sourceDuration) * 100))}%`,
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-[var(--text-tertiary)]">
                    <span className="text-[var(--accent-text)]">Downloaded</span> pieces are
                    held by the torrent; <span className="text-[var(--text-secondary)]">bright</span>{" "}
                    spans are buffered in the browser.
                    {currentTimeHeld === false ? " This position is not downloaded yet." : ""}
                  </p>
                </div>
              ) : null}
              {unifiedControlBar("inline")}
              {subtitleStatus === "extracting" || subtitleStatus === "loading" ? (
                <p
                  data-stream-subtitle-status={subtitleStatus}
                  className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]"
                >
                  <span className="h-2 w-2 rounded-full bg-current opacity-70" aria-hidden="true" />
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
              <div
                className={cn(
                  "flex flex-wrap items-center gap-2",
                  theatre &&
                    "mx-auto w-full max-w-6xl justify-between rounded-xl border border-white/10 bg-black/45 px-3 py-2 text-white/70",
                )}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <SwarmChip
                    infoHash={activeInfoHash}
                    active={Boolean(playableSrc)}
                    minimumStreamBps={minimumStreamBps}
                    onSample={setSwarmSample}
                    fetchSample={fetchPlayerSample}
                  />
                  <p className={cn("min-w-0 flex-1 truncate text-[11px] text-[var(--text-tertiary)]", theatre && "text-white/60")}>
                    {releaseChips.length > 0
                      ? releaseChips.join(" · ")
                      : formatBytes(selectedFile.length)}
                  </p>
                </div>
                {upNext ? (
                  <div
                    data-up-next-status
                    className={cn(
                      "flex min-w-0 items-center gap-2 text-[11px] text-[var(--text-tertiary)]",
                      theatre && "text-white/70",
                    )}
                  >
                    <span className="min-w-0 truncate">
                      Next: {upNext.title} {upNext.label} — {upNextStatusSentence(upNext.availability)}
                    </span>
                    {upNext.infoHash ? (
                      <button
                        type="button"
                        onClick={() => playUpNext(upNext)}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-white px-2.5 text-[11px] font-semibold text-black"
                      >
                        <Play className="h-3 w-3 fill-current" />
                        Play
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void fetchUpNext()}
                        disabled={upNextLoading}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-white/15 px-2.5 text-[11px] font-medium text-white/80 disabled:cursor-wait disabled:opacity-60"
                      >
                        {upNextLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        Fetch next
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
              {viewerWaiting ? (
                <p className="text-[12px] text-[var(--text-tertiary)] tabular-nums">
                  {stateSentence}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
