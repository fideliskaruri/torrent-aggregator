/**
 * Subtitle discovery and conversion.
 *
 * Two sources, deliberately in this order:
 *
 * 1. **Embedded streams** found by the probe we already run for the playback
 *    ladder. No API key, no third-party account, no network round trip.
 * 2. **Sidecar files inside the torrent** (`.srt`/`.vtt`/`.ass`), which scene
 *    releases ship constantly and which cost a few hundred KB to read.
 *
 * Two rules are load-bearing:
 *
 * - **A `<track>` element only ever accepts WebVTT.** Anything else is handed
 *   to the browser and silently produces no cues, which looks exactly like
 *   "this release has no subtitles". Everything is converted before it is
 *   served.
 * - **Image-based subtitles cannot become WebVTT.** ffmpeg refuses outright
 *   ("Subtitle encoding currently only possible from text to text or bitmap to
 *   bitmap"), so `hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle` and `xsub`
 *   are listed as *unsupported* rather than offered as a track that can never
 *   render. Offering them would be the same class of lie as a buffer band that
 *   does not match the buffer.
 */
import type { ProbeStream } from "./probe-shape";

/** Text subtitle codecs ffmpeg can transcode into WebVTT. */
const TEXT_SUBTITLE_CODECS = new Set([
  "subrip",
  "srt",
  "webvtt",
  "vtt",
  "ass",
  "ssa",
  "mov_text",
  "text",
  "subviewer",
  "subviewer1",
  "microdvd",
  "mpl2",
  "jacosub",
  "sami",
  "realtext",
  "stl",
  "pjs",
  "vplayer",
]);

/**
 * Bitmap subtitle codecs. These are pictures, not text: there is no conversion
 * to WebVTT, only OCR, which this app does not do.
 */
const IMAGE_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "pgssub",
  "pgs",
  "dvd_subtitle",
  "dvdsub",
  "dvb_subtitle",
  "dvbsub",
  "dvb_teletext",
  "xsub",
  "vobsub",
]);

export type SubtitleCodecKind = "text" | "image" | "unknown";

/** Classify a raw ffprobe subtitle codec name. */
export function classifySubtitleCodec(codec: string): SubtitleCodecKind {
  const lc = codec.trim().toLowerCase();
  if (TEXT_SUBTITLE_CODECS.has(lc)) return "text";
  if (IMAGE_SUBTITLE_CODECS.has(lc)) return "image";
  return "unknown";
}

/** File extensions we will read as a sidecar subtitle. */
const SIDECAR_EXTENSIONS = new Set([".vtt", ".srt", ".ass", ".ssa"]);

/** Directory names that conventionally hold a release's subtitle files. */
const SUBTITLE_DIR_NAMES = new Set(["subs", "subtitles", "subtitle", "sub"]);

export type SubtitleTrackKind = "embedded" | "sidecar";

export type SubtitleTrack = {
  /** Stable id the content endpoint understands: `embedded:2` / `sidecar:<path>`. */
  id: string;
  kind: SubtitleTrackKind;
  /** What the picker shows. */
  label: string;
  /** ISO code as found, lowercased. `null` when the source said nothing. */
  language: string | null;
  /** Raw codec (embedded) or extension without the dot (sidecar). */
  codec: string;
  /** False for anything that cannot become WebVTT. Such a track has no `src`. */
  supported: boolean;
  /** Why it is unsupported, in words a viewer can act on. `null` when supported. */
  unsupportedReason: string | null;
  /** ffprobe stream index. `null` for sidecars. */
  streamIndex: number | null;
  /** Path inside the torrent. `null` for embedded tracks. */
  filePath: string | null;
  /**
   * True when serving this track means demuxing the whole video file. Embedded
   * subtitles are interleaved through the container, so there is no cheap read
   * — which is exactly why nothing is extracted until a viewer asks for it.
   */
  needsExtraction: boolean;
  /** Marked "forced" (only foreign dialogue) by its name or disposition. */
  forced: boolean;
  /** Marked SDH / hearing-impaired by its name or title. */
  hearingImpaired: boolean;
};

// ── Language naming ──

/**
 * The languages that actually appear on releases, by both ISO-639-1 and
 * ISO-639-2 codes. A miss falls back to the code in upper case, which is honest
 * and still selectable — never to a guess.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", eng: "English",
  es: "Spanish", spa: "Spanish", esp: "Spanish",
  fr: "French", fra: "French", fre: "French",
  de: "German", deu: "German", ger: "German",
  it: "Italian", ita: "Italian",
  pt: "Portuguese", por: "Portuguese",
  nl: "Dutch", nld: "Dutch", dut: "Dutch",
  sv: "Swedish", swe: "Swedish",
  no: "Norwegian", nor: "Norwegian",
  da: "Danish", dan: "Danish",
  fi: "Finnish", fin: "Finnish",
  is: "Icelandic", isl: "Icelandic",
  pl: "Polish", pol: "Polish",
  cs: "Czech", ces: "Czech", cze: "Czech",
  sk: "Slovak", slk: "Slovak", slo: "Slovak",
  hu: "Hungarian", hun: "Hungarian",
  ro: "Romanian", ron: "Romanian", rum: "Romanian",
  bg: "Bulgarian", bul: "Bulgarian",
  el: "Greek", ell: "Greek", gre: "Greek",
  ru: "Russian", rus: "Russian",
  uk: "Ukrainian", ukr: "Ukrainian",
  tr: "Turkish", tur: "Turkish",
  ar: "Arabic", ara: "Arabic",
  he: "Hebrew", heb: "Hebrew",
  fa: "Persian", fas: "Persian", per: "Persian",
  hi: "Hindi", hin: "Hindi",
  ta: "Tamil", tam: "Tamil",
  te: "Telugu", tel: "Telugu",
  th: "Thai", tha: "Thai",
  vi: "Vietnamese", vie: "Vietnamese",
  id: "Indonesian", ind: "Indonesian",
  ms: "Malay", msa: "Malay", may: "Malay",
  ja: "Japanese", jpn: "Japanese",
  ko: "Korean", kor: "Korean",
  zh: "Chinese", zho: "Chinese", chi: "Chinese",
  hr: "Croatian", hrv: "Croatian",
  sr: "Serbian", srp: "Serbian",
  sl: "Slovenian", slv: "Slovenian",
  et: "Estonian", est: "Estonian",
  lv: "Latvian", lav: "Latvian",
  lt: "Lithuanian", lit: "Lithuanian",
  ca: "Catalan", cat: "Catalan",
};

/** Reverse lookup so `Movie.English.srt` resolves as well as `Movie.eng.srt`. */
const NAME_TO_CODE = new Map<string, string>();
for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
  const key = name.toLowerCase();
  const current = NAME_TO_CODE.get(key);
  // Prefer the 3-letter form — it is what Matroska carries — and among several
  // 3-letter spellings prefer the first, which is the ISO-639-2/T code. Letting
  // the last one win would resolve "Spanish" to `esp`, a code that does not
  // exist, purely because it is listed after `spa`.
  if (!current || (code.length === 3 && current.length !== 3)) {
    NAME_TO_CODE.set(key, code);
  }
}

/** Human name for a language code, or the code upper-cased when unknown. */
export function languageLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const lc = code.trim().toLowerCase();
  if (!lc || lc === "und" || lc === "unknown") return null;
  return LANGUAGE_NAMES[lc] ?? lc.toUpperCase();
}

/** Resolve a filename token to a language code, or null. */
export function languageFromToken(token: string): string | null {
  const lc = token.trim().toLowerCase();
  if (!lc) return null;
  if (LANGUAGE_NAMES[lc]) return lc;
  return NAME_TO_CODE.get(lc) ?? null;
}

// ── Path helpers ──

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function extensionOf(p: string): string {
  const name = normalizePath(p).split("/").pop() ?? p;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function baseNameOf(p: string): string {
  const name = normalizePath(p).split("/").pop() ?? p;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(0, dot) : name;
}

function dirNameOf(p: string): string {
  const clean = normalizePath(p);
  const slash = clean.lastIndexOf("/");
  return slash >= 0 ? clean.slice(0, slash) : "";
}

/** True when `dir` is (or is inside) a conventional subtitles folder under `videoDir`. */
function isSubtitleFolderOf(dir: string, videoDir: string): boolean {
  const d = dir.toLowerCase();
  const v = videoDir.toLowerCase();
  if (!d.startsWith(v)) return false;
  const rest = d.slice(v.length).replace(/^\//, "");
  if (!rest) return false;
  return rest.split("/").every((part) => SUBTITLE_DIR_NAMES.has(part));
}

// ── Sidecar discovery ──

export type SidecarSubtitle = {
  /** Path inside the torrent. */
  path: string;
  /** Extension without the dot: srt / vtt / ass / ssa. */
  extension: string;
  language: string | null;
  forced: boolean;
  hearingImpaired: boolean;
};

export type TorrentFileEntry = { path: string };

/**
 * Every subtitle file in the torrent that belongs to `videoPath`.
 *
 * Deliberately a *rule*, not a filename match, because releases disagree wildly
 * about naming. A sidecar counts when:
 *
 *  - it sits beside the video and its name is the video's name, optionally with
 *    extra `.`/`_`/`-` separated tokens (`Film.eng.srt`, `Film.en.forced.srt`);
 *  - it lives in a `Subs/`/`Subtitles/` folder under the video's folder
 *    (`Subs/2_English.srt`, the WEB-DL convention); or
 *  - the torrent holds exactly one video, in which case any subtitle file in it
 *    can only belong to that video.
 */
export function findSidecarSubtitles(
  files: TorrentFileEntry[],
  videoPath: string,
  opts: { soleVideo?: boolean } = {},
): SidecarSubtitle[] {
  const videoBase = baseNameOf(videoPath).toLowerCase();
  const videoDir = dirNameOf(videoPath).toLowerCase();

  const out: SidecarSubtitle[] = [];
  for (const file of files) {
    const ext = extensionOf(file.path);
    if (!SIDECAR_EXTENSIONS.has(ext)) continue;

    const dir = dirNameOf(file.path).toLowerCase();
    const base = baseNameOf(file.path);
    const baseLc = base.toLowerCase();

    let extra: string | null = null;
    if (dir === videoDir && baseLc === videoBase) {
      extra = "";
    } else if (dir === videoDir && baseLc.startsWith(videoBase)) {
      const rest = base.slice(videoBase.length);
      // Only a real separator counts: "Film2.srt" is not a sidecar of "Film".
      if (/^[._\- ]/.test(rest)) extra = rest;
    } else if (isSubtitleFolderOf(dir, videoDir)) {
      extra = base;
    } else if (opts.soleVideo) {
      extra = base;
    }
    if (extra === null) continue;

    const tokens = extra.split(/[._\-\s()[\]]+/).filter(Boolean);
    let language: string | null = null;
    for (const token of tokens) {
      const code = languageFromToken(token);
      if (code) {
        language = code;
        break;
      }
    }
    const flags = tokens.map((t) => t.toLowerCase());
    out.push({
      path: normalizePath(file.path),
      extension: ext.slice(1),
      language,
      forced: flags.includes("forced"),
      hearingImpaired: flags.includes("sdh") || flags.includes("hi") || flags.includes("cc"),
    });
  }
  return out;
}

// ── Track building ──

function codecDisplay(codec: string): string {
  const lc = codec.toLowerCase();
  const map: Record<string, string> = {
    subrip: "SubRip",
    srt: "SubRip",
    webvtt: "WebVTT",
    vtt: "WebVTT",
    ass: "ASS",
    ssa: "SSA",
    mov_text: "MP4 text",
    hdmv_pgs_subtitle: "PGS",
    pgssub: "PGS",
    dvd_subtitle: "VobSub",
    dvdsub: "VobSub",
    dvb_subtitle: "DVB",
    dvb_teletext: "Teletext",
    xsub: "XSUB",
  };
  return map[lc] ?? codec.toUpperCase();
}

function decorate(base: string, forced: boolean, sdh: boolean): string {
  const marks: string[] = [];
  if (forced) marks.push("forced");
  if (sdh) marks.push("SDH");
  return marks.length > 0 ? `${base} (${marks.join(", ")})` : base;
}

const IMAGE_REASON =
  "image-based subtitles cannot be converted to WebVTT — play this release in VLC/MPV for it";
const UNKNOWN_REASON = "this subtitle codec cannot be converted to WebVTT";

/** Build the pickable track list for the embedded subtitle streams of a probe. */
export function embeddedSubtitleTracks(streams: ProbeStream[]): SubtitleTrack[] {
  const subs = streams.filter((s) => s.codecType === "subtitle");
  return subs.map((stream, i) => {
    const kind = classifySubtitleCodec(stream.codec);
    const title = stream.title?.trim() || null;
    const lang = languageLabel(stream.language);
    const titleLc = title?.toLowerCase() ?? "";
    // ffprobe's stream tags are all we have here — `ProbeStream` carries no
    // disposition flags — so a forced/SDH marking can only come from the title,
    // which already contains the words. Nothing is appended on top of it.
    const forced = /forced/.test(titleLc);
    const sdh = /\bsdh\b|hearing[ -]?impaired/.test(titleLc);
    const name = title ?? lang ?? `Track ${i + 1}`;
    const supported = kind === "text";
    const reason = kind === "image" ? IMAGE_REASON : kind === "unknown" ? UNKNOWN_REASON : null;
    return {
      id: `embedded:${stream.index}`,
      kind: "embedded" as const,
      label: supported
        ? `${name} · ${codecDisplay(stream.codec)}`
        : `${name} · ${codecDisplay(stream.codec)} — unsupported`,
      language: stream.language?.toLowerCase() ?? null,
      codec: stream.codec,
      supported,
      unsupportedReason: reason,
      streamIndex: stream.index,
      filePath: null,
      needsExtraction: true,
      forced,
      hearingImpaired: sdh,
    };
  });
}

/** Build the pickable track list for sidecar subtitle files in the torrent. */
export function sidecarSubtitleTracks(sidecars: SidecarSubtitle[]): SubtitleTrack[] {
  return sidecars.map((sidecar, i) => {
    const lang = languageLabel(sidecar.language);
    const name = decorate(
      lang ?? baseNameOf(sidecar.path) ?? `File ${i + 1}`,
      sidecar.forced,
      sidecar.hearingImpaired,
    );
    return {
      id: `sidecar:${sidecar.path}`,
      kind: "sidecar" as const,
      label: `${name} · ${codecDisplay(sidecar.extension)} file`,
      language: sidecar.language,
      codec: sidecar.extension,
      supported: true,
      unsupportedReason: null,
      streamIndex: null,
      filePath: sidecar.path,
      needsExtraction: false,
      forced: sidecar.forced,
      hearingImpaired: sidecar.hearingImpaired,
    };
  });
}

/**
 * The full list a viewer chooses from. Sidecars first: they are free to serve,
 * embedded tracks cost a demux of the whole file.
 */
export function buildSubtitleTracks(input: {
  probeStreams?: ProbeStream[];
  files?: TorrentFileEntry[];
  videoPath: string;
  soleVideo?: boolean;
}): SubtitleTrack[] {
  const sidecars = input.files
    ? sidecarSubtitleTracks(
        findSidecarSubtitles(input.files, input.videoPath, { soleVideo: input.soleVideo }),
      )
    : [];
  const embedded = input.probeStreams ? embeddedSubtitleTracks(input.probeStreams) : [];
  return [...sidecars, ...embedded];
}

// ── Track ids ──

export type ParsedTrackId =
  | { kind: "embedded"; streamIndex: number }
  | { kind: "sidecar"; filePath: string }
  | null;

export function parseSubtitleTrackId(raw: string | null | undefined): ParsedTrackId {
  if (!raw) return null;
  if (raw.startsWith("embedded:")) {
    const idx = Number(raw.slice("embedded:".length));
    return Number.isInteger(idx) && idx >= 0 ? { kind: "embedded", streamIndex: idx } : null;
  }
  if (raw.startsWith("sidecar:")) {
    const filePath = normalizePath(raw.slice("sidecar:".length));
    if (!filePath || filePath.split("/").some((s) => s === "." || s === "..")) return null;
    return { kind: "sidecar", filePath };
  }
  return null;
}

/**
 * URL the `<track>` element points at for a given track.
 *
 * `offsetSec` is the source position the current media timeline starts at, so
 * the server can rebase the cues to match it. It is part of the URL rather than
 * a client-side adjustment because a `<track>` element gives no access to its
 * cues before they load.
 */
export function subtitleTrackSrc(
  infoHash: string,
  videoPath: string,
  trackId: string,
  offsetSec = 0,
  windowStartSec = 0,
  consumerId?: string,
): string {
  const params = new URLSearchParams({ filePath: videoPath, track: trackId });
  if (offsetSec > 0) params.set("offset", String(Math.round(offsetSec * 1000) / 1000));
  if (windowStartSec > 0) {
    params.set("start", String(Math.round(windowStartSec * 1000) / 1000));
  }
  if (consumerId) params.set("consumer", consumerId);
  return `/api/subtitles/${encodeURIComponent(infoHash)}?${params.toString()}`;
}

export const SUBTITLE_WINDOW_STRIDE_SECONDS = 8 * 60;
export const SUBTITLE_WINDOW_DURATION_SECONDS = 10 * 60;

export function subtitleWindowStart(sourceTimeSec: number): number {
  if (!Number.isFinite(sourceTimeSec) || sourceTimeSec <= 0) return 0;
  return (
    Math.floor(sourceTimeSec / SUBTITLE_WINDOW_STRIDE_SECONDS) *
    SUBTITLE_WINDOW_STRIDE_SECONDS
  );
}

/** URL for the track list of a file. */
export function subtitleListUrl(infoHash: string, videoPath: string): string {
  const params = new URLSearchParams({ filePath: videoPath });
  return `/api/subtitles/${encodeURIComponent(infoHash)}?${params.toString()}`;
}

// ── Conversion ──

/**
 * SubRip → WebVTT.
 *
 * Pure text surgery rather than an ffmpeg hop: SubRip and WebVTT differ only in
 * the header and the decimal separator, and a sidecar is a few hundred KB that
 * a viewer is waiting on. Kept here (not in the stream route) so both the route
 * and the subtitles endpoint convert identically.
 */
export function srtToVtt(text: string): string {
  const body = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n|\r/g, "\n")
    // SubRip separates seconds from milliseconds with a comma; WebVTT uses a dot.
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{1,3})/g, "$1.$2");
  return `WEBVTT\n\n${body}`;
}

/** True when the text already is WebVTT and needs no conversion. */
export function isWebVtt(text: string): boolean {
  return /^\s*WEBVTT/.test(text);
}

/** `HH:MM:SS.mmm` / `MM:SS.mmm`, the two forms WebVTT allows. */
const VTT_TIME = /(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})/;
const VTT_CUE_LINE = new RegExp(
  `^(\\s*)(${VTT_TIME.source})(\\s*-->\\s*)(${VTT_TIME.source})(.*)$`,
);

function parseVttTime(h: string | undefined, m: string, s: string, ms: string): number {
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

function formatVttTime(total: number): string {
  const clamped = Math.max(0, total);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/**
 * Move every cue by `deltaSec`.
 *
 * Subtitles are extracted once, in *source* time, and cached — but in HLS mode
 * the media element's timeline is rebased to zero at the offset the current
 * ffmpeg session was started with. Handing the browser source-time cues there
 * would put every line `timelineOffset` seconds late: after a seek to 1:30 the
 * subtitles would simply never appear, which looks exactly like "this track is
 * broken". Shifting on the way out keeps one cached extraction usable at every
 * offset.
 *
 * Cues that end before zero are dropped whole (identifier and text with them);
 * a cue straddling zero is clamped, because part of it is still on screen.
 */
export function shiftVttCues(vtt: string, deltaSec: number): string {
  if (!deltaSec || !Number.isFinite(deltaSec)) return vtt;
  const blocks = vtt.replace(/\r\n|\r/g, "\n").split(/\n{2,}/);
  const kept: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const cueIndex = lines.findIndex((line) => VTT_CUE_LINE.test(line));
    if (cueIndex < 0) {
      kept.push(block);
      continue;
    }
    const m = VTT_CUE_LINE.exec(lines[cueIndex]);
    if (!m) {
      kept.push(block);
      continue;
    }
    // Groups: 1 indent, 2 whole start, 3-6 start parts, 7 arrow, 8 whole end,
    // 9-12 end parts, 13 trailing cue settings.
    const start = parseVttTime(m[3], m[4], m[5], m[6]) + deltaSec;
    const end = parseVttTime(m[9], m[10], m[11], m[12]) + deltaSec;
    if (end <= 0) continue;
    lines[cueIndex] =
      `${m[1]}${formatVttTime(start)}${m[7]}${formatVttTime(end)}${m[13] ?? ""}`;
    kept.push(lines.join("\n"));
  }
  return kept.join("\n\n");
}
