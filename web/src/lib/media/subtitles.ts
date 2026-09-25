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

type SubtitleTrackKind = "embedded" | "sidecar";

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

// ── Path helpers ──

// ── Sidecar discovery ──

// ── Track building ──

// ── Track ids ──

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
