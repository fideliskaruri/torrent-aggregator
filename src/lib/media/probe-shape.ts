// Pure probe-shape helpers only: a pure helper must not live in the module that owns a binary or subprocess,
// because importing the helper drags the launcher into every bundle that touches it.

/** Typed probe result — everything the playback decision needs. */
export type ProbeStream = {
  index: number;
  codecType: "video" | "audio" | "subtitle" | "data" | string;
  codec: string;
  profile: string | null;
  /** Raw ffprobe pix_fmt, e.g. yuv420p / yuv420p10le. Drives 10-bit detection. */
  pixFmt: string | null;
  width: number | null;
  height: number | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  channels: number | null;
  channelLayout: string | null;
  language: string | null;
  title: string | null;
  bitRate: number | null;
  sampleRate: number | null;
};

export type ProbeResult = {
  container: string;
  duration: number | null;
  streams: ProbeStream[];
};

export type ProbeError = {
  error: "timeout" | "not_ready" | "probe_failed" | "no_streams";
  message: string;
};

export type ProbeOutcome = { ok: true; result: ProbeResult } | { ok: false; error: ProbeError };

type FfprobeJson = {
  format?: {
    format_name?: string;
    duration?: string;
  };
  streams?: Array<Record<string, unknown>>;
};

/** Parse raw ffprobe JSON output into our ProbeResult. */
export function parseProbeOutput(stdout: string): ProbeOutcome {
  let data: FfprobeJson;
  try {
    data = JSON.parse(stdout) as FfprobeJson;
  } catch {
    return { ok: false, error: { error: "probe_failed", message: "Invalid JSON from ffprobe" } };
  }

  const rawStreams = data.streams;
  if (!rawStreams || rawStreams.length === 0) {
    return { ok: false, error: { error: "no_streams", message: "No streams found in file" } };
  }

  const container = data.format?.format_name ?? "unknown";
  const durationStr = data.format?.duration;
  const duration = durationStr ? parseFloat(durationStr) : null;

  const streams: ProbeStream[] = rawStreams.map((s, i) => ({
    index: typeof s.index === "number" ? s.index : i,
    codecType: normalizeCodecType(String(s.codec_type ?? "data")),
    codec: normalizeCodecName(String(s.codec_name ?? "unknown")),
    profile: s.profile ? String(s.profile) : null,
    pixFmt: s.pix_fmt ? String(s.pix_fmt) : null,
    width: typeof s.width === "number" ? s.width : null,
    height: typeof s.height === "number" ? s.height : null,
    colorTransfer: s.color_transfer ? String(s.color_transfer) : null,
    colorPrimaries: s.color_primaries ? String(s.color_primaries) : null,
    channels: typeof s.channels === "number" ? s.channels : null,
    channelLayout: s.channel_layout ? String(s.channel_layout) : null,
    language: extractTag(s, "language"),
    title: extractTag(s, "title"),
    bitRate: typeof s.bit_rate === "string" ? parseInt(s.bit_rate, 10) || null : null,
    sampleRate: typeof s.sample_rate === "string" ? parseInt(s.sample_rate, 10) || null : null,
  }));

  return { ok: true, result: { container, duration: Number.isFinite(duration) ? duration : null, streams } };
}

function extractTag(stream: Record<string, unknown>, key: string): string | null {
  const tags = stream.tags as Record<string, unknown> | undefined;
  if (!tags) return null;
  const val = tags[key] ?? tags[key.toUpperCase()];
  return val ? String(val) : null;
}

function normalizeCodecType(raw: string): ProbeStream["codecType"] {
  const lc = raw.toLowerCase();
  if (lc === "video") return "video";
  if (lc === "audio") return "audio";
  if (lc === "subtitle") return "subtitle";
  return lc;
}

/** Normalize ffprobe codec names to the short forms the decision engine uses. */
export function normalizeCodecName(raw: string): string {
  const lc = raw.toLowerCase();
  const map: Record<string, string> = {
    h264: "h264",
    avc: "h264",
    avc1: "h264",
    hevc: "hevc",
    h265: "hevc",
    hvc1: "hevc",
    hev1: "hevc",
    av1: "av1",
    vp9: "vp9",
    vp8: "vp8",
    mpeg2video: "mpeg2",
    mpeg1video: "mpeg1",
    vc1: "vc1",
    wmv3: "wmv3",
    aac: "aac",
    ac3: "ac3",
    "ac-3": "ac3",
    eac3: "eac3",
    "e-ac-3": "eac3",
    "ec-3": "eac3",
    dts: "dts",
    dca: "dts",
    truehd: "truehd",
    mlp: "truehd",
    opus: "opus",
    vorbis: "vorbis",
    flac: "flac",
    pcm_s16le: "pcm",
    pcm_s24le: "pcm",
    pcm_s32le: "pcm",
    pcm_bluray: "pcm",
    pcm_dvd: "pcm",
    mp3: "mp3",
    mp2: "mp2",
  };
  return map[lc] ?? lc;
}

// ── Convenience helpers for the decision engine ──

export function videoStream(probe: ProbeResult): ProbeStream | null {
  return probe.streams.find((s) => s.codecType === "video") ?? null;
}

export function audioStreams(probe: ProbeResult): ProbeStream[] {
  return probe.streams.filter((s) => s.codecType === "audio");
}

export function primaryAudioStream(probe: ProbeResult): ProbeStream | null {
  const audio = audioStreams(probe);
  return audio.length > 0 ? audio[0] : null;
}

/** True when color_transfer indicates HDR (HDR10 / HLG / Dolby Vision). */
export function isHDR(stream: ProbeStream): boolean {
  const ct = stream.colorTransfer?.toLowerCase();
  if (!ct) return false;
  return ct === "smpte2084" || ct === "arib-std-b67" || ct.includes("dolby");
}

// ── Container normalization ──

/** Normalize ffprobe's format_name to a canonical container name. */
export function normalizeContainer(formatName: string): string {
  const lc = formatName.toLowerCase();
  // ffprobe reports "matroska,webm" for both .mkv and .webm files.
  // Pure "webm" (e.g. VP9+Opus WebM) stays as "webm" for direct play.
  if (lc === "webm") return "webm";
  if (lc.includes("matroska") || lc.includes("webm")) return "matroska";
  if (lc.includes("mp4") || lc === "mov" || lc.includes("m4a") || lc.includes("m4v")) {
    return "mp4";
  }
  if (lc.includes("mpegts") || lc === "ts") return "mpegts";
  if (lc.includes("avi")) return "avi";
  if (lc.includes("wmv") || lc.includes("asf")) return "asf";
  if (lc.includes("ogg")) return "ogg";
  return lc;
}


export type CachedProbe = {
  infoHash: string;
  filePath: string;
  result: ProbeResult;
};
