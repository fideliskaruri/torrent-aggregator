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
import { embeddedSubtitleTracks } from "./subtitles";

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
  /**
   * Default subtitle decision. Drives whether the player auto-enables a subtitle
   * track on load — the fix for an English viewer landing on foreign audio with
   * subtitles silently Off. Always populated by `decidePlayback`; optional so
   * existing plan fixtures that predate it keep type-checking.
   */
  subtitle?: SubtitleDecision;
};

/**
 * A subtitle track the decision engine may auto-select. Both embedded streams
 * and sidecar/fetched files reduce to this shape so the choice is one pure
 * function regardless of source.
 */
export type SubtitleCandidate = {
  /** Stable id the content endpoint understands (`embedded:2` / `sidecar:<path>`). */
  id: string;
  /** ISO code as found (any spelling); normalized internally. */
  language: string | null;
  /** Forced tracks carry only foreign-dialogue lines, not the full script. */
  forced: boolean;
  /** False for anything that cannot render (image-based, unconvertible). */
  supported: boolean;
};

/**
 * What the player should do about subtitles by default.
 *
 * The rule: English audio → leave subtitles Off (nothing to translate). Foreign
 * audio → auto-enable an English subtitle if one exists. When no English audio
 * *and* no English subtitle exists, `noEnglishAvailable` is set so the UI can
 * say so out loud instead of sitting on a silent "Off".
 */
export type SubtitleDecision = {
  /** Track id to auto-enable, or null when subtitles should stay Off. */
  defaultTrackId: string | null;
  /** The selected audio track is English, so subtitles are not needed. */
  audioIsEnglish: boolean;
  /** At least one usable English subtitle (embedded or sidecar) exists. */
  englishSubtitleAvailable: boolean;
  /** No English audio and no usable English subtitle — surface this to the user. */
  noEnglishAvailable: boolean;
  /** The only English subtitle available is a forced (foreign-parts-only) track. */
  forcedFallback: boolean;
  /** Short human-readable explanation, for UI and debugging. */
  reason: string;
};

/** Options that steer the decision without changing the file. */
export type DecideOptions = {
  /** ffprobe stream index of the audio track the viewer picked. */
  audioStreamIndex?: number | null;
  /** Preferred audio language tag. Defaults to English until settings expose it. */
  preferredAudioLanguage?: string | null;
  /**
   * Subtitle tracks that live outside the probe — sidecar files inside the
   * torrent, or fetched subtitles. Considered *alongside* the embedded subtitle
   * streams the probe already carries when choosing a default.
   */
  subtitleCandidates?: SubtitleCandidate[];
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
const BROWSER_AUDIO_CODECS = new Set(["aac", "opus", "flac", "vorbis"]);

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

export type AudioSelectionPrefs = {
  /** ffprobe stream index picked by the viewer; always wins. */
  audioStreamIndex?: number | null;
  /** User language preference; falls back to English when absent. */
  preferredLanguage?: string | null;
};

const LANGUAGE_ALIASES: Record<string, string> = {
  eng: "en",
  fre: "fr",
  fra: "fr",
  ger: "de",
  deu: "de",
  dut: "nl",
  nld: "nl",
  gre: "el",
  ell: "el",
  alb: "sq",
  sqi: "sq",
  arm: "hy",
  hye: "hy",
  baq: "eu",
  eus: "eu",
  cze: "cs",
  ces: "cs",
  chi: "zh",
  zho: "zh",
  ice: "is",
  isl: "is",
  mac: "mk",
  mkd: "mk",
  mao: "mi",
  mri: "mi",
  may: "ms",
  msa: "ms",
  per: "fa",
  fas: "fa",
  rum: "ro",
  ron: "ro",
  slo: "sk",
  slk: "sk",
  tib: "bo",
  bod: "bo",
  wel: "cy",
  cym: "cy",
  jpn: "ja",
  spa: "es",
  ita: "it",
  por: "pt",
  rus: "ru",
  kor: "ko",
  ara: "ar",
  hin: "hi",
};

function normalizedLanguage(tag: string | null | undefined): string | null {
  const raw = tag?.trim().toLowerCase();
  if (!raw || raw === "und") return null;
  const primary = raw.split(/[-_]/)[0];
  if (!primary || primary === "und") return null;
  return LANGUAGE_ALIASES[primary] ?? primary;
}

function isCommentaryTrack(stream: ProbeStream): boolean {
  return /commentary|director/i.test(stream.title ?? "");
}

function bestLanguageMatch(streams: ProbeStream[]): ProbeStream {
  return streams
    .map((stream, order) => ({ stream, order }))
    .sort((a, b) => {
      const channels = (b.stream.channels ?? 0) - (a.stream.channels ?? 0);
      if (channels !== 0) return channels;
      const defaults =
        Number(Boolean(b.stream.dispositionDefault)) -
        Number(Boolean(a.stream.dispositionDefault));
      if (defaults !== 0) return defaults;
      return a.order - b.order;
    })[0].stream;
}

/**
 * Pick the audio track to mux.
 *
 * Order: explicit stream index → user language → English → default disposition
 * → first non-commentary track. Commentary/director tracks remain in the plan
 * for manual selection, but are not auto-selected while a non-commentary option
 * exists.
 */
export function selectPreferredAudioStream(
  streams: ProbeStream[],
  prefs: AudioSelectionPrefs = {},
): ProbeStream | null {
  if (streams.length === 0) return null;
  if (typeof prefs.audioStreamIndex === "number") {
    const match = streams.find((s) => s.index === prefs.audioStreamIndex);
    if (match) return match;
  }

  const nonCommentary = streams.filter((s) => !isCommentaryTrack(s));
  const auto = nonCommentary.length > 0 ? nonCommentary : streams;
  const preferred = normalizedLanguage(prefs.preferredLanguage);
  const languageOrder = [...new Set([preferred, "en"].filter(Boolean))] as string[];

  for (const language of languageOrder) {
    const matches = auto.filter((s) => normalizedLanguage(s.language) === language);
    if (matches.length > 0) return bestLanguageMatch(matches);
  }

  const defaults = auto.filter((s) => s.dispositionDefault);
  if (defaults.length > 0) return bestLanguageMatch(defaults);

  return auto[0];
}

/** True when a language tag resolves to English. */
export function isEnglishLanguage(tag: string | null | undefined): boolean {
  return normalizedLanguage(tag) === "en";
}

/**
 * Turn the probe's embedded subtitle streams into auto-select candidates. Reuses
 * the same track-building rules the subtitles endpoint uses, so an id chosen here
 * (`embedded:<index>`) is exactly the id the player receives in its track list.
 */
export function subtitleCandidatesFromProbe(streams: ProbeStream[]): SubtitleCandidate[] {
  return embeddedSubtitleTracks(streams).map((t) => ({
    id: t.id,
    language: t.language,
    forced: t.forced,
    supported: t.supported,
  }));
}

/**
 * Choose the subtitle track to auto-enable.
 *
 * The bug this fixes: an English viewer opened a file with Japanese audio and
 * French-only subtitles and was left on "Off". The rule now:
 *
 *  - English audio → no default subtitle (nothing to translate).
 *  - Foreign audio → the first usable *English* subtitle. Full (non-forced)
 *    English is preferred; a forced English track is used only when it is the
 *    only English option (`forcedFallback`).
 *  - Foreign audio with no English subtitle at all → nothing is auto-selected,
 *    but `noEnglishAvailable` is set so the UI states it plainly rather than
 *    sitting on a silent "Off". A non-English subtitle is never auto-forced on
 *    an English viewer.
 *
 * `candidates` are considered in order, so the caller controls tie-breaking
 * (e.g. sidecars before embedded) simply by ordering the list.
 */
export function selectDefaultSubtitle(
  audioLanguage: string | null | undefined,
  candidates: SubtitleCandidate[],
): SubtitleDecision {
  const audioIsEnglish = isEnglishLanguage(audioLanguage);
  const englishSubs = candidates.filter((c) => c.supported && isEnglishLanguage(c.language));
  const englishSubtitleAvailable = englishSubs.length > 0;

  if (audioIsEnglish) {
    return {
      defaultTrackId: null,
      audioIsEnglish: true,
      englishSubtitleAvailable,
      noEnglishAvailable: false,
      forcedFallback: false,
      reason: "Audio is English — subtitles off by default",
    };
  }

  if (!englishSubtitleAvailable) {
    return {
      defaultTrackId: null,
      audioIsEnglish: false,
      englishSubtitleAvailable: false,
      noEnglishAvailable: true,
      forcedFallback: false,
      reason: "No English audio and no English subtitles available",
    };
  }

  const full = englishSubs.find((c) => !c.forced);
  const chosen = full ?? englishSubs[0];
  const forcedFallback = !full;
  return {
    defaultTrackId: chosen.id,
    audioIsEnglish: false,
    englishSubtitleAvailable: true,
    noEnglishAvailable: false,
    forcedFallback,
    reason: forcedFallback
      ? "Non-English audio — defaulting to the only English subtitle (forced)"
      : "Non-English audio — defaulting to English subtitles",
  };
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
  const audio = selectPreferredAudioStream(allAudio, {
    audioStreamIndex: options.audioStreamIndex,
    preferredLanguage: options.preferredAudioLanguage,
  });
  const selectedAudioIndex = audio?.index ?? null;

  // Default-subtitle decision (the English-viewer fix). Embedded subtitle
  // streams come from the probe; any sidecar/fetched candidates are supplied by
  // the caller and considered first so they win ties.
  const subtitle = selectDefaultSubtitle(audio?.language ?? null, [
    ...(options.subtitleCandidates ?? []),
    ...subtitleCandidatesFromProbe(probe.streams),
  ]);

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
        subtitle,
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
      subtitle,
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
      subtitle,
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
      subtitle,
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
      subtitle,
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
    subtitle,
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
