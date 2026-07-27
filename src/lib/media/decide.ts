/**
 * Playback decision engine — pure function, no I/O.
 *
 * Given a probe result and client capabilities, choose the cheapest playback
 * rung that will actually work in the requesting browser:
 *
 *   direct          → container + codecs all native. Zero CPU.
 *   remux           → codecs fine, container wrong (MKV→fMP4). ~0 CPU.
 *   transcode-audio → video fine, audio unsupported (DTS/TrueHD). Copy video.
 *   transcode-full  → video codec unsupported. Full re-encode.
 *
 * This is the single source of truth for "will it play?" The answer must be
 * deterministic and never guess — it uses only what the client reported and
 * what ffprobe found.
 */
import type { ProbeResult, ProbeStream } from "./probe-shape";
import {
  videoStream,
  normalizeContainer,
  audioStreams,
} from "./probe-shape";
import type { ClientCapabilities } from "./capabilities";
import {
  supportsContainer,
  canDecodeViaMSE,
  supportsCodecTag,
  fmp4Mime,
  videoCodecTag,
  audioCodecTag,
} from "./capabilities";

export type PlaybackRung = "direct" | "remux" | "transcode-audio" | "transcode-full";

export type AudioPlan = {
  /** Stream index from the probe */
  streamIndex: number;
  /** Source codec, so the UI can label the track (AC-3 5.1, DTS 5.1, …) */
  codec: string;
  /** What to do with this stream */
  action: "copy" | "transcode";
  /** Target codec when transcoding (eac3, aac) */
  targetCodec?: string;
  /** Preserve channel count from probe */
  channels: number;
  language: string | null;
  title: string | null;
};

export type PlaybackPlan = {
  rung: PlaybackRung;
  /** Why this rung was chosen — useful for UI and debugging */
  reason: string;
  /**
   * Video handling. Null only when there is no video stream
   * (audio-only file or corrupt probe).
   */
  video: {
    codec: string;
    /** ffprobe stream index, needed to build an explicit ffmpeg -map */
    streamIndex: number;
    action: "copy" | "transcode";
    /** Target codec when transcoding */
    targetCodec?: string;
    /** Use hardware encoder when available */
    hwAccel?: string;
    /** RFC 6381 tag the browser was asked about, for diagnostics */
    codecTag?: string;
  } | null;
  /**
   * Plan for *every* audio stream in the file. This is the track list the UI
   * offers; only `selectedAudioIndex` is actually muxed (see below).
   */
  audio: AudioPlan[];
  /**
   * ffprobe stream index of the one audio track the ffmpeg session will mux.
   *
   * A single fMP4/HLS variant can only carry one audio track that MSE will
   * reliably expose — muxing several produces a segment most browsers decode
   * only the first track of, silently. So the ladder commits to one track and
   * switching language restarts the session against a different index.
   */
  selectedAudioIndex: number | null;
  /** The normalized container from the probe */
  container: string;
  /** Estimated relative CPU cost: 0 = none, 1 = copy, 2 = audio encode, 3 = full encode */
  cost: number;
};

/** Options that steer the decision without changing the file. */
export type DecideOptions = {
  /** ffprobe stream index of the audio track the viewer picked. */
  audioStreamIndex?: number | null;
};

// ── Video codec support checks ──

/**
 * Video codecs a modern browser can decode in an fMP4 container. Anything not
 * in this set needs a full re-encode — this is the rule, not a list of known
 * bad codecs, so an unrecognised codec fails safe into transcode rather than
 * into a black screen.
 */
const BROWSER_VIDEO_CODECS = new Set(["h264", "hevc", "av1", "vp9", "vp8"]);

function isVideoSupportedInFmp4(
  codec: string,
  profile: string | null,
  caps: ClientCapabilities,
): boolean {
  if (!BROWSER_VIDEO_CODECS.has(codec.toLowerCase())) return false;
  return supportsCodecTag(caps, videoCodecTag(codec, profile));
}

// ── Audio codec support checks ──

/** Audio codecs known to be browser-safe in fMP4. */
const BROWSER_AUDIO_CODECS = new Set(["aac", "opus", "flac", "mp3", "vorbis"]);

/** Audio codecs that need transcoding (no browser decodes these). */
const UNSUPPORTED_AUDIO_CODECS = new Set(["dts", "truehd", "pcm", "mp2"]);

/**
 * Audio codecs that are supported by some browsers (Chromium on Windows
 * decodes AC-3 and E-AC-3 via the OS codec pipeline).
 */
function isAudioSupportedInFmp4(codec: string, caps: ClientCapabilities): boolean {
  const lc = codec.toLowerCase();
  // Never safe in an fMP4 no matter what the client claims — no browser ships
  // a DTS/TrueHD/PCM decoder, and mp2 has no fMP4 sample entry.
  if (UNSUPPORTED_AUDIO_CODECS.has(lc)) return false;
  // Universally safe.
  if (BROWSER_AUDIO_CODECS.has(lc)) return true;
  // Everything else — including AC-3/E-AC-3, which Chromium on Windows decodes
  // through the OS — is a question for the client, asked per codec tag so the
  // answer doesn't depend on which video codec it happened to be probed with.
  return supportsCodecTag(caps, audioCodecTag(lc));
}

/**
 * Choose the audio transcode target that preserves the channel count.
 * Prefer eac3 (Dolby Digital Plus) for multichannel since it is browser-native
 * on Windows Edge/Chromium and a Dolby codec. Fall back to multichannel AAC.
 */
function chooseAudioTarget(channels: number, caps: ClientCapabilities): string {
  if (channels <= 2) return "aac";
  // Multichannel: E-AC-3 keeps every channel and is browser-native on Windows
  // Edge/Chromium. Multichannel AAC is the fallback — still never a downmix.
  return supportsCodecTag(caps, "ec-3") ? "eac3" : "aac";
}

// ── Direct-play container check ──

/**
 * Can the file be served directly (no processing) via the existing byte-range
 * stream route? The container must be natively playable AND all codecs must be
 * browser-decodable.
 */
function canDirectPlay(
  container: string,
  video: ProbeStream | null,
  audio: ProbeStream | null,
  caps: ClientCapabilities,
): boolean {
  // Container must be natively supported (MP4/WebM — not MKV, not TS)
  if (!supportsContainer(caps, container)) return false;
  // Video codec must be supported
  if (video && !isVideoSupportedInFmp4(video.codec, video.profile, caps)) return false;
  // Audio codec must be supported
  if (audio && !isAudioSupportedInFmp4(audio.codec, caps)) return false;
  return true;
}

/**
 * Pick the audio track to mux. An explicit viewer choice wins; otherwise the
 * first audio stream, which is what every muxer marks as the default track.
 */
function selectAudio(
  streams: ProbeStream[],
  requested: number | null | undefined,
): ProbeStream | null {
  if (streams.length === 0) return null;
  if (typeof requested === "number") {
    const match = streams.find((s) => s.index === requested);
    if (match) return match;
  }
  return streams[0];
}

// ── The decision ──

export function decidePlayback(
  probe: ProbeResult,
  caps: ClientCapabilities,
  options: DecideOptions = {},
): PlaybackPlan {
  const container = normalizeContainer(probe.container);
  const video = videoStream(probe);
  const allAudio = audioStreams(probe);
  const audio = selectAudio(allAudio, options.audioStreamIndex);
  const selectedAudioIndex = audio?.index ?? null;

  // No video stream at all — audio-only or corrupt
  if (!video) {
    // For audio-only files with a compatible codec, direct play
    if (audio && supportsContainer(caps, container) && isAudioSupportedInFmp4(audio.codec, caps)) {
      return {
        rung: "direct",
        reason: "Audio-only file, container and codec compatible",
        video: null,
        audio: buildAudioPlans(allAudio, caps, "copy"),
        selectedAudioIndex,
        container,
        cost: 0,
      };
    }
    // Audio needs remux or transcode
    return {
      rung: audio ? "remux" : "direct",
      reason: audio ? "Audio-only file needs remux" : "No playable streams found",
      video: null,
      audio: audio ? buildAudioPlans(allAudio, caps, "auto") : [],
      selectedAudioIndex,
      container,
      cost: audio ? 1 : 0,
    };
  }

  const codecTag = videoCodecTag(video.codec, video.profile);

  // ── Rung 1: Direct play ──
  if (canDirectPlay(container, video, audio, caps)) {
    return {
      rung: "direct",
      reason: `Container ${container} and all codecs natively supported`,
      video: { codec: video.codec, streamIndex: video.index, action: "copy", codecTag },
      audio: buildAudioPlans(allAudio, caps, "copy"),
      selectedAudioIndex,
      container,
      cost: 0,
    };
  }

  const videoSupportedInFmp4 = isVideoSupportedInFmp4(video.codec, video.profile, caps);
  const audioSupportedInFmp4 = audio ? isAudioSupportedInFmp4(audio.codec, caps) : true;

  // ── Rung 2: Remux (codec copy, container change) ──
  if (videoSupportedInFmp4 && audioSupportedInFmp4) {
    return {
      rung: "remux",
      reason:
        `Codecs supported but container ${container} is not — remux to fMP4 ` +
        `(${fmp4Mime(video.codec, audio?.codec ?? null, video.profile)})`,
      video: { codec: video.codec, streamIndex: video.index, action: "copy", codecTag },
      audio: buildAudioPlans(allAudio, caps, "copy"),
      selectedAudioIndex,
      container,
      cost: 1,
    };
  }

  // ── Rung 3: Transcode audio only ──
  if (videoSupportedInFmp4 && !audioSupportedInFmp4) {
    return {
      rung: "transcode-audio",
      reason: `Video ${video.codec} supported, audio ${audio?.codec ?? "none"} needs transcoding`,
      video: { codec: video.codec, streamIndex: video.index, action: "copy", codecTag },
      audio: buildAudioPlans(allAudio, caps, "auto"),
      selectedAudioIndex,
      container,
      cost: 2,
    };
  }

  // ── Rung 4: Full transcode ──
  return {
    rung: "transcode-full",
    reason: `Video codec ${video.codec}${video.profile ? ` (${video.profile})` : ""} unsupported — full transcode required`,
    video: {
      codec: video.codec,
      streamIndex: video.index,
      action: "transcode",
      targetCodec: "h264",
      hwAccel: "h264_amf",
      codecTag,
    },
    audio: buildAudioPlans(allAudio, caps, "auto"),
    selectedAudioIndex,
    container,
    cost: 3,
  };
}

// ── Audio plan builder ──

function buildAudioPlans(
  streams: ProbeStream[],
  caps: ClientCapabilities,
  mode: "copy" | "auto",
): AudioPlan[] {
  return streams.map((s) => {
    const channels = s.channels ?? 2;
    const supported = isAudioSupportedInFmp4(s.codec, caps);

    if (mode === "copy" || supported) {
      return {
        streamIndex: s.index,
        codec: s.codec,
        action: "copy" as const,
        channels,
        language: s.language,
        title: s.title,
      };
    }

    const targetCodec = chooseAudioTarget(channels, caps);
    return {
      streamIndex: s.index,
      codec: s.codec,
      action: "transcode" as const,
      targetCodec,
      channels,
      language: s.language,
      title: s.title,
    };
  });
}
