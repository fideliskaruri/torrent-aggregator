import { useFeatures } from "@/lib/features";
import {
  Component,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
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
  SkipForward,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { infoHashFromMagnet } from "@/lib/torrents/infohash";
import { deadEvidenceFromSamples, type SwarmSample } from "@/components/watch/swarm-chip";
import {
  subtitleListUrl,
  subtitleTrackSrc,
  subtitleWindowStart,
  languageLabel,
  SUBTITLE_WINDOW_STRIDE_SECONDS,
  type SubtitleTrack,
} from "@/lib/media/subtitles";
import type { ProgressUpdateBody } from "@/lib/browse/types";
import { parseEpisode } from "@/lib/torrents/episodes";
import type { PlaybackFailureKind, PlaybackFailureClass } from "@/lib/clients/errors";
import Hls from "hls.js";

// Re-export so existing consumers (tests, other components) keep working.
export { infoHashFromMagnet };

type StreamFile = {
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
  /**
   * The engine's authoritative main-feature pick (index into the full file list),
   * from the stream index route's `selectMainFeatureFile`. `null` when there is
   * no single dominant feature. Preferred over the player's local heuristic so a
   * movie auto-selects the same file the engine would, with no drift.
   */
  primaryVideoIndex?: number | null;
  targetVideoIndex?: number | null;
};

type StreamProgress = {
  totalBytes?: number | null;
  downloadedBytes?: number | null;
  progress?: number | null;
  peers?: number | null;
};

type InlinePlayerProps = {
  /**
   * `null` means "opening": the player mounts the instant Play is pressed, shows
   * its one loader, and waits for the grab to resolve the real hash — so a
   * SINGLE loader owns the whole journey with no button→player spinner handoff.
   * A non-null hash streams immediately (existing-local play, watchlist).
   */
  infoHash: string | null;
  title: string;
  /** Provider episode title, never a release or file name. */
  episodeTitle?: string | null;
  /** Provider episode names keyed by canonical SxxExx codes for transitions. */
  episodeTitles?: Readonly<Record<string, string>>;
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
  /**
   * The work's release year, when the opener knows it.
   *
   * A film's year is part of its identity, so this is what keeps the quality
   * selector from offering a 1997 print (or an audiobook) for a 2026 film.
   * Optional: callers that do not know it are unchanged.
   */
  year?: number | null;
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

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

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

function nextAutomaticCandidate(
  candidates: readonly PlaybackCandidate[],
  activeInfoHash: string,
  triedHashes: Set<string>,
): PlaybackCandidate | null {
  const active = activeInfoHash.trim().toLowerCase();
  if (active) triedHashes.add(active);

  const ordered = [
    ...candidates.filter((candidate) => candidate.verdict !== "dead"),
    ...candidates.filter((candidate) => candidate.verdict === "dead"),
  ];
  for (const candidate of ordered) {
    const hash = candidate.infoHash.trim().toLowerCase();
    if (!hash || candidate.isCurrent || hash === active || triedHashes.has(hash)) continue;
    triedHashes.add(hash);
    return candidate;
  }
  return null;
}

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
  /**
   * Where the bytes ffmpeg reads actually come from, independent of
   * `strategy`. A `session` strategy is NOT proof of a swarm read: the server
   * can hand an already-complete local file to a session for remuxing. Only
   * this field (or an `absolutePath`) settles locality, so peer-flavoured
   * copy and swarm polling can be suppressed for disk-backed plans.
   *
   * Optional: older servers omit it and we fall back to strategy/absolutePath.
   */
  source?: string;
  /** Alias some server versions use for the same answer. */
  locality?: string;
  /** Present when the plan reads a complete file straight off disk. */
  absolutePath?: string | null;
  probe: {
    container: string;
    duration: number | null;
    videoCodec: string | null;
    videoProfile: string | null;
    audioCodec: string | null;
    audioChannels: number | null;
    width: number | null;
    height: number | null;
    /** Optional; older servers do not report it, so buffer sizing falls back to pixels. */
    bitrate?: number | null;
  };
};

type PlanAudioTrack = PlaybackPlanResponse["plan"]["audio"][number];

/**
 * Identity of the plan whose own answer is being mirrored back into state.
 *
 * The player used to remember only the audio index the plan chose, which made
 * the suppression a bare "skip the next run that happens to carry this index".
 * A bare index cannot tell "the echo of the plan I just received" apart from
 * "the viewer picked that track again after closing and reopening the player",
 * so an armed-but-unconsumed value could survive a close/reopen or a file
 * switch and swallow a plan the player genuinely needed.
 */
type PlanAudioEcho = {
  infoHash: string;
  filePath: string;
  /** Plan generation the echo belongs to. A seek/retry bumps it, invalidating the echo. */
  planNonce: number;
  audioStreamIndex: number | null;
};

/**
 * Should this plan-effect run be skipped as the echo of the plan that produced it?
 *
 * Only an exact match on every field of the plan identity suppresses. Anything
 * else (different release, different file, newer plan generation, different
 * audio index, nothing armed) must plan — suppression is never the default.
 */
function shouldSuppressPlanEcho(
  armed: PlanAudioEcho | null | undefined,
  current: PlanAudioEcho,
): boolean {
  if (!armed) return false;
  return (
    armed.infoHash === current.infoHash &&
    armed.filePath === current.filePath &&
    armed.planNonce === current.planNonce &&
    armed.audioStreamIndex === current.audioStreamIndex
  );
}

/**
 * Bitrate reported by the plan, in bits per second, or null.
 *
 * Never fabricated: a missing, non-numeric, non-finite or non-positive value is
 * `null`, and buffer sizing falls back to the resolution tiers.
 */
function normalizeProbeBitrate(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function isUpNextPlayableEnoughToAdvance(
  availability: UpNextAvailability | null | undefined,
): boolean {
  return availability === "ready" || availability === "downloading";
}

function nextViewerWaitingState(
  current: boolean,
  event: "waiting" | "playing" | "canplay" | "advancing",
  active: boolean,
): boolean {
  if (!active) return current;
  return event === "waiting";
}

function shouldShowViewerBuffering(args: {
  waiting: boolean;
  activeVideoAdvancing: boolean;
}): boolean {
  return args.waiting && !args.activeVideoAdvancing;
}

/**
 * THE one loader. There is a single spinner for the union of every "still
 * getting there" moment — {seeking ∪ buffering ∪ preparing ∪ checking ∪ no
 * source yet} — and it is rendered exactly once over the *active* surface.
 *
 * Three rules make it a single source of truth — one loader at any instant AND
 * one loader across the whole load:
 *  - A terminal error owns the surface instead (its own panel, no spinner), so
 *    a loader and an error never stack.
 *  - A picture that is *advancing* is, by definition, not loading — the motion
 *    lease keeps `activeVideoAdvancing` true through slow-but-moving playback —
 *    so a loader never sits over a frame whose `currentTime` is climbing.
 *  - `playbackStarted` gives temporal continuity: from Play-press until the
 *    active source paints its first frame it is false, and the loader is held
 *    ON *continuously* the whole time. It does not blink off in the gap between
 *    the preparing phase, the instant the <video> element mounts, and the first
 *    buffer — every internal phase change is the SAME loader node, so the viewer
 *    never sees loader → gone → a second loader → gone → a third before it plays.
 *    It flips false exactly once, when real playback starts.
 *
 * The previous player rendered a status overlay (with its own spinner) *and* a
 * separate seek spinner, which is why a seek-while-preparing showed two; and it
 * derived the loader from transient booleans that each fell to false between
 * phases, which is why a cold start flickered several loaders in succession.
 * This collapses both: callers render one node gated on this one boolean.
 */
function shouldShowUnifiedLoader(args: {
  hasVisibleVideo: boolean;
  activeVideoAdvancing: boolean;
  seeking: boolean;
  waiting: boolean;
  preparing: boolean;
  checking: boolean;
  switching: boolean;
  terminal: boolean;
  playbackStarted: boolean;
}): boolean {
  if (args.terminal) return false;
  // An explicit switch / next / open owns the one loader even while the OUTGOING
  // picture is still advancing: the viewer asked for a different source, so the
  // wait is real regardless of the frame being replaced. Without this, a quality
  // switch would flash the outgoing video's motion-lease "no loader" for a beat
  // before the central loader appeared — two visible states for one wait.
  if (args.switching) return true;
  if (args.hasVisibleVideo && args.activeVideoAdvancing) return false;
  // Before the first frame is painted the loader is continuous — this single
  // branch spans {no source ∪ resolving ∪ opening ∪ <video> mounted-not-yet-
  // painted ∪ first buffer}, so none of those transitions can unmount it.
  if (!args.playbackStarted) return true;
  // After the first frame, the loader is only the transient seek/buffer/prepare
  // indicator (a mid-play stall, a reconnect, a scrub).
  return args.preparing || args.checking || args.seeking || args.waiting;
}

type VideoPlaybackQualitySnapshot = {
  droppedVideoFrames: number;
  totalVideoFrames: number;
  corruptedVideoFrames: number;
};

const EMPTY_PLAYBACK_QUALITY: VideoPlaybackQualitySnapshot = {
  droppedVideoFrames: 0,
  totalVideoFrames: 0,
  corruptedVideoFrames: 0,
};

/**
 * Reads the browser's own dropped/total video frame counters straight off the
 * `<video>` element (`HTMLVideoElement.getVideoPlaybackQuality()`).
 *
 * This exists to let a smoothness investigation (jitter/frame-drop reports
 * around the seek → strategy-switch path) diff two snapshots taken before and
 * after a seek and see the browser's own drop count, instead of eyeballing a
 * recording. It is intentionally pure and judgment-free: it does not decide
 * what counts as "jittery", does not feed back into strategy or playback
 * selection, and never throws — a browser without the API (or jsdom in
 * tests) yields an all-zero snapshot rather than breaking rendering.
 */
function videoPlaybackQualitySnapshot(
  video: Pick<HTMLVideoElement, "getVideoPlaybackQuality"> | null | undefined,
): VideoPlaybackQualitySnapshot {
  if (!video || typeof video.getVideoPlaybackQuality !== "function") return EMPTY_PLAYBACK_QUALITY;
  try {
    const quality = video.getVideoPlaybackQuality();
    if (!quality) return EMPTY_PLAYBACK_QUALITY;
    return {
      droppedVideoFrames: Number(quality.droppedVideoFrames) || 0,
      totalVideoFrames: Number(quality.totalVideoFrames) || 0,
      corruptedVideoFrames: Number((quality as { corruptedVideoFrames?: number }).corruptedVideoFrames) || 0,
    };
  } catch {
    // A hostile/unusual embedding could theoretically throw here; this is a
    // read-only diagnostic, so degrade to "no data" rather than disrupt playback.
    return EMPTY_PLAYBACK_QUALITY;
  }
}

type PlanSource = "disk" | "swarm";

/**
 * Decide whether the current plan reads from local disk or from the swarm.
 *
 * Priority: an explicit server answer wins; otherwise an `absolutePath` proves
 * disk; otherwise the strategy is used (`whole-file`/`vod-segments` only ever
 * come back for a fully-local file). `session` alone proves nothing — the
 * server remuxes complete local files through a session too — so it returns
 * null (unknown) rather than lying in either direction.
 */
function planSourceFromPlan(plan: {
  source?: string | null;
  locality?: string | null;
  absolutePath?: string | null;
  strategy?: string | null;
} | null | undefined): PlanSource | null {
  if (!plan) return null;
  const explicit = (plan.source ?? plan.locality ?? "").trim().toLowerCase();
  if (explicit === "disk" || explicit === "local" || explicit === "file") return "disk";
  if (explicit === "swarm" || explicit === "torrent" || explicit === "peers") return "swarm";
  if (typeof plan.absolutePath === "string" && plan.absolutePath.trim().length > 0) return "disk";
  if (plan.strategy === "whole-file" || plan.strategy === "vod-segments") return "disk";
  return null;
}

function loaderStatusFromSamples({
  preparingLabel,
  sample,
  elapsedSec,
  strategy,
  planSource,
  playbackEstablished,
}: {
  preparingLabel?: string | null;
  sample?: SwarmSample | null;
  elapsedSec?: number;
  /**
   * The server's own answer for the CURRENT plan (`session` | `whole-file` |
   * `vod-segments`), when known. `whole-file`/`vod-segments` only ever come
   * back once `resolveCompleteLocalFile` has proved the requested file is
   * fully on disk — a season pack sitting at 40% overall can still hand this
   * back for the one episode inside it that finished first. Swarm-derived
   * copy ("Finding peers…"/"Connecting…") would be a straight-up lie there:
   * the wait is ffmpeg/remux setup, not peer discovery.
   */
  strategy?: string | null;
  /**
   * True once the viewer already saw a frame of THIS playback before this
   * loader render — i.e. this is a re-plan the seek triggered, not the swarm
   * being reached for the first time. Used only while the new plan's own
   * `strategy` has not landed yet: the prior plan already proved the swarm
   * was not the bottleneck for an established session, so the same
   * assumption holds for the brief gap until the fresh strategy confirms or
   * corrects it.
   */
  playbackEstablished?: boolean;
  /**
   * Strict locality for the CURRENT plan. `"disk"` means ffmpeg is reading a
   * complete local file — no peer is on the critical path, so peer-flavoured
   * copy must never render, however stale engine samples happen to read. This
   * is evaluated before every sample-derived branch.
   */
  planSource?: PlanSource | null;
}): string {
  const label = preparingLabel?.trim();
  if (label && !/^(preparing|loading)$/i.test(label)) {
    return label.endsWith("…") || label.endsWith("...") ? label.replace(/\.\.\.$/, "…") : `${label}…`;
  }

  // Strict disk locality: decided BEFORE any sample-derived branch so no
  // peer/connecting/buffering-from-swarm copy can be reached for a local plan.
  // A `session` strategy over a local absolutePath lands here too, which is
  // exactly the case the strategy check below cannot see.
  if (planSource === "disk") {
    if ((elapsedSec ?? 0) >= LOADER_STILL_WORKING_AFTER_SECONDS) return "Still working…";
    return playbackEstablished ? "Seeking…" : "Preparing…";
  }

  const provenLocal = strategy === "whole-file" || strategy === "vod-segments";
  if (provenLocal || (strategy == null && playbackEstablished)) {
    if ((elapsedSec ?? 0) >= LOADER_STILL_WORKING_AFTER_SECONDS) return "Still working…";
    return playbackEstablished ? "Seeking…" : "Preparing…";
  }

  // Until the plan explicitly says `session`, a generic preparation phase is
  // not evidence that peers are involved. This is especially important for a
  // parked completed torrent: the plan is resolving/probing its disk file, and
  // stale engine samples must not turn that wait into a false swarm message.
  if (strategy == null && label) return "Preparing…";

  const hasProgress =
    (sample?.downloadSpeedBps ?? 0) > 0 || (sample?.progress ?? 0) > 0;
  if (!hasProgress && (elapsedSec ?? 0) >= LOADER_STILL_WORKING_AFTER_SECONDS) {
    return "Still working…";
  }
  if (hasProgress) return "Buffering…";
  if ((sample?.peers ?? 0) > 0) return "Connecting…";
  // Peer copy needs actual swarm evidence. With no plan, no label and no
  // sample we are still pre-plan: stay neutral instead of claiming a peer
  // search that may never happen (the plan can still come back disk-backed).
  if (sample) return "Finding peers…";
  return "Preparing…";
}

/**
 * THE one loader — one spinner plus one short, honest status line.
 *
 * Every "still getting there" moment in the player (no source yet, preparing,
 * checking, buffering, seeking, switching release) renders THIS and only this,
 * overlaid on the persistent stage. The short line below the spinner must stay
 * non-technical and evidence-based; it explains that work is still happening
 * without narrating internals.
 *
 * Probe-integrity note. A spinner audit counts three selectors —
 * `[data-stream-loading]`, `.animate-spin` and `[role="status"]` — as a union.
 * All three sit on the SAME single node (the icon), so `querySelectorAll` over
 * that union counts exactly one element. Splitting them across a wrapper and a
 * child would read as two spinners and is precisely the mismatch that produced
 * earlier false "there is only one loader" proofs.
 */
function StreamLoader({ className, status }: { className?: string; status?: string }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/25",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2
          data-stream-loading
          data-player-loader
          role="status"
          aria-label={status ? `Loading video. ${status}` : "Loading video"}
          className="h-8 w-8 animate-spin text-white/90"
        />
        {status ? (
          <p className="max-w-[12rem] text-[12px] font-medium text-white/80 drop-shadow">
            {status}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Whether a `timeupdate` may move the *displayed* playhead.
 *
 * The element reports positions that must not reach the scrubber:
 *  - during an HLS session restart the outgoing element still reads the stale
 *    pre-seek position, and
 *  - while a user seek is still reconciling, intermediate/old positions would
 *    bounce the playhead away from where the viewer just clicked.
 *
 * In both cases the requested target is already shown; hold it until the real
 * position lands. This is what kills the "one click, then it bounces back a few
 * times" scrub.
 */
function shouldAdoptTimeUpdate(args: {
  seekInFlight: boolean;
  hasPendingUserSeek: boolean;
  /**
   * The viewer is actively dragging the scrubber right now. Its `onChange` owns
   * the displayed playhead until they let go, so an element `timeupdate` landing
   * mid-drag must not write over the thumb the finger is holding — that fight is
   * exactly the "scrubbing feels jittery" report. Optional so existing callers
   * (and tests) keep their two-field shape and their behaviour.
   */
  isUserScrubbing?: boolean;
}): boolean {
  return !args.seekInFlight && !args.hasPendingUserSeek && !args.isUserScrubbing;
}

/**
 * Minimum forward `currentTime` growth that counts as the picture advancing.
 * Kept just above float noise and well under one frame (~0.033s) so that slow,
 * throttled-but-advancing playback keeps renewing the motion lease.
 */
const MEDIA_ADVANCE_EPSILON = 0.01;

type MediaErrorKind = "aborted" | "network" | "decode" | "unsupported" | "unknown";

function mediaErrorKindFromCode(code: number | null | undefined): MediaErrorKind {
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

function interpretMediaElementError(error: Pick<MediaError, "code" | "message"> | null | undefined): {
  kind: MediaErrorKind;
  recoverable: boolean;
  problem: StreamProblem | null;
  title: string;
  detail: string;
  diagnostic: string | null;
} {
  const kind = mediaErrorKindFromCode(error?.code);
  const browserMessage = error?.message?.trim();
  if (kind === "aborted") {
    return {
      kind: "aborted",
      recoverable: true,
      problem: null,
      title: "Playback was interrupted.",
      detail: "Reconnecting from your current position.",
      diagnostic: browserMessage || null,
    };
  }
  if (kind === "network") {
    return {
      kind: "network",
      recoverable: true,
      problem: null,
      title: "The connection dropped.",
      detail: "Reconnecting from your current position.",
      diagnostic: browserMessage || null,
    };
  }
  if (kind === "decode") {
    return {
      kind: "decode",
      recoverable: false,
      problem: "browser-error",
      title: "This version won’t play here.",
      detail: "Try another version, or open this one in an installed player.",
      diagnostic: browserMessage || null,
    };
  }
  if (kind === "unsupported") {
    return {
      kind: "unsupported",
      recoverable: false,
      problem: "browser-error",
      title: "This version won’t play here.",
      detail: "Try another version, or open this one in an installed player.",
      diagnostic: browserMessage || null,
    };
  }
  return {
    kind: "unknown",
    recoverable: false,
    problem: "browser-error",
    title: "This version won’t play here.",
    detail: "Try another version, or open this one in an installed player.",
    diagnostic: browserMessage || null,
  };
}

function terminalPlaybackCopy(args: {
  problem: StreamProblem | null;
  message: string | null;
  deliveryDetail: string;
}): { title: string | null; detail: string | null } {
  const { problem, message, deliveryDetail } = args;
  const title =
    problem === "stalled" || problem === "preparing"
      ? "This version isn’t available yet."
      : problem === "browser-error" || problem === "no-audio"
        ? "This version won’t play here."
        : message
          ? "Playback cannot start yet."
          : null;
  const fallback =
    problem === "stalled" || problem === "preparing"
      ? `Try again in a moment. ${deliveryDetail}.`
      : problem === "browser-error"
        ? "Try another version, or open this one in an installed player."
        : problem === "no-audio"
          ? "Choose another audio track or try another version."
          : message;
  const repeatsTitle = (value: string | null | undefined) =>
    Boolean(title && value && value.trim() === title.trim());
  const detail = message && !repeatsTitle(message) ? message : fallback && !repeatsTitle(fallback) ? fallback : null;
  return { title, detail };
}

/**
 * The player shows exactly ONE loader across the whole button→first-frame
 * journey (and across silent auto-failover / release switches). To keep that
 * single loader continuous, terminality must be EXPLICIT — never inferred from
 * a bare diagnostic `message`. A recovering `problem` ("stalled"/"preparing"/
 * "metadata") means silent auto-recovery is still working — a byte stall being
 * failed over, or a release whose metadata is still resolving being re-attempted
 * — so playback stays BUSY (loader up, no panel). Only a classified
 * `streamFailure` (silent recovery genuinely exhausted) or a hard "can't play
 * here" problem is terminal and may replace
 * the spinner with a panel.
 */
function isTerminalPlayback(args: { problem: StreamProblem | null; hasStreamFailure: boolean }): boolean {
  const recovering =
    args.problem === "stalled" || args.problem === "preparing" || args.problem === "metadata";
  return args.hasStreamFailure || (args.problem !== null && !recovering);
}

/**
 * What the on-demand grab endpoint tells the player.
 *
 * Only the fields the Next button acts on. `infoHash` is the whole point: it is
 * what turns "a grab happened somewhere" into "play this now".
 */
type OnDemandGrabResponse = {
  ok?: boolean;
  message?: string | null;
  infoHash?: string | null;
  /** Present only when a storage limit refused it. */
  storage?: unknown;
};

/**
 * Turn a failed next-episode grab into something worth reading.
 *
 * The rule: never invent a reason, and never fall silent. The server almost
 * always explains itself (no seeded release, storage refused, no client
 * configured) and that sentence is more useful than any wording here. The
 * fallback exists only for a response that arrived with nothing to say — and
 * even that names the actual outcome rather than "something went wrong".
 */
function upNextFailureMessage(body: OnDemandGrabResponse | null): string {
  const message = body?.message?.trim();
  if (message) return message;
  return "Could not find a playable release for the next episode.";
}

function upNextUnavailableActionLabel(): string {
  // A verb, because it is a button that does something. "Not fetched yet" was a
  // status pretending to be an action, which is part of why pressing it and
  // seeing nothing change read as broken.
  return "Fetch and play";
}

type SeekIntent = {
  targetSec: number;
  actualSec: number;
  attempts: number;
  elapsedMs: number;
};

function nextSeekIntentAction(
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
 * A structured playback failure the player can act on, mirroring the engine's
 * `{ code, failureClass, retryable }` (stream 503 body / classifier). Kept local
 * so the render layer never imports engine internals beyond the two string
 * unions it already shares.
 */
type StructuredPlaybackFailure = {
  code: PlaybackFailureKind;
  failureClass: PlaybackFailureClass;
  retryable: boolean;
  /**
   * When true, the auto-failover pool has been fully exhausted — every
   * available candidate was tried and none delivered. "Try again in a moment"
   * is false hope here; use honest terminal copy instead.
   */
  candidatesExhausted?: boolean;
};

/** What the recovery UI should offer for a given failure. */
type PlaybackFailureAffordance = "retry";

/**
 * Turn a structured failure into viewer words + the one right next action (I19).
 *
 * The whole reason the engine emits codes instead of prose is so this seam can
 * say the honest, mechanism-free sentence and offer the action that can actually
 * recover — never a peer count, byte rate, %, codec or container name:
 *   - a DELIVERY failure (no peers / blocked path / stall) is retryable on the
 *     SAME release once bytes flow again → offer "Retry".
 *   - a PLAYABILITY failure or a NOT_FOUND release is terminal only after the
 *     automatic pool is exhausted; Retry restarts that automatic process.
 * `ENGINE_ERROR` is not delivery, but a fresh attempt is the only move a viewer
 * has, so it also offers retry.
 */
function playbackFailureCopy(failure: StructuredPlaybackFailure): {
  headline: string;
  detail: string | null;
  affordance: PlaybackFailureAffordance;
} {
  switch (failure.code) {
    case "NO_PEERS":
      return {
        headline: "This isn’t available to play right now.",
        detail: "Try again in a moment.",
        affordance: "retry",
      };
    case "CONNECTION_BLOCKED":
      return {
        headline: "The connection was blocked.",
        detail: "Check your network, then try again.",
        affordance: "retry",
      };
    case "STALLED":
      if (failure.candidatesExhausted) {
        return {
          headline: "Playback couldn’t start.",
          detail: "Check your connection, then retry.",
          affordance: "retry",
        };
      }
      return {
        headline: "This stopped loading.",
        detail: "Try again in a moment.",
        affordance: "retry",
      };
    case "UNPLAYABLE":
      return {
        headline: "This version won’t play on your device.",
        detail: "Automatic recovery is exhausted. Retry to start selection again.",
        affordance: "retry",
      };
    case "NOT_FOUND":
      return {
        headline: "This version isn’t available.",
        detail: "Automatic recovery is exhausted. Retry to start selection again.",
        affordance: "retry",
      };
    case "ENGINE_ERROR":
    default:
      return {
        headline: "Something went wrong.",
        detail: "Try again.",
        affordance: "retry",
      };
  }
}

/** Read a structured failure off a fetch Response body, if it carries one. */
function structuredFailureFromBody(
  body: { code?: unknown; failureClass?: unknown; retryable?: unknown } | null | undefined,
): StructuredPlaybackFailure | null {
  const code = typeof body?.code === "string" ? body.code : null;
  const known: PlaybackFailureKind[] = [
    "NO_PEERS",
    "CONNECTION_BLOCKED",
    "STALLED",
    "NOT_FOUND",
    "UNPLAYABLE",
    "ENGINE_ERROR",
  ];
  if (!code || !known.includes(code as PlaybackFailureKind)) return null;
  const failureClass =
    typeof body?.failureClass === "string" ? (body.failureClass as PlaybackFailureClass) : "delivery";
  return {
    code: code as PlaybackFailureKind,
    failureClass,
    retryable: body?.retryable === true,
  };
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
function nextSeekRestartAction(
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

/** Exact element-time landing point after a plan rebases its media timeline. */
function seekPositionInPlannedTimeline(
  requestedSourceSec: number,
  plannedTimelineStartSec: number,
): number {
  if (!Number.isFinite(requestedSourceSec) || !Number.isFinite(plannedTimelineStartSec)) return 0;
  return Math.max(0, requestedSourceSec - plannedTimelineStartSec);
}

function canAutoAdvanceToUpNext(
  next: UpNextEpisodeCard | null,
  cancelled: boolean,
): boolean {
  return Boolean(!cancelled && next?.infoHash && isUpNextPlayableEnoughToAdvance(next.availability));
}

/** Label an audio track for the picker: "English · AC-3 5.1". */
function audioTrackLabel(track: PlanAudioTrack, index: number): string {
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

function isVideoFile(path: string) {
  return VIDEO_EXTENSIONS.has(extensionOf(path));
}

function selectVideoFiles(files: StreamFile[]) {
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

function resolveVideoFileSelection(
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

/**
 * How much bigger the main feature must be than the next-largest video before we
 * treat it as *the* movie rather than one item in a pack. A feature dwarfs its
 * samples/featurettes/extras (often 10×+); a genuine multi-film pack has
 * comparably-sized entries. 1.6× clears the "movie + a couple of extras" case
 * without swallowing a real double-feature.
 */
const FEATURE_DOMINANCE_RATIO = 1.6;

/**
 * The single feature file in a movie torrent, or null when there genuinely
 * isn't one to pick automatically.
 *
 * A film release is usually one big video plus junk (`sample.mkv`, a trailer, a
 * featurette). Treating that as a "season pack" and demanding the viewer pick a
 * file — the Star Wars regression — is wrong: pick the dominant feature. Only
 * when no file dominates (a true multi-film pack) do we return null and let the
 * picker stand.
 */
function selectMainFeatureFile(files: StreamFile[]): StreamFile | null {
  const videos = selectVideoFiles(files);
  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0];
  const sorted = [...videos].sort((a, b) => b.length - a.length);
  const [largest, second] = sorted;
  if (!second || largest.length >= second.length * FEATURE_DOMINANCE_RATIO) {
    return largest;
  }
  return null;
}

/**
 * The main feature to auto-play, preferring the engine's authoritative index.
 *
 * The stream index route already ran `selectMainFeatureFile` server-side and put
 * the winner's file index in `primaryVideoIndex` (I20 upgrade). Honouring it
 * keeps the player's "is this a movie" answer identical to the engine's — no
 * second, drifting heuristic. When the server didn't supply one (older build, or
 * a genuine multi-feature pack where it returned null), fall back to the local
 * dominance test so behaviour degrades to exactly what it was before.
 */
function mainFeatureFile(
  files: StreamFile[],
  primaryVideoIndex: number | null | undefined,
): StreamFile | null {
  if (typeof primaryVideoIndex === "number" && primaryVideoIndex >= 0) {
    const authoritative = selectVideoFiles(files).find((file) => file.index === primaryVideoIndex);
    if (authoritative) return authoritative;
  }
  return selectMainFeatureFile(files);
}

function PlayerIdentity({
  showTitle,
  episodeTitle,
  season,
  episode,
}: {
  showTitle: string;
  episodeTitle?: string | null;
  season?: number | null;
  episode?: number | null;
}) {
  const code =
    season != null && episode != null
      ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
      : null;
  return (
    <div data-player-identity className="min-w-0">
      <p className="truncate text-base font-semibold text-white drop-shadow">
        {showTitle}
      </p>
      {episodeTitle || code ? (
        <p className="mt-0.5 truncate text-[12px] text-white/65">
          {[episodeTitle, code].filter(Boolean).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

const PLAYER_RESOLUTIONS = [480, 720, 1080, 2160] as const;

function PlayerQualityChoices({
  disabled = false,
  onSelect,
}: {
  disabled?: boolean;
  onSelect: (resolution: number) => void;
}) {
  return (
    <div data-player-quality-choices className="grid grid-cols-2 gap-1 sm:block">
      {PLAYER_RESOLUTIONS.map((resolution) => (
        <button
          key={resolution}
          type="button"
          data-quality-resolution={resolution}
          disabled={disabled}
          onClick={() => onSelect(resolution)}
          className="flex min-h-10 w-full items-center rounded-xl px-3 text-[13px] font-semibold text-white transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
        >
          {resolution}p
        </button>
      ))}
    </div>
  );
}

function preferredResolutionRequestBody(input: {
  title: string;
  mediaType: string;
  season: number | null;
  episode: number | null;
  year?: number | null;
  preferredResolution: number;
}) {
  return {
    title: input.title,
    mediaType: input.mediaType,
    season: input.season,
    episode: input.episode,
    ...(typeof input.year === "number" ? { year: input.year } : {}),
    preferredResolution: input.preferredResolution,
  };
}

function videoFileForPath(files: StreamFile[], path: string | null): StreamFile | null {
  if (!path) return null;
  return selectVideoFiles(files).find((file) => file.path === path) ?? null;
}

function findSidecarSubtitle(files: StreamFile[], videoPath: string) {
  const videoBase = basenameWithoutExtension(videoPath);
  const videoDir = directoryOf(videoPath);
  return files.find(
    (file) =>
      directoryOf(file.path) === videoDir &&
      basenameWithoutExtension(file.path) === videoBase &&
      SUBTITLE_EXTENSIONS.has(extensionOf(file.path)),
  );
}

function encodeStreamFilePath(filePath: string) {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function streamPath(infoHash: string, filePath: string) {
  return `/api/stream/${encodeURIComponent(infoHash)}/${encodeStreamFilePath(filePath)}`;
}

function streamStatusMessage(status: number): {
  problem: StreamProblem;
  message: string;
} {
  if (status === 409) {
    return {
      problem: "wrong-client",
      message: "This only plays through the built-in engine.",
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
      message: "This part isn't coming through yet.",
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

type UpNextAvailability = "ready" | "downloading" | "not-fetched";

type UpNextEpisodeCard = {
  title: string;
  label: string;
  season: number;
  episode: number;
  availability: UpNextAvailability;
  infoHash: string | null;
  /**
   * The exact file to play inside `infoHash`, when the server could name it.
   *
   * Season packs are the common case for "next episode": the successor lives in
   * the torrent already on screen. Carrying its path means the transition can
   * select the new file directly instead of re-fetching a manifest it is
   * already holding.
   */
  filePath?: string | null;
  progress: number | null;
};

/**
 * Accept an up-next card from the server, or nothing.
 *
 * `filePath` is optional and additive: a server that does not send one yields a
 * card with `filePath: null`, and every existing behaviour is unchanged.
 */
function normalizeUpNextCard(raw: unknown): UpNextEpisodeCard | null {
  if (!raw || typeof raw !== "object") return null;
  const card = raw as Record<string, unknown>;
  if (
    typeof card.title !== "string" ||
    typeof card.label !== "string" ||
    typeof card.season !== "number" ||
    typeof card.episode !== "number"
  ) {
    return null;
  }
  const availability: UpNextAvailability =
    card.availability === "ready" || card.availability === "downloading"
      ? card.availability
      : "not-fetched";
  const filePath =
    typeof card.filePath === "string" && card.filePath.trim().length > 0
      ? card.filePath
      : null;
  return {
    title: card.title,
    label: card.label,
    season: card.season,
    episode: card.episode,
    availability,
    infoHash: typeof card.infoHash === "string" && card.infoHash ? card.infoHash : null,
    filePath,
    progress: typeof card.progress === "number" ? card.progress : null,
  };
}

type UpNextResponse = {
  ok?: boolean;
  next?: UpNextEpisodeCard | null;
};

type CurrentTarget = {
  /** `null` only during the opening handoff, before the grab resolves a hash. */
  infoHash: string | null;
  title: string;
  episodeTitle?: string | null;
  resumeSec?: number;
  season?: number | null;
  episode?: number | null;
  /**
   * The exact file inside `infoHash` this target means, when it is known. Part
   * of the target's identity: changing episode inside one season pack changes
   * nothing else, so without it the player cannot tell it has been asked for
   * different media at all.
   */
  filePath?: string | null;
  posterUrl?: string | null;
  watchListItemId?: string | null;
};

function episodeTitleForTarget(
  episodeTitles: Readonly<Record<string, string>> | undefined,
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (!episodeTitles || season == null || episode == null) return null;
  const key = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return episodeTitles[key] ?? null;
}

const AUTO_ADVANCE_SECONDS = 8;
/** How long background warming may wait for an idle moment before running. */
const WARM_IDLE_TIMEOUT_MS = 2000;

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Run `callback` when the browser is idle, or after a short timeout.
 *
 * `requestIdleCallback` is feature-detected rather than assumed: Safari only
 * shipped it recently, and background warming must degrade to a plain timer
 * there instead of throwing inside a playback effect.
 */
function requestIdle(callback: () => void): {
  handle: number | null;
  timer: number | null;
} {
  const view = window as IdleWindow;
  if (view && typeof view.requestIdleCallback === "function") {
    return {
      handle: view.requestIdleCallback(callback, { timeout: WARM_IDLE_TIMEOUT_MS }),
      timer: null,
    };
  }
  return {
    handle: null,
    timer: window.setTimeout(callback, WARM_IDLE_TIMEOUT_MS),
  };
}

/** Cancel a handle returned by {@link requestIdle}. */
function cancelIdle(handle: number): void {
  const view = window as IdleWindow;
  if (view && typeof view.cancelIdleCallback === "function") {
    view.cancelIdleCallback(handle);
  }
}
const SEEK_RETRY_DELAY_MS = 700;
const SEEK_TOLERANCE_SECONDS = 2;
const SEEK_MAX_ATTEMPTS = 3;
/**
 * A seek shorter than this settles before it is worth interrupting the frame
 * with a spinner, so the one loader waits this long before appearing for a
 * seek. Keeps the loader from strobing on quick scrubs while still covering a
 * genuinely slow one. Kept under the ~300ms feedback threshold so a real wait
 * is still acknowledged promptly.
 */
const SEEK_LOADER_GRACE_MS = 220;
/**
 * Torrent metadata resolving (stream 425) is the SAME release needing a moment,
 * not a bad one — so the recovery is a short silent re-attempt of this release,
 * never a failover to another candidate and never a question handed to the
 * viewer (COMPLAINT 3). The loader stays up across these attempts. Bounded so a
 * release whose metadata never resolves still surfaces one honest terminal state
 * instead of spinning forever.
 */
const METADATA_RETRY_DELAY_MS = 1200;
const MAX_METADATA_RETRIES = 8;
/**
 * The bare spinner (COMPLAINT 2 — no copy) is only honest if it cannot spin
 * forever. This is the backstop watchdog: if the first frame has not been
 * presented within this bound after a release opens — for ANY reason the more
 * specific recovery paths did not resolve (metadata never resolved, a cold probe
 * stalled with no failover candidate, an engine that never answers) — make one
 * final silent failover attempt and, if that is exhausted, surface one honest
 * terminal state. Deliberately generous: no legitimate open (including a cold
 * torrent that must buffer) takes this long, so it only fires on a genuine hang,
 * never on a slow-but-working start.
 */
const OPENING_WATCHDOG_MS = 30000;
const LOADER_STILL_WORKING_AFTER_SECONDS = 15;

function upNextStatusSentence(state: UpNextAvailability): string {
  if (state === "ready") return "Ready to play now.";
  if (state === "downloading") {
    return "Still downloading — you can start now, but it may pause to catch up.";
  }
  return "Not fetched yet.";
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

function detectCapabilities(): ClientCapabilities {
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

/** `h:mm:ss` / `m:ss` clock for the source-timeline seek bar. */
function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** A buffered span expressed in seconds on the *source* timeline. */
type SourceRange = { start: number; end: number };
type ByteRange = { start: number; end: number };

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

function byteRangesToSourceRanges(
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

function sourceTimeInRanges(ranges: SourceRange[], position: number): boolean {
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
function bufferedSourceRanges(
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
function bufferedAheadOf(ranges: SourceRange[], position: number): number {
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
function canPlayNatively(rung: string, playUrl: string): boolean {
  if (rung === "direct") return true;
  return !/\.m3u8(?:$|[?#])/i.test(playUrl);
}

/**
 * What hls.js should be told to hold in memory, for THIS source.
 *
 * The old constants were tuned against HEVC/AVC 1080p (~120 MB is a few
 * minutes there). The same 120 MB at 2160p is well under a minute, so a 4K
 * stream evicts what it just paid a slow swarm for and re-fetches it — felt as
 * a stutter on every small move. Sizing by pixels (or by measured bitrate when
 * the server reports one) keeps the cushion measured in *time*, not bytes.
 *
 * The back buffer moves the other way: at 4K, 90s behind the playhead is
 * hundreds of MB of decoded fragments pinned for a rewind that usually never
 * comes, so the tiers trade seconds of history for headroom ahead.
 */
type HlsBufferSettings = {
  maxBufferLength: number;
  maxMaxBufferLength: number;
  maxBufferSize: number;
  backBufferLength: number;
};

/** Pixel-height tiers. Width is consulted too: anamorphic 4K can report <1440 high. */
function hlsBufferSettingsForSource(input: {
  width?: number | null;
  height?: number | null;
  bitrateBps?: number | null;
}): HlsBufferSettings {
  const height = Number.isFinite(input.height) ? Number(input.height) : 0;
  const width = Number.isFinite(input.width) ? Number(input.width) : 0;
  const effectiveHeight = Math.max(height, width > 0 ? Math.round(width / (16 / 9)) : 0);

  let settings: HlsBufferSettings;
  if (effectiveHeight >= 2000) {
    settings = { maxBufferLength: 30, maxMaxBufferLength: 90, maxBufferSize: 600 * 1000 * 1000, backBufferLength: 30 };
  } else if (effectiveHeight >= 1400) {
    settings = { maxBufferLength: 30, maxMaxBufferLength: 90, maxBufferSize: 300 * 1000 * 1000, backBufferLength: 45 };
  } else {
    settings = { maxBufferLength: 30, maxMaxBufferLength: 90, maxBufferSize: 120 * 1000 * 1000, backBufferLength: 90 };
  }

  // A measured bitrate beats a guess from pixels: hold ~60s of real bytes,
  // clamped so a bad probe can neither starve the buffer nor pin memory.
  const bitrate = Number.isFinite(input.bitrateBps) ? Number(input.bitrateBps) : 0;
  if (bitrate > 0) {
    const bytesForSixtySeconds = (bitrate / 8) * 60;
    settings = {
      ...settings,
      maxBufferSize: Math.round(
        Math.min(800 * 1000 * 1000, Math.max(120 * 1000 * 1000, bytesForSixtySeconds)),
      ),
    };
  }
  return settings;
}

/**
 * Must the fragment loader be torn down and restarted for this seek target?
 *
 * `stopLoad`/`startLoad` exists to abandon an in-flight fragment for a position
 * the viewer has left. When the target is already sitting in the buffer there
 * is nothing to abandon and nothing to fetch: restarting there throws away the
 * append queue and re-requests fragments the browser already holds, which at 4K
 * is exactly the stutter this is supposed to prevent. Pure so the rule is
 * testable without a media element.
 */
function hlsSeekNeedsLoadRestart(args: {
  buffered: SourceRange[];
  targetSec: number;
  /** Seconds of continuous buffer ahead of the target that count as "already there". */
  minAheadSec?: number;
}): boolean {
  const minAhead = args.minAheadSec ?? 2;
  return bufferedAheadOf(args.buffered, args.targetSec) < minAhead;
}

function hlsSeekShouldRestartLoader(args: {
  hasUserSeekIntent: boolean;
  buffered: SourceRange[];
  targetSec: number;
}): boolean {
  return (
    args.hasUserSeekIntent &&
    hlsSeekNeedsLoadRestart({
      buffered: args.buffered,
      targetSec: args.targetSec,
    })
  );
}

/** Media-element `buffered` as plain ranges, for the pure seek rule above. */
function timeRangesToRanges(buffered: TimeRanges | null | undefined): SourceRange[] {
  const ranges: SourceRange[] = [];
  if (!buffered) return ranges;
  for (let i = 0; i < buffered.length; i += 1) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) ranges.push({ start, end });
  }
  return ranges;
}

/** Below this, a stored position is noise rather than a place to resume. */
const RESUME_MIN_SEC = 5;

/** Don't write a position that moved less than this since the last write. */
const PROGRESS_MIN_DELTA_SEC = 5;

/** Steady-state cadence for progress writes during playback. */
const PROGRESS_INTERVAL_MS = 10_000;

/**
 * Should a progress write actually go out?
 *
 * Pure so the throttle can be tested without a media element. `force` is the
 * pause/unload path: those are the writes that decide whether Continue Watching
 * is right, so they skip the cadence — but never the "did it actually move"
 * check, because re-posting an identical position is pure write amplification.
 */
function shouldPostProgress(args: {
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

/** A track as the subtitles endpoint returns it: `src` is null when unusable. */
type SubtitleTrackWithSrc = SubtitleTrack & { src: string | null };

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

function subtitleStatusCopy(
  status: SubtitleStatus,
  note: string | null,
): string | null {
  if (status === "extracting") return "Preparing subtitles…";
  if (status === "loading") return "Loading subtitles…";
  return note;
}

function unsupportedSubtitleNote(
  tracks: SubtitleTrackWithSrc[],
): string | null {
  if (tracks.length === 0 || tracks.some((track) => track.src)) return null;
  return "These subtitles use a format this player can’t display. Try another track or open the video in another player.";
}

function shouldPreserveOutgoingEpisode(args: {
  transitioning: boolean;
  hasPlayableSource: boolean;
  exactNextFileKnown: boolean;
}): boolean {
  return args.transitioning && args.hasPlayableSource && args.exactNextFileKnown;
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
        <p className="font-medium text-[var(--text-primary)]">The player is unavailable.</p>
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

/**
 * Boundary key used for the whole life of one opening player. See the comment
 * in {@link InlineStreamPlayer}: the key must NOT change when `infoHash`
 * resolves from null → hash, or the single continuous loader would remount.
 */
const OPENING_BOUNDARY_KEY = "__inline-player-opening__";

export function InlineStreamPlayer(props: InlinePlayerProps) {
  const { streaming } = useFeatures();
  return streaming ? <EnabledInlineStreamPlayer {...props} /> : null;
}

function EnabledInlineStreamPlayer(props: InlinePlayerProps) {
  // The error boundary is keyed so a genuinely different release mounted into a
  // persistent parent gets a clean slate. But the opening handoff — the player
  // opens the instant Play is pressed (infoHash null), then the grab resolves
  // the real hash and it flows in as a prop — must NOT remount, or the ONE
  // continuous loader would be torn down and the viewer would see it restart.
  // So the key is latched ONCE per mount and never changes; Inner adopts a
  // late/changed infoHash through an effect instead. A different open mounts a
  // fresh instance (fresh boundary) from the parent.
  const [boundaryKey] = useState(() => props.infoHash ?? OPENING_BOUNDARY_KEY);
  return (
    <InlinePlayerErrorBoundary key={boundaryKey} title={props.title}>
      <InlineStreamPlayerInner {...props} />
    </InlinePlayerErrorBoundary>
  );
}

function InlineStreamPlayerInner({
  infoHash,
  title,
  episodeTitle,
  episodeTitles,
  progress,
  resumeSec,
  season,
  episode,
  year,
  posterUrl,
  watchListItemId,
  className,
  chrome = "inline",
}: InlinePlayerProps) {
  const theatre = chrome === "theatre";
  const panelId = useId();
  const externalTarget: CurrentTarget = {
    infoHash,
    title,
    episodeTitle,
    resumeSec,
    season,
    episode,
    posterUrl,
    watchListItemId,
  };
  const [target, setTarget] = useState<CurrentTarget>(externalTarget);
  const [previousExternalTarget, setPreviousExternalTarget] =
    useState<CurrentTarget>(externalTarget);
  const externalTargetChanged =
    infoHash !== previousExternalTarget.infoHash ||
    title !== previousExternalTarget.title ||
    episodeTitle !== previousExternalTarget.episodeTitle ||
    resumeSec !== previousExternalTarget.resumeSec ||
    season !== previousExternalTarget.season ||
    episode !== previousExternalTarget.episode ||
    posterUrl !== previousExternalTarget.posterUrl ||
    watchListItemId !== previousExternalTarget.watchListItemId;
  if (externalTargetChanged) {
    setPreviousExternalTarget(externalTarget);
    if (infoHash) setTarget(externalTarget);
  }
  const activeInfoHash = target.infoHash;
  const activeTitle = target.title;
  const activeEpisodeTitle = target.episodeTitle;
  const activeSeason = target.season;
  const activeEpisode = target.episode;
  const activePosterUrl = target.posterUrl;
  const activeWatchListItemId = target.watchListItemId;
  const activeFilePath = target.filePath ?? null;
  /**
   * What the player has been asked to play, as one comparable value.
   *
   * The infoHash alone was never the whole answer: inside a season pack every
   * episode shares it, so advancing an episode changed nothing the player
   * looked at — the manifest was reused, the old file stayed selected, and the
   * viewer got the episode they had just finished. Season, episode and the
   * requested file are part of the identity for exactly that reason.
   */
  const targetIdentity = `${activeInfoHash ?? ""}|${activeSeason ?? ""}|${activeEpisode ?? ""}|${activeFilePath ?? ""}`;
  // Adopt an infoHash that arrives (or changes) via props AFTER mount. The
  // player opens in an "opening" state (props.infoHash null) the instant Play is
  // pressed, so ONE loader owns the whole journey; when the grab resolves the
  // real hash it flows in here and we start streaming beneath the already-shown
  // loader — no remount, no second spinner. Internal transitions (quality
  // switch / auto-failover / up-next) mutate `target` directly and never touch
  // props.infoHash, so this fires ONLY for a genuine parent-driven target change
  // and can't fight an in-flight internal switch.
  // Theatre is entered by an explicit "play this", so it starts open. The old
  // route into this state was an effect in the overlay that reached into the
  // player's DOM and clicked its toggle for it; a component that has to be
  // puppeteered through its own public surface is one that was missing a prop.
  const [expanded, setExpanded] = useState(theatre);
  const [manifest, setManifest] = useState<StreamManifest | null>(null);
  /**
   * The target identity the held manifest (and its file selection) was resolved
   * for. A manifest is only "current" for the identity that asked for it.
   */
  const [manifestKey, setManifestKey] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mediaErrorDiagnostic, setMediaErrorDiagnostic] = useState<string | null>(null);
  const [problem, setProblem] = useState<StreamProblem | null>(null);
  const [playableSrc, setPlayableSrc] = useState<string | null>(null);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("direct");
  const [checkingStream, setCheckingStream] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [activeVideoAdvancing, setActiveVideoAdvancing] = useState(false);
  // Latches true the moment the active source paints its first frame / begins
  // real playback, and resets on every source change. It is what makes the one
  // loader temporally continuous: false ⇒ the loader is held ON without a blink
  // through the whole prepare→first-frame sequence; true ⇒ the loader is only a
  // transient seek/buffer indicator thereafter.
  const [playbackStarted, setPlaybackStarted] = useState(false);
  const [copied, setCopied] = useState(false);
  // Presence flag first — a non-null value means "a preparation phase is in
  // flight". Generic values stay internal; any future human phrase is normalized
  // by loaderStatusFromSamples before it reaches the loader.
  const [preparingLabel, setPreparingLabel] = useState<string | null>(null);
  // I19: the engine's structured failure for the current attempt (from a stream
  // 503 body or a decode verdict). Drives friendly, mechanism-free terminal copy
  // and the one right affordance (retry the same release vs try another version).
  const [streamFailure, setStreamFailure] = useState<StructuredPlaybackFailure | null>(null);
  // Elapsed seconds in the current visible loader episode.
  const [verboseElapsedSec, setVerboseElapsedSec] = useState(0);
  // I19b: a "Retry this release" attempt is in flight (re-announcing the same
  // infoHash). Keeps the button from double-firing and shows the calm loader.
  const [retrying, setRetrying] = useState(false);
  const [swarmSample, setSwarmSample] = useState<SwarmSample | null>(null);
  const [upNext, setUpNext] = useState<UpNextEpisodeCard | null>(null);
  const [upNextLoading, setUpNextLoading] = useState(false);
  // Why a failure needs its own state: the Next button used to fire a request
  // and swallow the answer, so a refusal looked exactly like a no-op. The
  // viewer's report was simply "the next episode button doesn't work".
  const [upNextError, setUpNextError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [transitioningTitle, setTransitioningTitle] = useState<string | null>(null);
  /** Keep a same-pack outgoing frame alive while the exact next file is planned. */
  const [preserveOutgoingEpisode, setPreserveOutgoingEpisode] = useState(false);
  const [autoAdvanceCancelled, setAutoAdvanceCancelled] = useState(false);
  const [advanceCountdown, setAdvanceCountdown] = useState(AUTO_ADVANCE_SECONDS);
  const [audioTracks, setAudioTracks] = useState<PlanAudioTrack[]>([]);
  const [audioStreamIndex, setAudioStreamIndex] = useState<number | null>(null);
  // The plan chooses the initial/default track. Mirroring that answer into UI
  // state must not trigger a second identical plan that aborts the first media
  // load; only a viewer-initiated audio change should re-plan.
  //
  // Keyed to the *exact* plan identity (release + file + plan generation +
  // chosen index), not a bare index, and disarmed on every release/file reset
  // and whenever the effect's preconditions are not met — so an armed value can
  // never survive a close/reopen or a file switch and swallow a required plan.
  const planSelectedAudioRef = useRef<PlanAudioEcho | null>(null);
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
   * Browser-reported dropped/total video frame counts, sampled while playing.
   * Diagnostic-only (see `videoPlaybackQualitySnapshot`): lets a smoothness
   * check diff two samples across a seek/strategy-switch instead of guessing
   * from a screen recording. Never read by playback/strategy logic.
   */
  const [playbackQuality, setPlaybackQuality] = useState<VideoPlaybackQualitySnapshot>(EMPTY_PLAYBACK_QUALITY);
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
   * rendered as prose — the viewer does not need to be told about the
   * conversion pipeline, byte ranges or ffmpeg to watch a film.
   */
  const [strategy, setStrategy] = useState<string | null>(null);
  const [strategyReason, setStrategyReason] = useState<string | null>(null);
  /**
   * Strict disk-vs-swarm locality for the current plan. Drives loader copy and
   * gates startup swarm polling: a disk-backed plan has no peers on the
   * critical path, so polling for them is both pointless and a source of
   * misleading samples.
   */
  const [planSource, setPlanSource] = useState<PlanSource | null>(null);
  const [playbackRung, setPlaybackRung] = useState<string | null>(null);
  /**
   * A seek is in flight. Rendered as a spinner over the frame: without it the
   * player holds the *old* frame while the new position loads, which reads as a
   * freeze rather than as work happening.
   */
  const [seeking, setSeeking] = useState(false);
  /**
   * Debounced mirror of {@link seeking} for the loader only. It arms
   * {@link SEEK_LOADER_GRACE_MS} after a seek starts, so a quick scrub that
   * settles first never flashes the spinner — the one loader shows for a seek
   * only when the seek is genuinely taking a moment. Raw `seeking` still drives
   * the freeze/pin logic; only the *visible* loader waits.
   */
  const [seekLoaderArmed, setSeekLoaderArmed] = useState(false);
   const [theatreControlsVisible, setTheatreControlsVisible] = useState(true);
   const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false);
   const [audioMenuOpen, setAudioMenuOpen] = useState(false);
   const [volumeMenuOpen, setVolumeMenuOpen] = useState(false);
   const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
   const [qualityLoading, setQualityLoading] = useState(false);
   const [qualityError, setQualityError] = useState<string | null>(null);
   const [switchingInfoHash, setSwitchingInfoHash] = useState<string | null>(null);
    const [playPulse, setPlayPulse] = useState<"play" | "pause" | null>(null);
   const [resetInfoHash, setResetInfoHash] = useState(activeInfoHash);
   const [resetPlayableSrc, setResetPlayableSrc] = useState(playableSrc);
   if (activeInfoHash !== resetInfoHash) {
     setResetInfoHash(activeInfoHash);
     setPreserveOutgoingEpisode(false);
     setManifest(null);
     setManifestKey(null);
     setManifestLoading(false);
     setSelectedPath(null);
     setMessage(null);
     setProblem(null);
     setPlayableSrc(null);
     setPlaybackMode("direct");
     setCheckingStream(false);
     setWaiting(false);
     setActiveVideoAdvancing(false);
     setPlaybackStarted(false);
     setPreparingLabel(null);
     setStreamFailure(null);
     setRetrying(false);
     setSwarmSample(null);
     setUpNext(null);
     setUpNextLoading(false);
     setUpNextError(null);
     setEnded(false);
     setAutoAdvanceCancelled(false);
     setAdvanceCountdown(AUTO_ADVANCE_SECONDS);
     setCurrentSourceTime(0);
     setSourceDuration(null);
     setTimelineOffset(0);
     setBufferedRanges([]);
     setQualityLoading(false);
     setQualityError(null);
     setSwitchingInfoHash(null);
     // The strategy belongs to the plan of the release we just left. Leaving it
     // set would let the next release's cold swarm be read as proven-local
     // ("Preparing…"/"Seeking…") for the whole window before its own plan lands.
     setStrategy(null);
     setStrategyReason(null);
     setPlanSource(null);
     setPlanNonce((nonce) => nonce + 1);
   }
   /**
    * Same release, different episode (a season pack).
    *
    * The hash-keyed reset above cannot see this transition at all, so nothing
    * was invalidated and the player kept playing the file it already had. The
    * manifest itself is still correct — it lists every episode in the pack — so
    * when the server named the file, this selects it directly and no manifest
    * round trip happens at all. When it did not, the manifest is dropped so it
    * is re-resolved for the new episode.
    */
   const [resetTargetIdentity, setResetTargetIdentity] = useState(targetIdentity);
   if (targetIdentity !== resetTargetIdentity) {
     setResetTargetIdentity(targetIdentity);
     if (activeInfoHash === resetInfoHash) {
       const known =
         activeFilePath &&
         manifest?.infoHash === activeInfoHash &&
         manifest.files.some((file) => file.path === activeFilePath)
           ? activeFilePath
           : null;
       const keepOutgoingEpisode = shouldPreserveOutgoingEpisode({
         transitioning: preserveOutgoingEpisode,
         hasPlayableSource: Boolean(playableSrc),
         exactNextFileKnown: Boolean(known),
       });
       setPreserveOutgoingEpisode(keepOutgoingEpisode);
       setManifestKey(known ? targetIdentity : null);
       if (!known) setManifest(null);
       setSelectedPath(known);
       setMessage(null);
       setProblem(null);
       if (!keepOutgoingEpisode) {
         setPlayableSrc(null);
         setPlaybackMode("direct");
       }
       setCheckingStream(false);
       setWaiting(false);
       setActiveVideoAdvancing(false);
       if (!keepOutgoingEpisode) setPlaybackStarted(false);
       setPreparingLabel(null);
       setStreamFailure(null);
       setSwarmSample(null);
       setUpNext(null);
       setUpNextError(null);
       setEnded(false);
       setAutoAdvanceCancelled(false);
       setAdvanceCountdown(AUTO_ADVANCE_SECONDS);
       setCurrentSourceTime(0);
       setSourceDuration(null);
       setTimelineOffset(0);
       setBufferedRanges([]);
       setStrategy(null);
       setStrategyReason(null);
       setPlanSource(null);
       setPlanNonce((nonce) => nonce + 1);
     }
   }
   if (playableSrc !== resetPlayableSrc) {
     setResetPlayableSrc(playableSrc);
     setWaiting(false);
     setActiveVideoAdvancing(false);
     setPlaybackStarted(false);
     setUpNextLoading(Boolean(playableSrc));
   }
   const hlsRef = useRef<Hls | null>(null);
   const videoRef = useRef<HTMLVideoElement | null>(null);
   const fullscreenSurfaceRef = useRef<HTMLDivElement | null>(null);
   const motionLeaseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
   const lastActiveMediaTimeRef = useRef<number | null>(null);
   /**
    * Bounded counter for the silent metadata re-attempt (stream 425). Reset when
    * the target release/file changes — NOT on `planNonce`, or a retry that itself
    * bumps `planNonce` would zero its own budget and loop forever.
    */
   const metadataRetryRef = useRef(0);
   const requestedSeekRef = useRef<{ targetSec: number; attempts: number; attemptedAt: number } | null>(null);
   const seekRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Pending seek target on the source timeline, consumed by the next plan. */
  const pendingSeekRef = useRef(0);
  const seekInFlightRef = useRef(false);
  /**
   * The viewer's finger is down on the scrubber. While true, the drag owns the
   * displayed playhead and element `timeupdate`s are not adopted, so a playing
   * source cannot yank the thumb back under the finger — the fix for the
   * "scrubbing is jittery" report. The commit (and this flag's release) happens
   * on pointer/key up.
   */
  const isScrubbingRef = useRef(false);
  /**
   * Automatic-failover bookkeeping for one play session. Tried hashes make the
   * finite candidate set the stopping condition; overlapping recovery attempts
   * are suppressed. Both reset for fresh content or a new resolution intent.
   */
  const autoTriedHashesRef = useRef<Set<string>>(new Set());
  const autoFailoverInFlightRef = useRef(false);
  const preferredResolutionIntentRef = useRef<number | null>(null);
  /** Startup swarm samples accumulated for dead-evidence detection (Task 1). */
  const startupSamplesRef = useRef<SwarmSample[]>([]);
  /** Start time for verbose elapsed display (Task 4). */
  const verboseStartTimeRef = useRef<number | null>(null);
  /**
   * Monotonic transition token. Every explicit target change — a manual next, an
   * autoplay advance, a hand-picked quality switch, or a silent failover — takes
   * a fresh token; an async transition captures its token up front and refuses to
   * apply its late `setTarget` once a newer transition has superseded it. This is
   * the lock that stops a stale `/switch` or failover response from clobbering
   * the episode the viewer just chose by hand (duck issue 4).
   */
  const transitionGenRef = useRef(0);
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
  /** Element-relative landing point when a VOD playlist starts before the exact seek target. */
  const pendingHlsStartRef = useRef(0);
  /** The resume position is honoured once, for the first file opened. */
  const resumeConsumedRef = useRef(false);
  /** Detaches the seek-abort listener from the previous media element. */
  const hlsSeekAbortRef = useRef<(() => void) | null>(null);
  /**
   * Playback rate as a ref, so `attachHls` does not depend on it.
   *
   * As a dependency it made every speed change a new callback identity, which
   * React treats as a new `ref` — detaching, destroying the hls.js instance and
   * rebuilding it from an empty buffer. At 4K that is a full re-download of the
   * cushion for a 1.25x press. The rate is applied by the element effect below.
   */
  const playbackRateRef = useRef(1);
  /**
   * Video geometry/bitrate for the source currently being played, from the plan
   * probe. A ref, not state, for the same reason: buffer sizing must be
   * readable at attach time without making the callback unstable.
   */
  const sourceProfileRef = useRef<{ width: number | null; height: number | null; bitrateBps: number | null }>({
    width: null,
    height: null,
    bitrateBps: null,
  });
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

  const activeManifest =
    manifest?.infoHash === activeInfoHash && manifestKey === targetIdentity
      ? manifest
      : null;
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
  /**
   * Task 5: The title shown in the player header.
   *
   * When we know the season/episode (subtitle line already shows S01E01), the
   * episode code and anything after it in the torrent title is noise on the title
   * line. Strip it so the header reads "Show Name" / "S01E01 · WEB-DL" rather
   * than "Show Name S01E01 1080p WEB-DL" / "S01E01 · WEB-DL".
   */
  const displayTitle = useMemo(() => {
    if (currentSeason == null || currentEpisode == null) return activeTitle;
    const ep = `S${String(currentSeason).padStart(2, "0")}E${String(currentEpisode).padStart(2, "0")}`;
    const upper = activeTitle.toUpperCase();
    const idx = upper.indexOf(ep.toUpperCase());
    if (idx <= 0) return activeTitle;
    return activeTitle.slice(0, idx).replace(/[\s._-]+$/, "").trim() || activeTitle;
  }, [activeTitle, currentSeason, currentEpisode]);
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
  const viewerWaiting = shouldShowViewerBuffering({ waiting, activeVideoAdvancing });
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

  /**
   * First-PAINTED-frame latch (duck issue 3). `canplay`/`playing` signal
   * readiness, not presentation; latching the one loader off on them can drop it
   * a frame before the picture composites — a black blink. We defer those to
   * `requestVideoFrameCallback` (the first frame actually shown) and guard it with
   * `firstFrameAttemptRef` so a late callback from an OUTGOING source can never
   * latch the incoming attempt. `advancing` (real forward motion) stays an
   * immediate latch, and a short timeout backstops engines that never fire rVFC,
   * so the loader can never get stuck on.
   */
  const firstFrameAttemptRef = useRef(0);
  const firstFrameRvfcRef = useRef<number | null>(null);
  const firstFrameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelFirstFrameWatch = useCallback(() => {
    const video = videoRef.current as unknown as {
      cancelVideoFrameCallback?: (handle: number) => void;
    } | null;
    if (firstFrameRvfcRef.current != null && video?.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(firstFrameRvfcRef.current);
    }
    firstFrameRvfcRef.current = null;
    if (firstFrameTimerRef.current) {
      clearTimeout(firstFrameTimerRef.current);
      firstFrameTimerRef.current = null;
    }
  }, []);
  const latchFirstFrame = useCallback(
    (video: HTMLVideoElement) => {
      const attempt = firstFrameAttemptRef.current;
      const settle = () => {
        if (video !== videoRef.current || attempt !== firstFrameAttemptRef.current) return;
        setPlaybackStarted(true);
      };
      cancelFirstFrameWatch();
      const framed = video as unknown as {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      if (typeof framed.requestVideoFrameCallback === "function") {
        firstFrameRvfcRef.current = framed.requestVideoFrameCallback(() => {
          firstFrameRvfcRef.current = null;
          settle();
        });
      } else {
        // No rVFC (older Firefox): two rAFs ≈ one composited frame.
        requestAnimationFrame(() => requestAnimationFrame(settle));
      }
      // Backstop: a decodable-but-paused first frame may never trigger rVFC in
      // some engines. Latch anyway shortly after readiness so the loader cannot
      // hang over a picture that is already visible.
      firstFrameTimerRef.current = setTimeout(() => {
        firstFrameTimerRef.current = null;
        settle();
      }, 400);
    },
    [cancelFirstFrameWatch],
  );

  const activeMediaEvent = useCallback(
    (video: HTMLVideoElement, event: "waiting" | "playing" | "canplay" | "advancing") => {
      const active = video === videoRef.current;
      setWaiting((current) => nextViewerWaitingState(current, event, active));
      if (!active) return false;
      // A first frame (canplay), a resumed play, or real forward motion all mean
      // the picture is arriving. `advancing` is unambiguous presentation and
      // latches now; `canplay`/`playing` are readiness, so their latch is deferred
      // to the first PAINTED frame (duck issue 3). `waiting` (a stall) never
      // latches.
      if (event === "advancing") {
        setPlaybackStarted(true);
        setActiveVideoAdvancing(true);
        clearMotionLease();
        motionLeaseRef.current = setTimeout(() => {
          motionLeaseRef.current = null;
          setActiveVideoAdvancing(false);
        }, 1500);
      } else if (event === "canplay" || event === "playing") {
        latchFirstFrame(video);
      }
      return true;
    },
    [clearMotionLease, latchFirstFrame],
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
    // New source attempt → reset the first-frame latch synchronously and
    // invalidate any pending latch from the outgoing source (duck issue 3).
    firstFrameAttemptRef.current += 1;
    cancelFirstFrameWatch();
    resumeConsumedRef.current = false;
    pendingSeekRef.current = 0;
    pendingNativeSeekRef.current = 0;
    pendingHlsStartRef.current = 0;
    lastActiveMediaTimeRef.current = null;
    requestedSeekRef.current = null;
    clearMotionLease();
    clearSeekRetry();
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, [activeInfoHash, cancelFirstFrameWatch, clearMotionLease, clearSeekRetry]);

  // Clean up HLS instance on unmount or source change
  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      clearMotionLease();
      clearSeekRetry();
      cancelFirstFrameWatch();
    };
  }, [cancelFirstFrameWatch, clearMotionLease, clearSeekRetry]);

  useEffect(() => {
    // A new playable source is a new first-frame attempt: invalidate the previous
    // source's pending latch synchronously so it cannot latch the incoming one.
    firstFrameAttemptRef.current += 1;
    cancelFirstFrameWatch();
    lastActiveMediaTimeRef.current = null;
    requestedSeekRef.current = null;
    clearMotionLease();
    clearSeekRetry();
  }, [playableSrc, cancelFirstFrameWatch, clearMotionLease, clearSeekRetry]);

  // Debounce the seek → loader edge so short scrubs never flash the spinner.
  // The loader arms only if a seek is still unsettled after the grace window;
  // any earlier `seeked`/settle clears `seeking` and disarms it first.
  useEffect(() => {
    if (!seeking) return;
    const timer = setTimeout(() => setSeekLoaderArmed(true), SEEK_LOADER_GRACE_MS);
    return () => clearTimeout(timer);
  }, [seeking]);

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

  /**
   * Sample dropped/total video frame counts on a plain 1s timer rather than
   * from `onTimeUpdate` (which fires several times a second): this is a
   * diagnostic instrumentation hook for verifying post-seek smoothness, and a
   * high-frequency `setState` here would add its own render pressure to the
   * very jank it exists to help diagnose. Dedup-checked so a steady stream of
   * identical samples (paused, or between drops) does not force re-renders.
   */
  useEffect(() => {
    if (!playbackStarted) return;
    const id = window.setInterval(() => {
      const next = videoPlaybackQualitySnapshot(videoRef.current);
      setPlaybackQuality((prev) =>
        prev.droppedVideoFrames === next.droppedVideoFrames &&
        prev.totalVideoFrames === next.totalVideoFrames &&
        prev.corruptedVideoFrames === next.corruptedVideoFrames
          ? prev
          : next,
      );
    }, 1000);
    return () => window.clearInterval(id);
  }, [playbackStarted]);

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
      // A same-pack next transition may deliberately keep the outgoing element
      // mounted while the new plan resolves. Its late timeupdate/pause events
      // belong to the episode we already flushed, never to the new target.
      if (preserveOutgoingEpisode) return;
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
      preserveOutgoingEpisode,
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
   * Tell the server the player closed so a stream stops pulling pieces.
   *
   * A stream-only torrent is a cache of what is on screen, never a download the
   * viewer asked to keep. When they close the player it is off screen, and
   * continuing to fetch it spends their storage without consent — the exact
   * complaint this addresses. The server expires the foreground clock for this
   * hash and parks its cache; a later Play re-selects and resumes from disk.
   *
   * Best-effort by design: `sendBeacon` for the page-gone case, `keepalive`
   * fetch otherwise, every failure swallowed. If the beacon is missed the
   * foreground timestamp still decays on its own and the next reconcile parks
   * the stream — this only makes the common close instant.
   */
  const releaseStream = useCallback(() => {
    if (!activeInfoHash) return;
    const payload = JSON.stringify({
      action: "foreground",
      released: activeInfoHash,
    });
    try {
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        const blob = new Blob([payload], { type: "application/json" });
        if (navigator.sendBeacon("/api/prewarm", blob)) return;
      }
      void fetch("/api/prewarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {
        /* the idle grace + next reconcile still parks it */
      });
    } catch {
      /* sendBeacon/Blob unavailable: the stream parks on the idle path */
    }
  }, [activeInfoHash]);

  // Fire the release on the same "stopped watching" signals the progress flush
  // uses: collapsing the player (expanded → false), unmount, and the page going
  // away. Deliberately NOT on `visibilitychange`: a desktop tab-switch or
  // background audio keeps issuing range requests, and tearing the stream down
  // there would stutter what is still playing. Only an actual close should stop
  // the cache.
  useEffect(() => {
    if (!expanded) return;
    window.addEventListener("pagehide", releaseStream);
    return () => {
      window.removeEventListener("pagehide", releaseStream);
      releaseStream();
    };
  }, [expanded, releaseStream]);

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
      if (!activeInfoHash) return;
      const url = `${window.location.origin}${streamPath(activeInfoHash, path)}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (!theatre) setMessage("Stream URL copied.");
      window.setTimeout(() => setCopied(false), 1600);
    },
    [activeInfoHash, theatre],
  );

  const loadManifest = useCallback(async () => {
    if (!activeInfoHash) return null;
    // Reuse is keyed on the WHOLE target identity, not the hash. Inside a
    // season pack the hash is the same for every episode, so a hash-only guard
    // handed back the previous episode's manifest and file selection.
    if (manifest?.infoHash === activeInfoHash && manifestKey === targetIdentity) {
      return manifest;
    }
    setManifestLoading(true);
    setMessage(null);
    setProblem(null);
    try {
      const params = new URLSearchParams();
      if (requestedEpisode?.season != null) {
        params.set("season", String(requestedEpisode.season));
      }
      if (requestedEpisode?.episode != null) {
        params.set("episode", String(requestedEpisode.episode));
      }
      const res = await fetch(
        `/api/stream/${encodeURIComponent(activeInfoHash)}${
          params.size > 0 ? `?${params}` : ""
        }`,
      );
      if (!res.ok) {
        const mapped = streamStatusMessage(res.status);
        setProblem(mapped.problem);
        setMessage(mapped.message);
        return null;
      }
      const data = await readJson<StreamManifest>(res);
      if (data?.clientType && data.clientType !== "builtin") {
        setProblem("wrong-client");
        setMessage("This only plays through the built-in engine.");
        return null;
      }
      const files = Array.isArray(data?.files) ? data.files : [];
      const primaryVideoIndex =
        typeof data?.primaryVideoIndex === "number" ? data.primaryVideoIndex : null;
      const targetVideoIndex =
        typeof data?.targetVideoIndex === "number"
          ? data.targetVideoIndex
          : null;
      const next: StreamManifest = {
        infoHash: activeInfoHash,
        files,
        clientType: data?.clientType,
        primaryVideoIndex,
        targetVideoIndex,
      };
      setManifest(next);
      setManifestKey(targetIdentity);
      const videos = selectVideoFiles(files);
      const requested =
        targetVideoIndex == null
          ? null
          : videos.find((file) => file.index === targetVideoIndex) ?? null;
      // A file the caller already named wins over any inference: the server
      // resolved it from the pack's verified files, which is stronger evidence
      // than an index or a dominance heuristic.
      const named =
        activeFilePath && videos.some((file) => file.path === activeFilePath)
          ? activeFilePath
          : null;
      if (named) {
        setSelectedPath(named);
      } else if (requested) {
        setSelectedPath(requested.path);
      } else if (videos.length === 1) {
        // A lone video file is unambiguous — always play it, even when the
        // manifest carried no targetVideoIndex (single-episode torrents often
        // don't set one). Without this the sole file is never selected,
        // effectiveSelectedPath stays null, the plan effect never runs, and the
        // player hangs on the loader forever on a fully-downloaded file.
        setSelectedPath(videos[0].path);
      } else if (videos.length > 1) {
        // No episode target means this is a movie, not a season pack. A film
        // ships one feature plus junk (samples, trailers, featurettes); pick the
        // dominant feature and play — never demand a manual file pick. The engine
        // already chose it (primaryVideoIndex); honour that, falling back to the
        // local dominance test only when the server didn't supply one. Only a
        // genuine multi-file pack (an episode target, or no single dominant
        // feature) falls through to the picker.
        const feature =
          requestedEpisode == null ? mainFeatureFile(files, primaryVideoIndex) : null;
        if (feature) {
          setSelectedPath(feature.path);
        } else {
          setProblem(null);
          setProblem("missing");
          setMessage("This episode is not available in the selected version.");
        }
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
  }, [activeInfoHash, manifest, manifestKey, targetIdentity, activeFilePath, requestedEpisode]);

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
    autoTriedHashesRef.current = new Set();
    autoFailoverInFlightRef.current = false;
    void loadManifest();
  }, [expanded, loadManifest]);

  const loadUpNext = useCallback(
    async (signal?: AbortSignal) => {
      if (!activeInfoHash || !activeTitle.trim()) return null;
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
        const rawNext = normalizeUpNextCard(data?.next);
        const next = rawNext ? { ...rawNext, title: activeTitle } : null;
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
    const timer = window.setTimeout(
      () => void loadUpNext(controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [playableSrc, effectiveSelectedPath, loadUpNext]);

  /**
   * Warm the next episode's probe while the current one plays.
   *
   * The measurable cost of an episode transition that needs no download is the
   * cold ffprobe the next plan has to run. Warming it in idle time removes that
   * from the transition entirely — and the request is deliberately the narrow
   * `warm: true` plan, which reads only proven-local files and creates no
   * session, no ffmpeg and no swarm activity. There is no speculative
   * acquisition here on purpose: fetching bytes in the background would steal
   * bandwidth from the 4K stream the viewer is actually watching.
   *
   * Exactly once per resolved episode+file, only while the page is visible,
   * abortable, and completely invisible: the response is never read, so no
   * loading flag, message, source or target can be affected by it — a late or
   * failed warm cannot touch the episode on screen.
   */
  const warmedTargetRef = useRef<string | null>(null);
  const upNextInfoHash = upNext?.infoHash ?? null;
  const upNextFilePath = upNext?.filePath ?? null;
  useEffect(() => {
    if (!upNextInfoHash || !upNextFilePath) return;
    if (document.hidden) return;
    const key = `${upNextInfoHash}|${upNextFilePath}`;
    if (warmedTargetRef.current === key) return;
    const controller = new AbortController();
    let idleHandle: number | null = null;
    let timer: number | null = null;
    const run = () => {
      idleHandle = null;
      timer = null;
      warmedTargetRef.current = key;
      void fetch("/api/playback/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          infoHash: upNextInfoHash,
          filePath: upNextFilePath,
          warm: true,
        }),
        signal: controller.signal,
      }).catch(() => {});
    };
    const idle = requestIdle(run);
    idleHandle = idle.handle;
    timer = idle.timer;
    return () => {
      controller.abort();
      if (idleHandle !== null) cancelIdle(idleHandle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [upNextInfoHash, upNextFilePath]);

  const playUpNext = useCallback(
    (next: UpNextEpisodeCard | null = upNext) => {
      if (!next?.infoHash) return;
      // A manual/autoplay advance is the newest transition — supersede any
      // in-flight quality switch or silent failover so their late responses
      // cannot overwrite this episode (duck issue 4).
      transitionGenRef.current += 1;
      postProgress({ force: true });
      setPreserveOutgoingEpisode(
        next.infoHash === activeInfoHash &&
          Boolean(next.filePath) &&
          Boolean(playableSrc),
      );
      autoTriedHashesRef.current = new Set();
      autoFailoverInFlightRef.current = false;
      setTransitioningTitle(activeTitle);
      setEnded(false);
      setAutoAdvanceCancelled(false);
      setAdvanceCountdown(AUTO_ADVANCE_SECONDS);
      setTarget({
        infoHash: next.infoHash,
        title: activeTitle,
        episodeTitle: episodeTitleForTarget(
          episodeTitles,
          next.season,
          next.episode,
        ),
        season: next.season,
        episode: next.episode,
        // When the server named the file, the transition can select it without
        // asking for a manifest it already holds — the whole point of the
        // same-pack fast path. When it did not, this is null and the manifest
        // is re-resolved exactly as before.
        filePath: next.filePath ?? null,
        watchListItemId: activeWatchListItemId,
        posterUrl: activePosterUrl,
        resumeSec: 0,
      });
    },
    [
      upNext,
      activeInfoHash,
      activeTitle,
      playableSrc,
      postProgress,
      episodeTitles,
      activeWatchListItemId,
      activePosterUrl,
    ],
  );

  /**
   * Acquire the next episode and play it.
   *
   * ## Why this does not use the pre-warm endpoint
   *
   * It used to POST `action: "trigger"`, and that is why the button appeared
   * dead. `runPrewarm` is *speculative* background work and opens with a stack
   * of intent gates — `streaming-source` (the thing on screen is a stream),
   * `foreground-busy` (playback is active), a minimum-progress check, and a
   * concurrency cap. During playback at least one of those always matches, so
   * the request returned `{ ok: true, outcome: { status: "skipped" } }`,
   * acquired nothing, and the old code then discarded the body and re-read the
   * unchanged up-next card. A 200 that did nothing, reported as nothing.
   *
   * Those gates are right for speculation and wrong here: a click on Next is
   * not the app guessing, it is the viewer asking. So this takes the same
   * on-demand path an explicit episode Play takes, which has no such gates.
   *
   * `retention: "stream"` matters — advancing an episode while watching should
   * behave like the Play that got the viewer here, not quietly convert their
   * viewing into permanent downloads. `protectHashes` keeps reclamation from
   * evicting the episode still on screen to make room for its own successor.
   */
  const fetchUpNext = useCallback(async () => {
    if (!upNext || upNext.infoHash) return;
    setUpNextLoading(true);
    setUpNextError(null);
    try {
      const res = await fetch("/api/library/ondemand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: upNext.title,
          mediaType: "tv",
          season: upNext.season,
          episode: upNext.episode,
          watchListItemId: activeWatchListItemId ?? undefined,
          retention: "stream",
          protectHashes: activeInfoHash ? [activeInfoHash] : [],
        }),
      });
      const data = (await res.json().catch(() => null)) as OnDemandGrabResponse | null;

      if (data?.ok && data.infoHash) {
        // Straight into the player. Waiting for the next poll of the up-next
        // card would leave the viewer looking at an unchanged screen after a
        // click that did succeed.
        playUpNext({ ...upNext, infoHash: data.infoHash, availability: "downloading" });
        return;
      }

      setUpNextError(upNextFailureMessage(data));
      // Re-read regardless: the grab may have landed even though this response
      // could not say so, and a stale card would then be the lie.
      await loadUpNext();
    } catch {
      setUpNextError("Could not reach the server to fetch the next episode.");
    } finally {
      setUpNextLoading(false);
    }
  }, [upNext, activeInfoHash, activeWatchListItemId, loadUpNext, playUpNext]);

  const candidateRequestBody = useCallback(
    (chosenInfoHash?: string) => ({
      title: activeTitle,
      mediaType: currentMediaType,
      season: currentSeason,
      episode: currentEpisode,
      // Identity, not a filter preference: without it "The Odyssey" matches
      // every work ever given that name.
      ...(typeof year === "number" ? { year } : {}),
      currentInfoHash: activeInfoHash,
      ...(preferredResolutionIntentRef.current !== null
        ? { preferredResolution: preferredResolutionIntentRef.current }
        : {}),
      ...(chosenInfoHash ? { chosenInfoHash } : {}),
    }),
    [activeTitle, currentMediaType, currentSeason, currentEpisode, year, activeInfoHash],
  );

  const choosePreferredResolution = useCallback(
    async (preferredResolution: number) => {
      if (!activeInfoHash) return;
      setSwitchingInfoHash(activeInfoHash);
      setQualityLoading(true);
      setQualityError(null);
      const gen = (transitionGenRef.current += 1);
      autoTriedHashesRef.current = new Set();
      autoFailoverInFlightRef.current = false;
      preferredResolutionIntentRef.current = preferredResolution;
      try {
        const res = await fetch(
          `/api/stream/${encodeURIComponent(activeInfoHash)}/select`,
          {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(preferredResolutionRequestBody({
            title: activeTitle,
            mediaType: currentMediaType,
            season: currentSeason,
            episode: currentEpisode,
            year,
            preferredResolution,
          })),
        },
        );
        const data = await readJson<SwitchResponse>(res);
        if (!res.ok || !data?.ok) {
          setQualityError("That quality is not available right now.");
          return;
        }
        const resumeAt =
          typeof data.positionSec === "number" && Number.isFinite(data.positionSec)
            ? data.positionSec
            : currentSourceTimeRef.current;
        // A newer transition superseded this switch while it resolved — drop the
        // stale result rather than yank the viewer off what they just chose.
        if (transitionGenRef.current !== gen) return;
        setQualityMenuOpen(false);
        setTarget({
          infoHash: data.infoHash,
          title: activeTitle,
          episodeTitle: activeEpisodeTitle,
          season: currentSeason,
          episode: currentEpisode,
          posterUrl: activePosterUrl,
          watchListItemId: activeWatchListItemId,
          resumeSec: resumeAt,
        });
      } catch {
        setQualityError("That quality is not available right now.");
      } finally {
        setSwitchingInfoHash(null);
        setQualityLoading(false);
      }
    },
    [
      activeInfoHash,
      activeTitle,
      activeEpisodeTitle,
      currentSeason,
      currentEpisode,
      activePosterUrl,
      activeWatchListItemId,
      year,
    ],
  );

  /**
   * Clear every "this attempt failed" flag so a fresh attempt starts clean (I43).
   * Nothing here latches "already tried": a subsequent play/retry re-runs the
   * whole pipeline from a blank slate.
   */
  const resetPlaybackFailure = useCallback(() => {
    setMediaErrorDiagnostic(null);
    setProblem(null);
    setMessage(null);
    setStreamFailure(null);
    setPreparingLabel(null);
  }, []);

  /**
   * Silently recover from a source that cannot start (COMPLAINT 3).
   *
   * The player never narrates a health check nor hands the viewer a decision:
   * it reads the ranked candidate pool (which already carries the cached swarm
   * verdicts), picks the best release it has not already auto-tried, and asks
   * the switch executor to start it — carrying the current position across so a
   * working stream is never torn down to try another. Every unique candidate
   * is eligible exactly once; only pool exhaustion stops recovery. Returns true
   * when a switch was started (the caller keeps the loader up and does nothing
   * else) and false when recovery is genuinely exhausted.
   * Works for movies as well as episodes — the switch seam keys on content, not
   * media type, which is why changing a movie's release mid-watch works here.
   */
  const attemptAutoFailover = useCallback(async (): Promise<boolean> => {
    if (!activeInfoHash) return false;
    if (autoFailoverInFlightRef.current) return true;
    autoFailoverInFlightRef.current = true;
    // Claim a transition token so a manual next / hand-picked switch that lands
    // mid-recovery supersedes this silent failover instead of racing it.
    const gen = (transitionGenRef.current += 1);
    try {
      const res = await fetch("/api/playback/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(candidateRequestBody()),
      });
      const data = await readJson<CandidatesResponse>(res);
      if (!res.ok) return false;
      if (transitionGenRef.current !== gen) return true;
      const pool = Array.isArray(data?.candidates) ? data.candidates : [];
      let candidate = nextAutomaticCandidate(
        pool,
        activeInfoHash,
        autoTriedHashesRef.current,
      );
      while (candidate) {
        if (transitionGenRef.current !== gen) return true;
        try {
          const switchRes = await fetch("/api/playback/switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(candidateRequestBody(candidate.infoHash)),
          });
          const switchData = await readJson<SwitchResponse>(switchRes);
          if (transitionGenRef.current !== gen) return true;
          // A failed switch never tears down current playback; just try the next
          // candidate (or, once none remain, let the caller surface terminal).
          if (!switchRes.ok || !switchData?.ok) {
            candidate = nextAutomaticCandidate(
              pool,
              activeInfoHash,
              autoTriedHashesRef.current,
            );
            continue;
          }
          const resumeAt =
            typeof switchData.positionSec === "number" && Number.isFinite(switchData.positionSec)
              ? switchData.positionSec
              : currentSourceTimeRef.current;
          // Re-point at the new source. The single loader stays up across the
          // swap: activeInfoHash changing resets `playbackStarted`, and
          // `playableSrc` is null until the new plan resolves, so the spinner is
          // continuous with no torn-down/rebuilt loader.
          setTarget({
            infoHash: switchData.infoHash,
            title: activeTitle,
            episodeTitle: activeEpisodeTitle,
            season: currentSeason,
            episode: currentEpisode,
            posterUrl: activePosterUrl,
            watchListItemId: activeWatchListItemId,
            resumeSec: resumeAt,
          });
          return true;
        } catch {
          candidate = nextAutomaticCandidate(
            pool,
            activeInfoHash,
            autoTriedHashesRef.current,
          );
          continue;
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      autoFailoverInFlightRef.current = false;
    }
  }, [
    activeInfoHash,
    candidateRequestBody,
    activeTitle,
    activeEpisodeTitle,
    currentSeason,
    currentEpisode,
    activePosterUrl,
    activeWatchListItemId,
  ]);

  /**
   * I19b — retry the SAME release. POST the failover route with `action:"retry"`,
   * which clears the engine's dead-mark and re-announces/re-adds the same
   * infoHash. On success we reset the failure and re-arm the play pipeline
   * (bumping `planNonce`) so it re-attempts the same file cleanly — this is also
   * the I43 "a fresh Play re-attempts cleanly" path. If the engine has no source
   * to retry (RETRY_FAILED) or the failure was a playability one (NOT_RETRYABLE),
   * retrying the same bytes is pointless, so fall through to the version switch.
   */
  const retrySameRelease = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const res = await fetch("/api/playback/failover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "retry",
          infoHash: activeInfoHash,
          title: activeTitle,
          mediaType: currentMediaType,
          season: currentSeason,
          episode: currentEpisode,
          reason: "delivery",
        }),
      });
      const data = await readJson<{ ok?: boolean; code?: string }>(res);
      const retried = res.ok && data?.ok === true && data?.code === "RETRYING";
      if (!retried) {
        // Keep the exhausted state terminal. Quality selection is a proactive
        // viewer preference, never a recovery demand.
        setStreamFailure((prev) => (prev ? { ...prev, retryable: false } : prev));
        return;
      }
      // Re-attempt the same infoHash + file from a clean slate.
      resetPlaybackFailure();
      setPlayableSrc(null);
      setCheckingStream(true);
      setWaiting(false);
      setActiveVideoAdvancing(false);
      setPlaybackStarted(false);
      lastActiveMediaTimeRef.current = null;
      clearMotionLease();
      setPlanNonce((n) => n + 1);
    } catch {
      setStreamFailure((prev) => (prev ? { ...prev, retryable: false } : prev));
    } finally {
      setRetrying(false);
    }
  }, [
    retrying,
    activeInfoHash,
    activeTitle,
    currentMediaType,
    currentSeason,
    currentEpisode,
    resetPlaybackFailure,
    clearMotionLease,
  ]);

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
    const timer = window.setTimeout(() => {
      if (advanceCountdown <= 0) {
        playUpNext(upNext);
      } else {
        setAdvanceCountdown((countdown) => Math.max(0, countdown - 1));
      }
    }, advanceCountdown <= 0 ? 0 : 1000);
    return () => window.clearTimeout(timer);
  }, [ended, autoAdvanceCancelled, upNext, advanceCountdown, playUpNext]);

  // Theatre skips the toggle, so it also skips the manifest load the toggle
  // performed on the way through. Nothing else fetches it, so without this the
  // panel opens and sits on "Resolving files…" forever.
  useEffect(() => {
    if (!theatre) return;
    const timer = window.setTimeout(() => void loadManifest(), 0);
    return () => window.clearTimeout(timer);
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
        if (signal.aborted) {
          await res.body?.cancel().catch(() => {});
          return;
        }
        if (res.ok || res.status === 206) {
          await res.body?.cancel().catch(() => {});
          setPlaybackMode("direct");
          setPreserveOutgoingEpisode(false);
          setPlayableSrc(streamPath(hash, filePath));
          return;
        }
        // I19: the byte route answers a stall with a structured {code,
        // failureClass, retryable}. Before it ever becomes viewer-facing copy,
        // try to recover automatically — an automated check + silent switch to
        // the next best release, never a question handed to the viewer
        // (COMPLAINT 3). Only when recovery is genuinely exhausted do we surface
        // one terminal state.
        const failure = structuredFailureFromBody(
          await readJson<{ code?: string; failureClass?: string; retryable?: boolean }>(res),
        );
        if (!signal.aborted && (await attemptAutoFailover())) return;
        if (signal.aborted) return;
        if (failure) {
          setStreamFailure({ ...failure, candidatesExhausted: true });
          setProblem("stalled");
          setMessage(null);
          return;
        }
        const mapped = streamStatusMessage(res.status);
        setProblem(mapped.problem);
        setMessage(mapped.message);
      } catch {
        if (signal.aborted) return;
        if (await attemptAutoFailover()) return;
        setProblem("generic");
        setMessage("Could not check the stream.");
      }
    },
    [attemptAutoFailover],
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

  /**
   * Disarm the plan echo whenever the release or the selected file changes.
   *
   * Identity keying already makes a stale echo unmatchable, but holding one is
   * still a live hazard, so it is dropped at the source. Declared *before* the
   * playback effect (and keyed only on release/file, never on the audio index)
   * so on a switch it runs first, while the commit that merely mirrors the
   * plan's own chosen track back into state leaves the armed echo intact.
   */
  useEffect(() => {
    planSelectedAudioRef.current = null;
  }, [activeInfoHash, effectiveSelectedPath]);

  // Main playback effect: when a file is selected, negotiate the playback plan.
  // Also re-runs on `planNonce` — bumped when the viewer seeks past what the
  // current ffmpeg session has produced, or picks a different audio track.
  useEffect(() => {
    if (!expanded || !effectiveSelectedPath || !activeInfoHash) {
      // Preconditions failed (collapsed player, no file, no release). A value
      // armed by an earlier plan can no longer be consumed by the run it was
      // meant for, so it must not survive to match a later, unrelated run.
      planSelectedAudioRef.current = null;
      return;
    }
    const echo: PlanAudioEcho = {
      infoHash: activeInfoHash,
      filePath: effectiveSelectedPath,
      planNonce,
      audioStreamIndex,
    };
    if (shouldSuppressPlanEcho(planSelectedAudioRef.current, echo)) {
      // This run is the plan mirroring its own chosen track back into state.
      planSelectedAudioRef.current = null;
      return;
    }
    // Any other run is a real plan; a stale echo must not outlive it.
    planSelectedAudioRef.current = null;
    const controller = new AbortController();
    const filePath = effectiveSelectedPath;
    const startSec = pendingSeekRef.current;
    const requestedAudio = audioStreamIndex;
    const keepOutgoingEpisode = preserveOutgoingEpisode;

    void (async () => {
      // Reset state
      if (!keepOutgoingEpisode) {
        setPlayableSrc(null);
        setPlaybackMode("direct");
      }
      setWaiting(false);
      setActiveVideoAdvancing(false);
      setCheckingStream(true);
      setProblem(null);
      setMessage(null);
      setStreamFailure(null);
      setPreparingLabel(null);
      setSeeking(false);
      lastActiveMediaTimeRef.current = null;
      clearMotionLease();
      // A new session produces a new media element with an empty buffer; keeping
      // the old spans on screen for even one frame would be a stale claim.
      setBufferedRanges([]);
      // Buffer sizing belongs to the file being negotiated, never the last one.
      sourceProfileRef.current = { width: null, height: null, bitrateBps: null };
      if (!keepOutgoingEpisode && hlsRef.current) {
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
            // A cold/dead swarm can't even be probed. Recover automatically
            // (silent switch to the next best release) instead of narrating a
            // probe wait and handing the viewer a "try again" (COMPLAINT 3).
            if (!controller.signal.aborted && (await attemptAutoFailover())) return;
            if (controller.signal.aborted) return;
            setProblem("stalled");
            setMessage("This version is not ready to play yet. Try again in a moment.");
            return;
          }
          // Any other plan failure is not necessarily terminal: the byte route
          // may still serve this file directly. `tryDirectStream` owns the
          // recovery ladder from here (direct success → structured stall →
          // auto-failover), so no failover is attempted twice on this branch.
          await tryDirectStream(activeInfoHash, filePath, controller.signal);
          return;
        }

        const planData = await readJson<PlaybackPlanResponse>(planRes);
        if (!planData || controller.signal.aborted) return;

        setAudioTracks(planData.plan.audio);
        if (audioStreamIndex !== planData.plan.selectedAudioIndex) {
          planSelectedAudioRef.current = {
            infoHash: activeInfoHash,
            filePath,
            planNonce,
            audioStreamIndex: planData.plan.selectedAudioIndex,
          };
          setAudioStreamIndex(planData.plan.selectedAudioIndex);
        }
        setSourceDuration(planData.probe.duration);
        sourceProfileRef.current = {
          width: planData.probe.width ?? null,
          height: planData.probe.height ?? null,
          bitrateBps: normalizeProbeBitrate(planData.probe.bitrate),
        };
        setStrategy(planData.strategy ?? null);
        setStrategyReason(planData.strategyReason ?? null);
        const resolvedPlanSource = planSourceFromPlan(planData);
        setPlanSource(resolvedPlanSource);
        // A disk-backed plan has no swarm on the critical path: drop any
        // sample collected while locality was still unknown so it cannot leak
        // peer copy into the loader.
        if (resolvedPlanSource === "disk") setSwarmSample(null);
        setPlaybackRung(planData.plan.rung);
        if (/whole-file.*failed after/i.test(planData.strategyReason ?? "")) {
          // Optimized local playback fell back to the plain stream — an internal
          // recovery path, not a viewer-facing failure. Stay on the ONE loader
          // with no copy; playback continues below (COMPLAINT 2 / duck issue 1).
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
          pendingHlsStartRef.current = 0;
          if (startSec > 0) setCurrentSourceTime(startSec);
          setPreserveOutgoingEpisode(false);
          setPlayableSrc(nativeUrl);
          setTransitioningTitle(null);
        } else {
          // HLS — a genuinely incomplete file, or one that needs ffmpeg.
          setTimelineOffset(planData.startSec);
          pendingNativeSeekRef.current = 0;
          pendingHlsStartRef.current = seekPositionInPlannedTimeline(
            startSec,
            planData.startSec,
          );
          if (startSec > 0) {
            currentSourceTimeRef.current = startSec;
            setCurrentSourceTime(startSec);
          }
          setPlaybackMode("hls");
          setPreparingLabel("preparing");
          setPreserveOutgoingEpisode(false);
          setPlayableSrc(planData.playUrl);
          setTransitioningTitle(null);
        }
      } catch {
        // A network error / exception reaching the plan endpoint says nothing
        // about the byte route. Same recovery ladder as a non-503 plan failure;
        // it only sets terminal copy once recovery is genuinely exhausted.
        if (!controller.signal.aborted) {
          await tryDirectStream(activeInfoHash, filePath, controller.signal);
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
  }, [expanded, activeInfoHash, effectiveSelectedPath, planNonce, audioStreamIndex, tryDirectStream, clearMotionLease, attemptAutoFailover]);

  // The metadata re-attempt budget belongs to a target, not to a plan: reset it
  // only when the release/file actually changes, so a retry that bumps
  // `planNonce` (re-running the plan effect) does not refill its own budget.
  useEffect(() => {
    metadataRetryRef.current = 0;
  }, [activeInfoHash, effectiveSelectedPath]);

  // Silent metadata recovery (stream 425). Metadata still resolving is the SAME
  // release needing a moment — so re-attempt IT on a short delay, keeping the one
  // loader up and never asking the viewer anything (COMPLAINT 3). When the budget
  // is spent the release genuinely isn't delivering, so surface one honest
  // terminal state (a classified failure) rather than spinning forever.
  useEffect(() => {
    if (problem !== "metadata") return;
    if (metadataRetryRef.current >= MAX_METADATA_RETRIES) {
      setStreamFailure({ code: "STALLED", failureClass: "delivery", retryable: true });
      setProblem("stalled");
      setMessage(null);
      return;
    }
    metadataRetryRef.current += 1;
    const timer = window.setTimeout(() => setPlanNonce((n) => n + 1), METADATA_RETRY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [problem]);

  // Backstop watchdog for the bare, copy-free loader (duck: a spinner with no
  // text is acceptable ONLY if it cannot spin forever). Armed once per opened
  // release; cleared the instant the first frame is presented. If it fires, the
  // open is genuinely stuck past every specific recovery path, so make one last
  // silent failover attempt and, failing that, surface ONE honest terminal
  // state — never an endless spinner, never a question asked mid-wait.
  useEffect(() => {
    if (!expanded || !activeInfoHash || playbackStarted) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (await attemptAutoFailover()) return;
        setStreamFailure({
          code: "STALLED",
          failureClass: "delivery",
          retryable: true,
          candidatesExhausted: true,
        });
        setProblem("stalled");
        setMessage(null);
      })();
    }, OPENING_WATCHDOG_MS);
    return () => window.clearTimeout(timer);
  }, [expanded, activeInfoHash, effectiveSelectedPath, playbackStarted, attemptAutoFailover]);

  // Task 1 + 2: Evidence-based dead-swarm detection during startup.
  //
  // SwarmChip uses `active={Boolean(playableSrc)}` so it does NOT poll during
  // the loading/startup phase. This independent effect fills that gap: it polls
  // the stream-info endpoint every 5 s, accumulates samples, and applies the
  // same dead-swarm rule that `classifySwarm` in swarm-probe.ts uses —
  //   peers > 0 (swarm reached) AND bytes delivered = 0 (nothing arriving).
  // On confirmed evidence of a dead swarm it immediately attempts a silent
  // failover (Task 2) rather than spinning for the full OPENING_WATCHDOG_MS.
  // "Unknown" (null peers / null speed) is never treated as dead.
  useEffect(() => {
    if (!expanded || !activeInfoHash || playbackStarted || streamFailure) return;
    // A disk-backed plan reads a complete local file: there is no swarm on the
    // critical path, so polling for peers can only produce misleading samples
    // (and a false dead-swarm failover). Drop any sample already collected so
    // no stale peer reading can leak into the loader copy.
    if (planSource === "disk") {
      startupSamplesRef.current = [];
      return;
    }
    startupSamplesRef.current = [];
    let stopped = false;

    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/stream/${activeInfoHash}?poll=1`);
        if (!res.ok || stopped) return;
        const data = (await res.json()) as Partial<SwarmSample>;
        if (stopped) return;
        // Only accumulate samples where every field is a concrete measurement.
        if (
          data.peers != null &&
          data.downloadSpeedBps != null &&
          data.progress != null
        ) {
          const sample = data as SwarmSample;
          startupSamplesRef.current = [...startupSamplesRef.current, sample];
          setSwarmSample(sample);
        }
        if (deadEvidenceFromSamples(startupSamplesRef.current)) {
          stopped = true;
          const advanced = await attemptAutoFailover();
          if (!advanced) {
            setStreamFailure({
              code: "STALLED",
              failureClass: "delivery",
              retryable: true,
              candidatesExhausted: true,
            });
            setProblem("stalled");
            setMessage(null);
          }
          return;
        }
        scheduleNext();
      } catch {
        // Network error during startup probe — silently retry next tick.
        scheduleNext();
      }
    };

    let timerId: ReturnType<typeof setTimeout> = null as unknown as ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      if (!stopped) timerId = setTimeout(() => void poll(), 5000);
    };

    // Kick off first poll after the first 5-second window.
    timerId = setTimeout(() => void poll(), 5000);

    return () => {
      stopped = true;
      clearTimeout(timerId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, activeInfoHash, playbackStarted, !!streamFailure, attemptAutoFailover, planSource]);

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
    // Same reason as the release reset: the previous file's strategy must not
    // describe the new file's wait until its own plan answers.
    setStrategy(null);
    setStrategyReason(null);
    setPlanSource(null);
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
    if (!expanded || !effectiveSelectedPath || !planResolved || !activeInfoHash) return;
    const controller = new AbortController();
    const filePath = effectiveSelectedPath;
    void (async () => {
      try {
        const res = await fetch(subtitleListUrl(activeInfoHash, filePath), {
          signal: controller.signal,
        });
        if (!res.ok || controller.signal.aborted) {
          if (!controller.signal.aborted) {
            const failure = await readJson<{ message?: string; error?: string }>(res);
            setSubtitleStatus("error");
            const diagnostic =
              failure?.message?.trim() || failure?.error?.trim() || null;
            if (diagnostic) console.warn("[subtitles] lookup failed", diagnostic);
            setSubtitleNote("Subtitles could not be checked for this video.");
          }
          return;
        }
        const data = await readJson<SubtitleListResponse>(res);
        if (!data || controller.signal.aborted) return;
        const tracks = Array.isArray(data.tracks) ? data.tracks : [];
        setSubtitleTracks(tracks);
        setSubtitleNote(unsupportedSubtitleNote(tracks));
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
          if (data.subtitleDefault?.noEnglishAvailable) {
            setSubtitleNote(`English subtitles are unavailable — using ${chosen.label}.`);
          }
        } else if (data.subtitleDefault?.noEnglishAvailable) {
          // Foreign audio and no English subtitle exists: say so out loud rather
          // than sit on a silent "Off".
          setSubtitleNote("No English subtitles available for this video.");
        }
        if (tracks.length > 0 && data.embeddedInspected === false) {
          setSubtitleNote(
            "Some subtitles could not be checked — only subtitle files are listed.",
          );
        }
      } catch {
        if (!controller.signal.aborted) {
          setSubtitleStatus("error");
          setSubtitleNote("Subtitles could not be checked for this video.");
        }
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
      setSeekLoaderArmed(false);
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
        setMessage((current) => current === "Getting that spot ready…" ? null : current);
        setSeeking(false);
        return;
      }
      if (action === "failed") {
        requestedSeekRef.current = null;
        clearSeekRetry();
        setMessage("That spot isn't ready yet — try again in a moment.");
        setSeeking(false);
        return;
      }
      if (action === "retry" && !seekRetryTimerRef.current) {
        setMessage("Getting that spot ready…");
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
  const [previousControlsPinned, setPreviousControlsPinned] =
    useState(controlsPinned);
  if (controlsPinned !== previousControlsPinned) {
    setPreviousControlsPinned(controlsPinned);
    if (!controlsPinned) setTheatreControlsVisible(true);
  }

  const showTheatreControls = useCallback(() => {
    setTheatreControlsVisible(true);
    if (controlsIdleRef.current) clearTimeout(controlsIdleRef.current);
    if (controlsPinned) return;
    controlsIdleRef.current = setTimeout(() => setTheatreControlsVisible(false), 3000);
  }, [controlsPinned]);

  useEffect(() => {
    if (controlsIdleRef.current) clearTimeout(controlsIdleRef.current);
    if (controlsPinned) return;
    controlsIdleRef.current = setTimeout(
      () => setTheatreControlsVisible(false),
      3000,
    );
    return () => {
      if (controlsIdleRef.current) clearTimeout(controlsIdleRef.current);
    };
  }, [controlsPinned]);

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
    if (!activeSubtitle || !effectiveSelectedPath || !activeInfoHash) return null;
    const offset = playbackMode === "hls" ? timelineOffset : 0;
    const windowStart =
      activeSubtitle.kind === "embedded" && activeSubtitle.needsExtraction
        ? subtitleWindowStart(currentSourceTime)
        : 0;
    const consumerId = `${panelId}:track:${windowStart}`;
    return subtitleTrackSrc(
      activeInfoHash,
      effectiveSelectedPath,
      activeSubtitle.id,
      offset,
      windowStart,
      consumerId,
    );
  }, [
    activeSubtitle,
    activeInfoHash,
    currentSourceTime,
    effectiveSelectedPath,
    playbackMode,
    panelId,
    timelineOffset,
  ]);

  useEffect(() => {
    if (!activeSubtitleSrc) return;
    return () => {
      void fetch(activeSubtitleSrc, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => undefined);
    };
  }, [activeSubtitleSrc]);

  const subtitlePrefetchWindow = useMemo(() => {
    if (
      !activeSubtitle ||
      activeSubtitle.kind !== "embedded" ||
      !activeSubtitle.needsExtraction
    ) {
      return null;
    }
    const currentWindow = subtitleWindowStart(currentSourceTime);
    const nextWindow = currentWindow + SUBTITLE_WINDOW_STRIDE_SECONDS;
    return currentSourceTime >= nextWindow - 60 ? nextWindow : null;
  }, [activeSubtitle, currentSourceTime]);

  useEffect(() => {
    if (
      subtitlePrefetchWindow == null ||
      !activeSubtitle ||
      !effectiveSelectedPath ||
      !activeInfoHash
    ) {
      return;
    }
    const controller = new AbortController();
    const offset = playbackMode === "hls" ? timelineOffset : 0;
    const prefetchSrc = subtitleTrackSrc(
      activeInfoHash,
      effectiveSelectedPath,
      activeSubtitle.id,
      offset,
      subtitlePrefetchWindow,
      `${panelId}:prefetch:${subtitlePrefetchWindow}`,
    );
    void fetch(
      `${prefetchSrc}${prefetchSrc.includes("?") ? "&" : "?"}prefetch=1`,
      { signal: controller.signal },
    )
      .then((response) => response.body?.cancel())
      .catch((error: unknown) => {
        if ((error as Error)?.name !== "AbortError") {
          console.warn("[subtitles] next window prefetch failed");
        }
      });
    return () => {
      controller.abort();
      void fetch(prefetchSrc, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => undefined);
    };
  }, [
    activeInfoHash,
    activeSubtitle,
    effectiveSelectedPath,
    panelId,
    playbackMode,
    subtitlePrefetchWindow,
    timelineOffset,
  ]);

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
  }, [activeSubtitle, activeSubtitleSrc, playableSrc, playbackMode]);

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
    video.playbackRate = playbackRateRef.current;

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

    const bufferSettings = hlsBufferSettingsForSource({
      width: sourceProfileRef.current.width ?? (video.videoWidth || null),
      height: sourceProfileRef.current.height ?? (video.videoHeight || null),
      bitrateBps: sourceProfileRef.current.bitrateBps,
    });

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
      maxBufferLength: bufferSettings.maxBufferLength,
      maxMaxBufferLength: bufferSettings.maxMaxBufferLength,
      /**
       * Bytes matter more than seconds: the same seconds cost several times
       * more at 2160p than at 1080p, so the budget is sized from the source's
       * own resolution/bitrate (see `hlsBufferSettingsForSource`) instead of a
       * single 1080p-shaped constant.
       */
      maxBufferSize: bufferSettings.maxBufferSize,
      /**
       * Keep history behind the playhead. hls.js defaults to evicting the back
       * buffer aggressively, so nudging back 10s re-downloaded a fragment the
       * browser had held moments earlier — the exact "stutter when I move"
       * complaint. Bounded, and shorter at 4K, so a two-hour film cannot pin
       * memory.
       */
      backBufferLength: bufferSettings.backBufferLength,
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
      // The plan may trim a VOD playlist to the nearest segment boundary before
      // the requested source time. Start within that rebased playlist at the
      // remaining delta so an out-of-window seek lands on the exact target
      // instead of a few seconds early.
      startPosition: pendingHlsStartRef.current,
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
        const target = video.currentTime;
        // hls.js also emits `seeking` while nudging across a gap. Restarting the
        // loader for those automatic corrections discards the append queue and
        // can turn one small under-run into a repeated stop/start cycle.
        const hasUserSeekIntent = requestedSeekRef.current != null;
        // Already buffered: there is no in-flight fragment worth abandoning,
        // and restarting would discard the append queue and re-fetch what the
        // browser already holds. Let the loader keep going.
        if (!hlsSeekShouldRestartLoader({
          hasUserSeekIntent,
          buffered: timeRangesToRanges(video.buffered),
          targetSec: target,
        })) {
          return;
        }
        try {
          hls.stopLoad();
          hls.startLoad(target);
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
   * Transport keys, bound to the window while this player is expanded with
   * something to play.
   *
   * They used to live on the container's `onKeyDown`, but the container had no
   * `tabIndex` and nothing ever focused it, so the handler only fired in the
   * rare instant a child control happened to hold focus — in practice, never.
   * A window listener makes the shortcuts work the moment the player is on
   * screen, which is what a viewer expects.
   *
   * `expanded` is what keeps the old "one player owns the keys" guarantee that
   * container scope gave for free: a collapsed inline player on the same page
   * has no listener attached, so it cannot steal a keypress from the one the
   * viewer actually opened.
   *
   * Typing targets are still excluded — the file/audio/subtitle selects and the
   * seek slider have their own keyboard behaviour, and a focused button keeps
   * Space as its own activation — so the shortcuts never break the control the
   * viewer is actually using.
   */
  useEffect(() => {
    if (!expanded || !playableSrc) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "SELECT" ||
        tag === "TEXTAREA" ||
        el?.isContentEditable
      ) {
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
        case "arrowup":
          e.preventDefault();
          changeVolume(Math.min(1, volume + 0.1));
          return;
        case "arrowdown":
          e.preventDefault();
          changeVolume(Math.max(0, volume - 0.1));
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    expanded,
    playableSrc,
    togglePlay,
    seekRelative,
    changeVolume,
    volume,
    goFullscreen,
    toggleMute,
  ]);

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
      video.playbackRate = playbackRateRef.current;
    },
    [],
  );

  useEffect(() => {
    playbackRateRef.current = playbackRate;
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
    setMessage("This video's audio can't be played in the browser. Try another version for sound.");
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
      setMediaErrorDiagnostic(verdict.diagnostic);
      if (verdict.recoverable) {
        const resumeAt =
          playbackMode === "hls"
            ? timelineOffset + video.currentTime
            : currentSourceTimeRef.current || video.currentTime;
        pendingSeekRef.current = Math.max(0, Number.isFinite(resumeAt) ? resumeAt : currentSourceTimeRef.current);
        setProblem(null);
        setMessage(verdict.detail);
        setPreparingLabel("preparing");
        setWaiting(false);
        setActiveVideoAdvancing(false);
        lastActiveMediaTimeRef.current = null;
        clearMotionLease();
        setPlanNonce((n) => n + 1);
        return;
      }
      // A decode/unsupported verdict is a playability failure: the bytes arrived
      // but this release can't be decoded here. Retrying the same file is
      // pointless. Before surfacing anything, recover silently (COMPLAINT 3):
      // keep the one loader up (playbackStarted=false) and let the automatic
      // switch swap in the next candidate. Only when recovery is genuinely
      // exhausted do we surface UNPLAYABLE → the panel offers "Try another
      // version", never "Retry" (I19).
      if (verdict.kind === "decode" || verdict.kind === "unsupported" || verdict.kind === "unknown") {
        setPlaybackStarted(false);
        void attemptAutoFailover().then((recovered) => {
          if (recovered) return;
          setProblem(verdict.problem);
          setMessage(verdict.detail);
          setPlayableSrc(null);
          setStreamFailure({ code: "UNPLAYABLE", failureClass: "playability", retryable: false });
        });
        return;
      }
      setProblem(verdict.problem);
      setMessage(verdict.detail);
      setPlayableSrc(null);
    },
    [clearMotionLease, playbackMode, timelineOffset, attemptAutoFailover],
  );

  const handleMediaTimeUpdate = useCallback(
    (video: HTMLVideoElement) => {
      if (playbackMode === "direct") checkDecodedAudio(video);
      const position = playbackMode === "hls" ? timelineOffset + video.currentTime : video.currentTime;
      // The displayed playhead only adopts the element's reported position when
      // no seek is unsettled. While an HLS restart is in flight the outgoing
      // element still reads the pre-seek position, and while a user seek is
      // reconciling the element reports intermediate/old positions on the way to
      // the target — adopting either snaps the scrubber back to where the viewer
      // just left. Holding the requested target until the real position lands is
      // what stops "one click, then it bounces back a few times".
      if (shouldAdoptTimeUpdate({
        seekInFlight: seekInFlightRef.current,
        hasPendingUserSeek: requestedSeekRef.current != null,
        isUserScrubbing: isScrubbingRef.current,
      })) {
        setCurrentSourceTime(position);
        currentSourceTimeRef.current = position;
        noteActiveMediaTime(video, position);
      }
      // Reconcile a pending user seek against the element's *real* position so it
      // can settle (or retry) — but never mid HLS restart, when the reported
      // position is stale.
      if (!seekInFlightRef.current) reconcileRequestedSeek(position);
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
        if (event.currentTarget === videoRef.current) {
          setSeekLoaderArmed(false);
          setSeeking(true);
        }
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
                setSubtitleNote(
                  "This subtitle track could not be loaded. Try another track.",
                );
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
                setSubtitleNote(
                  "This subtitle track could not be loaded. Try another track.",
                );
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
    "h-8 min-w-0 max-w-full appearance-none truncate py-1 pl-3 pr-8 text-[11px] outline-none transition focus-visible:ring-2",
    theatre
      ? "w-20 rounded-full border border-white/15 bg-white/10 text-white focus-visible:ring-white/25 sm:w-40"
      : "input-field w-24 px-1.5 focus-visible:ring-[var(--accent-dim)] sm:w-40",
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
          "flex min-w-0 max-w-full items-center gap-2 text-[11px] text-[var(--text-tertiary)]",
          theatre && "text-white/70",
        )}
      >
        <span className={theatre ? "hidden sm:inline" : undefined}>Audio</span>
        <span className="relative min-w-0 max-w-full">
          <select
            className={compactSelectClass}
            value={audioStreamIndex ?? ""}
            data-stream-audio-select
            aria-label="Audio track"
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
          "flex min-w-0 max-w-full items-center gap-2 text-[11px] text-[var(--text-tertiary)]",
          theatre && "text-white/70",
        )}
      >
        <span className={theatre ? "hidden sm:inline" : undefined}>Subtitles</span>
        <span className="relative min-w-0 max-w-full">
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
    // 44×44px minimum touch target on every transport control (ui-ux-pro-max
    // touch rule): the tappable box is 44px while the glyph stays small.
    const buttonClass = cn(
      "grid shrink-0 place-items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2",
      large
        ? "h-11 w-11 text-white/80 hover:bg-white/12 hover:text-white focus-visible:outline-white"
        : "h-11 w-11 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline-[var(--accent)]",
    );
    const playButtonClass = cn(
      "grid shrink-0 place-items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2",
      large
        ? "h-11 w-11 bg-white text-black hover:scale-105 focus-visible:outline-white"
        : "h-11 w-11 bg-[var(--accent)] text-black hover:brightness-110 focus-visible:outline-[var(--accent)]",
    );
    const iconClass = large ? "h-5 w-5" : "h-4 w-4";
    return (
      <div
        data-stream-transport-row
        className={cn(
          "flex min-w-0 max-w-full items-center",
          large
            ? "flex-wrap gap-1 text-white sm:gap-2"
            : "mx-auto w-full max-w-6xl flex-wrap gap-2 rounded-xl border border-white/10 bg-black/70 px-3 py-2 text-white shadow-[var(--shadow-md)] backdrop-blur",
        )}
      >
        <button type="button" data-stream-transport onClick={togglePlay} disabled={!playableSrc} aria-label={isPlaying ? "Pause" : "Play"} className={playButtonClass}>
          {isPlaying ? <Pause className={cn(iconClass, "fill-current")} /> : <Play className={cn(iconClass, "translate-x-px fill-current")} />}
        </button>
        <button
          type="button"
          data-stream-next
          // Reuse the exact up-next/autoplay resolution: play the prewarmed next
          // episode when it is ready, otherwise kick the same grab the up-next
          // card's fetch action uses. No duplicated resolution logic. Disabled
          // (never hidden) when there is genuinely no next item — a movie or the
          // last episode — so the control greys out instead of appearing and
          // disappearing. aria-label only; no `title` tooltip over the frame.
          onClick={() => {
            if (upNext?.infoHash) playUpNext(upNext);
            else void fetchUpNext();
          }}
          disabled={!upNext || upNextLoading}
          aria-label="Next episode"
          className={buttonClass}
        >
          {upNextLoading ? (
            <Loader2 className={cn(iconClass, "animate-spin")} />
          ) : (
            <SkipForward className={iconClass} />
          )}
        </button>
        <button type="button" onClick={() => seekRelative(-10)} disabled={!playableSrc} aria-label="Back 10 seconds" className={buttonClass}>
          <RotateCcw className={iconClass} />
        </button>
        <button type="button" onClick={() => seekRelative(10)} disabled={!playableSrc} aria-label="Forward 10 seconds" className={buttonClass}>
          <RotateCw className={iconClass} />
        </button>
        <span className={cn("shrink-0 tabular-nums", large ? "min-w-[84px] text-[12px] text-white/80" : "min-w-[76px] text-[11px] text-white/70")}>
          {formatClock(currentSourceTime)} / {sourceDuration && sourceDuration > 0 ? formatClock(sourceDuration) : "0:00"}
        </span>
        {sourceDuration && sourceDuration > 0 ? (
          <span className={cn("relative flex min-w-0 flex-1 basis-full items-center sm:basis-auto", large ? "sm:min-w-[200px]" : "sm:min-w-[180px]")}>
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
              onPointerDown={() => {
                // COMPLAINT 4: while the viewer drags, gate `timeupdate` adoption
                // so the reconcile loop can't yank the thumb back to the video's
                // real position mid-drag. The displayed thumb tracks the drag at
                // input speed; the actual seek commits once, on release.
                isScrubbingRef.current = true;
              }}
              onMouseUp={(e) => {
                handleSourceSeek(Number(e.currentTarget.value));
                isScrubbingRef.current = false;
              }}
              onKeyUp={(e) => {
                handleSourceSeek(Number(e.currentTarget.value));
                isScrubbingRef.current = false;
              }}
              onTouchEnd={(e) => {
                handleSourceSeek(Number(e.currentTarget.value));
                isScrubbingRef.current = false;
              }}
              onPointerCancel={() => {
                isScrubbingRef.current = false;
              }}
              onBlur={() => {
                isScrubbingRef.current = false;
              }}
            />
          </span>
        ) : (
          // No copy while the timeline resolves (COMPLAINT 2): reserve the exact
          // scrubber footprint with an inert rail so the control bar doesn't shift
          // (CLS) and no second loading indicator appears here. The single
          // StreamLoader over the stage is the only busy signal.
          <span aria-hidden="true" className={cn("relative flex min-w-0 flex-1 basis-full items-center sm:basis-auto", large ? "sm:min-w-[200px]" : "sm:min-w-[180px]")}>
            <span className={cn("pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full", large ? "bg-white/18" : "bg-[var(--border)]")} />
          </span>
        )}
        <button type="button" onClick={toggleMute} disabled={!playableSrc} aria-label={muted ? "Unmute" : "Mute"} className={buttonClass}>
          {muted ? <VolumeX className={iconClass} /> : <Volume2 className={iconClass} />}
        </button>
        <input data-stream-volume type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume" className="hidden w-20 sm:block" onChange={(e) => changeVolume(Number(e.target.value))} />
        <label className={cn("flex min-w-0 max-w-full shrink-0 items-center gap-1.5 text-[11px]", large ? "text-white/70" : "text-white/65")}>
          <span className={large ? "hidden sm:inline" : undefined}>Speed</span>
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
            <div data-quality-selector className="fixed inset-x-4 bottom-20 z-[100] overflow-hidden rounded-2xl border border-white/10 bg-black/90 p-2 text-sm text-white shadow-2xl backdrop-blur sm:absolute sm:inset-x-auto sm:bottom-full sm:right-0 sm:mb-2 sm:w-36">
              <div className="px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">Quality</p>
              </div>
              {qualityError ? <p className="mx-2 mb-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-100">{qualityError}</p> : null}
              <PlayerQualityChoices
                disabled={qualityLoading}
                onSelect={(resolution) =>
                  void choosePreferredResolution(resolution)
                }
              />
            </div>
          ) : null}
        </div>
        <button type="button" onClick={goFullscreen} disabled={!playableSrc} aria-label={fullscreenActive ? "Exit full screen" : "Full screen"} className={buttonClass}>
          {fullscreenActive ? <Minimize className={iconClass} /> : <Maximize className={iconClass} />}
        </button>
      </div>
    );
  };

  // ── The single loader boolean, hoisted ABOVE the theatre/inline branch ──────
  // Both surfaces read THIS one `showLoader`, so neither branch can invent a
  // second spinner or restart it. It ORs every pre-first-frame moment (no source
  // ∪ resolving ∪ opening ∪ buffering, via `!playbackStarted`) with the mid-play
  // transient (seek/prepare/checking) and the HLS manifest fetch, and is forced
  // off the instant a terminal error owns the surface or the picture advances.
  const hasVisibleVideo = Boolean(playableSrc && selectedFile);
  const deliveryDetail = "not enough of it has arrived to play";
  const { title: terminalTitle, detail: terminalDetail } = terminalPlaybackCopy({
    problem,
    message,
    deliveryDetail,
  });
  const failureCopy = streamFailure ? playbackFailureCopy(streamFailure) : null;
  // Terminality is EXPLICIT — never inferred from a diagnostic message. A bare
  // `message` (a reconnect note, a seek-retry hint, an internal fallback) or a
  // recovering `problem` ("stalled"/"preparing" while silent auto-failover is
  // working) keeps the ONE loader up with no panel. Only a classified
  // `streamFailure` (silent recovery genuinely exhausted) or a hard "can't play
  // here" problem replaces the spinner with a terminal panel. This is what stops
  // a recoverable state from tearing the single loader down mid-journey.
  const terminalFailure = isTerminalPlayback({ problem, hasStreamFailure: Boolean(streamFailure) });
  const panelTitle = failureCopy?.headline ?? (terminalFailure ? terminalTitle : null);
  const panelDetail = failureCopy?.detail ?? (terminalFailure ? terminalDetail : null);
  // A release switch / manual next / autoplay transition owns the loader while it
  // resolves, so it stays continuous across the source swap.
  const switchingLoader = Boolean(switchingInfoHash) || Boolean(transitioningTitle);
  const showLoader =
    shouldShowUnifiedLoader({
      hasVisibleVideo,
      activeVideoAdvancing,
      // Grace-armed, not raw `seeking`, so a quick scrub commits without a
      // loader flash (COMPLAINT 4).
      seeking: seekLoaderArmed,
      waiting,
      preparing: Boolean(preparingLabel),
      checking: checkingStream,
      switching: switchingLoader,
      terminal: terminalFailure,
      playbackStarted,
    }) || manifestLoading;
  const [loaderElapsedActive, setLoaderElapsedActive] = useState(showLoader);
  if (showLoader !== loaderElapsedActive) {
    setLoaderElapsedActive(showLoader);
    setVerboseElapsedSec(0);
  }
  useEffect(() => {
    if (!showLoader) {
      verboseStartTimeRef.current = null;
      return;
    }
    verboseStartTimeRef.current = Date.now();
    const id = setInterval(() => {
      setVerboseElapsedSec(
        Math.floor((Date.now() - (verboseStartTimeRef.current ?? Date.now())) / 1000),
      );
    }, 1000);
    return () => {
      clearInterval(id);
      verboseStartTimeRef.current = null;
    };
  }, [showLoader]);
  const loaderStatus = showLoader
    ? loaderStatusFromSamples({
        preparingLabel: preparingLabel ?? (checkingStream || manifestLoading || switchingLoader ? "preparing" : null),
        sample: swarmSample,
        elapsedSec: verboseElapsedSec,
        strategy,
        planSource,
        playbackEstablished: playbackStarted,
      })
    : undefined;
  const subtitleStatusMessage = subtitleStatusCopy(subtitleStatus, subtitleNote);

  if (theatre) {
    const chromeVisible = theatreControlsVisible || controlsPinned;
    const controlsOpacity = chromeVisible ? "opacity-100" : "opacity-0";
    const controlsPointerEvents = chromeVisible
      ? "pointer-events-auto"
      : "pointer-events-none";
    const selectedAudioTrack =
      audioTracks.find((track) => track.streamIndex === audioStreamIndex) ?? null;
    const selectedAudioSummary = selectedAudioTrack
      ? `${languageLabel(selectedAudioTrack.language) || selectedAudioTrack.title || "Selected"} audio`
      : null;

    return (
      <div
        className={cn(
          "flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden sm:px-6 sm:pb-4 sm:pt-14",
          !theatreControlsVisible && !controlsPinned && "cursor-none",
          className,
        )}
        data-inline-player
        data-playback-started={playbackStarted ? "true" : "false"}
        data-player-chrome={chrome}
        data-playback-mode={playbackMode}
        data-playback-strategy={strategy ?? undefined}
        data-plan-source={planSource ?? undefined}
        data-playback-rung={playbackRung ?? undefined}
        data-strategy-reason={strategyReason ?? undefined}
        data-resume-sec={resumeTargetSec > 0 ? resumeTargetSec : undefined}
        data-dropped-video-frames={playbackQuality.droppedVideoFrames}
        data-total-video-frames={playbackQuality.totalVideoFrames}
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
              className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black bg-cover bg-center sm:h-auto sm:aspect-video sm:max-h-full sm:rounded-2xl sm:border sm:border-white/12 sm:shadow-[0_24px_90px_rgba(0,0,0,0.68)] sm:ring-1 sm:ring-black/50"
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

              {panelTitle ? (
                <div data-stream-error className="absolute inset-0 z-10 flex items-center justify-center bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08),rgba(0,0,0,0.55)_62%)] px-6 text-center">
                  <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-white/10 bg-black/45 px-6 py-5 text-white/75 shadow-2xl backdrop-blur-md">
                    <X className="h-7 w-7 text-white/70" />
                    <p className="text-sm font-medium text-white">{panelTitle}</p>
                    {panelDetail ? <p className="text-[12px] text-white/60">{panelDetail}</p> : null}
                    {mediaErrorDiagnostic ? (
                      <details
                        className="max-w-full text-left text-[11px] text-white/55"
                        data-stream-error-details
                      >
                        <summary className="cursor-pointer text-center font-medium text-white/70">
                          Details
                        </summary>
                        <p className="mt-1 break-words font-mono">
                          {mediaErrorDiagnostic}
                        </p>
                      </details>
                    ) : null}
                    <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                      {failureCopy?.affordance === "retry" ? (
                        <button
                          type="button"
                          data-stream-retry
                          disabled={retrying}
                          onClick={() => {
                            void retrySameRelease();
                            showTheatreControls();
                          }}
                          className="inline-flex h-9 items-center rounded-full bg-white px-4 text-[12px] font-semibold text-black transition hover:bg-white/90 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                        >
                          {retrying ? "Retrying…" : "Retry"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : showLoader ? (
                // COMPLAINTS 1 & 2: exactly one loader for the union
                // of every "getting there" moment (no source yet ∪ preparing ∪
                // checking ∪ buffering ∪ seeking ∪ switching release), rendered
                // once over the persistent stage. All three probe selectors live
                // on the spinner node so a union count is 1; the copy is a short
                // evidence-based status line, not a second loader.
                <StreamLoader status={loaderStatus} />
              ) : null}

              <div
                className={cn(
                  "pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/80 via-black/30 to-transparent p-3 pt-14 transition-opacity duration-200 sm:p-5",
                  controlsOpacity,
                )}
              >
                <div className="pointer-events-auto flex items-start justify-between gap-4">
                  <PlayerIdentity
                    showTitle={displayTitle}
                    episodeTitle={activeEpisodeTitle}
                    season={currentSeason}
                    episode={currentEpisode}
                  />
                </div>
              </div>

              <div
                className={cn(
                  "absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/65 to-transparent px-3 pb-3 pt-14 transition-opacity duration-200 sm:px-5 sm:pb-4 sm:pt-24",
                  controlsOpacity,
                  controlsPointerEvents,
                  "focus-within:opacity-100",
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
                          {upNextError
                            ? upNextError
                            : canAutoAdvanceToUpNext(upNext, autoAdvanceCancelled)
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
                          {upNextLoading && playbackStarted ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                          {upNextError ? "Try again" : upNextUnavailableActionLabel()}
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

                <div className="mt-3 flex min-h-6 flex-col items-start gap-1 text-[11px] text-white/55">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate">
                      {[selectedAudioSummary, subtitleTrackId ? "Subtitles on" : "Subtitles off"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  {subtitleStatusMessage ? (
                    <p data-stream-subtitle-status={subtitleStatus} className="max-w-full text-white/70">
                      {subtitleStatusMessage}
                    </p>
                  ) : null}
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
      data-playback-started={playbackStarted ? "true" : "false"}
      data-player-chrome={chrome}
      data-playback-mode={playbackMode}
      data-playback-strategy={strategy ?? undefined}
        data-plan-source={planSource ?? undefined}
      data-playback-rung={playbackRung ?? undefined}
      data-strategy-reason={strategyReason ?? undefined}
      data-resume-sec={resumeTargetSec > 0 ? resumeTargetSec : undefined}
      data-dropped-video-frames={playbackQuality.droppedVideoFrames}
      data-total-video-frames={playbackQuality.totalVideoFrames}
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



          {/* Always-mounted surface + stage while the player is expanded. The
              <video> is a conditional CHILD and the single StreamLoader a fixed
              sibling, so the ONE loader keeps its DOM identity across the entire
              journey — including the playableSrc null→set transition — and never
              restarts or hands off to a second spinner (COMPLAINT 1). */}
            <div
              ref={fullscreenSurfaceRef}
              data-player-fullscreen-surface
              className={cn("space-y-1.5", theatre && "flex h-full min-h-0 flex-col gap-2")}
            >
              <div
                data-stream-stage
                className={cn(
                  // Reserve the frame before a source exists so the loader has a
                  // stable box and the layout never shifts (CLS-safe).
                  "relative min-h-[160px] overflow-hidden rounded-md bg-black",
                  theatre &&
                    "mx-auto flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black shadow-[0_24px_80px_rgba(0,0,0,0.55)]",
                )}
              >
              {playableSrc && selectedFile
                ? renderStreamVideo({ className: "w-full rounded-md bg-black" })
                : null}
              {showLoader ? <StreamLoader className="rounded-md" status={loaderStatus} /> : null}
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
                    {upNextError ? upNextError : upNextStatusSentence(upNext.availability)}
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
                      // Was `disabled` with no handler: at the one moment the
                      // viewer most wants to move on, the only control on the
                      // card did nothing and looked like it never would.
                      <button
                        type="button"
                        onClick={() => void fetchUpNext()}
                        disabled={upNextLoading}
                        className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-[12px] font-semibold text-black disabled:cursor-wait disabled:opacity-60"
                      >
                        {upNextLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5 fill-current" />
                        )}
                        {upNextError ? "Try again" : upNextUnavailableActionLabel()}
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
              {/* Controls, timeline and status live BELOW the stage and exist
                  only once a real source does. The stage above stays mounted
                  regardless, so toggling these never disturbs the one loader. */}
              {playableSrc && selectedFile && activeInfoHash ? (
                <>
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
                </div>
              ) : null}
              {unifiedControlBar("inline")}
              {subtitleStatusMessage ? (
                <p
                  data-stream-subtitle-status={subtitleStatus}
                  className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]"
                >
                  {subtitleStatus === "extracting" || subtitleStatus === "loading" ? (
                    <span className="h-2 w-2 rounded-full bg-current opacity-70" aria-hidden="true" />
                  ) : null}
                  {subtitleStatusMessage}
                </p>
              ) : null}
              <div
                className={cn(
                  "flex flex-wrap items-center gap-2",
                  theatre &&
                    "mx-auto w-full max-w-6xl justify-between rounded-xl border border-white/10 bg-black/45 px-3 py-2 text-white/70",
                )}
              >
                {upNext ? (
                  <div
                    data-up-next-status
                    className={cn(
                      "flex min-w-0 items-center gap-2 text-[11px] text-[var(--text-tertiary)]",
                      theatre && "text-white/70",
                    )}
                  >
                    <span className="min-w-0 truncate">
                      {upNextError
                        ? upNextError
                        : `Next: ${upNext.title} ${upNext.label} — ${upNextStatusSentence(upNext.availability)}`}
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
                        {upNextLoading && playbackStarted ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        {upNextError ? "Try again" : "Fetch next"}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
                </>
              ) : null}
            </div>
        </div>
      ) : null}
    </div>
  );
}
