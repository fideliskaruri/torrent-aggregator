/**
 * Subtitle discovery, classification and conversion.
 *
 * The two defects this file exists to prevent:
 *
 *  1. **Offering a track that can never render.** Image-based subtitles
 *     (`hdmv_pgs_subtitle`, `dvd_subtitle`, …) cannot be converted to WebVTT —
 *     ffmpeg refuses outright. Listing one as selectable would be the app
 *     claiming something it has not checked, which is the exact bug class this
 *     project keeps having to unlearn.
 *  2. **Missing the subtitles a release actually shipped.** Scene releases put
 *     sidecars beside the video, in a `Subs/` folder, or under a name that only
 *     shares a prefix. A rule that only matches the exact basename finds a
 *     fraction of them.
 *
 * Codec names below are the real strings ffprobe emits, not invented ones.
 */
import {
  buildSubtitleTracks,
  classifySubtitleCodec,
  embeddedSubtitleTracks,
  findSidecarSubtitles,
  isWebVtt,
  languageFromToken,
  languageLabel,
  parseSubtitleTrackId,
  sidecarSubtitleTracks,
  shiftVttCues,
  srtToVtt,
  subtitleListUrl,
  subtitleTrackSrc,
} from "./subtitles";
import type { ProbeStream } from "./probe";

let failures = 0;

function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Codec classification ──

const CODEC_CASES: Array<[string, "text" | "image" | "unknown"]> = [
  ["subrip", "text"],
  ["srt", "text"],
  ["ass", "text"],
  ["ssa", "text"],
  ["mov_text", "text"],
  ["webvtt", "text"],
  ["SubRip", "text"],
  ["hdmv_pgs_subtitle", "image"],
  ["dvd_subtitle", "image"],
  ["dvb_subtitle", "image"],
  ["xsub", "image"],
  ["vobsub", "image"],
  ["some_future_codec", "unknown"],
];

for (const [codec, expected] of CODEC_CASES) {
  assert(
    `classifies ${codec} as ${expected}`,
    classifySubtitleCodec(codec) === expected,
    classifySubtitleCodec(codec),
  );
}

// ── Embedded tracks ──

function stream(partial: Partial<ProbeStream> & { index: number }): ProbeStream {
  return {
    index: partial.index,
    codecType: partial.codecType ?? "subtitle",
    codec: partial.codec ?? "subrip",
    channels: partial.channels ?? null,
    language: partial.language ?? null,
    title: partial.title ?? null,
    profile: partial.profile ?? null,
    width: partial.width ?? null,
    height: partial.height ?? null,
    bitRate: partial.bitRate ?? null,
    sampleRate: partial.sampleRate ?? null,
  } as ProbeStream;
}

const probeStreams: ProbeStream[] = [
  stream({ index: 0, codecType: "video", codec: "h264" }),
  stream({ index: 1, codecType: "audio", codec: "ac3", channels: 6, language: "eng" }),
  stream({ index: 2, codec: "subrip", language: "eng", title: "English" }),
  stream({ index: 3, codec: "hdmv_pgs_subtitle", language: "eng", title: "English PGS" }),
  stream({ index: 4, codec: "ass", language: "jpn" }),
  stream({ index: 5, codec: "dvd_subtitle", language: "fre" }),
];

const embedded = embeddedSubtitleTracks(probeStreams);

assert(
  "only subtitle streams become tracks",
  embedded.length === 4,
  `${embedded.length} tracks`,
);
assert(
  "a subrip track is supported and keeps its stream index",
  embedded[0].supported && embedded[0].streamIndex === 2 && embedded[0].id === "embedded:2",
  JSON.stringify(embedded[0]),
);
assert(
  "an ass track is supported",
  embedded.find((t) => t.streamIndex === 4)?.supported === true,
);
assert(
  "a PGS track is NOT supported",
  embedded.find((t) => t.streamIndex === 3)?.supported === false,
);
assert(
  "a VobSub track is NOT supported",
  embedded.find((t) => t.streamIndex === 5)?.supported === false,
);
assert(
  "an unsupported track says why, in the label and in a reason",
  embedded
    .filter((t) => !t.supported)
    .every(
      (t) => /unsupported/i.test(t.label) && (t.unsupportedReason?.length ?? 0) > 10,
    ),
  embedded.filter((t) => !t.supported).map((t) => t.label).join(" | "),
);
assert(
  "every embedded track is marked as needing extraction",
  embedded.every((t) => t.needsExtraction),
);
assert(
  "an untitled track still gets a usable label from its language",
  /Japanese/.test(embedded.find((t) => t.streamIndex === 4)?.label ?? ""),
  embedded.find((t) => t.streamIndex === 4)?.label ?? "",
);
assert(
  "no probe streams means no embedded tracks",
  embeddedSubtitleTracks([]).length === 0,
);

// ── Sidecar discovery ──

const sceneFiles = [
  { path: "Film.2024.1080p.WEB-DL/Film.2024.1080p.WEB-DL.mkv" },
  { path: "Film.2024.1080p.WEB-DL/Film.2024.1080p.WEB-DL.srt" },
  { path: "Film.2024.1080p.WEB-DL/Film.2024.1080p.WEB-DL.eng.forced.srt" },
  { path: "Film.2024.1080p.WEB-DL/Subs/2_English.srt" },
  { path: "Film.2024.1080p.WEB-DL/Subs/3_French.SDH.srt" },
  { path: "Film.2024.1080p.WEB-DL/Film.2024.1080p.WEB-DL.nfo" },
  { path: "Film.2024.1080p.WEB-DL/Sample/sample.mkv" },
];

const sidecars = findSidecarSubtitles(sceneFiles, "Film.2024.1080p.WEB-DL/Film.2024.1080p.WEB-DL.mkv");

assert(
  "finds the exact-basename sidecar",
  sidecars.some((s) => s.path.endsWith("Film.2024.1080p.WEB-DL.srt")),
  sidecars.map((s) => s.path).join(", "),
);
assert(
  "finds a sidecar with extra language/forced tokens",
  sidecars.some((s) => s.path.endsWith("eng.forced.srt")),
);
assert(
  "reads the language and the forced flag out of the name",
  sidecars.find((s) => s.path.endsWith("eng.forced.srt"))?.language === "eng" &&
    sidecars.find((s) => s.path.endsWith("eng.forced.srt"))?.forced === true,
  JSON.stringify(sidecars.find((s) => s.path.endsWith("eng.forced.srt"))),
);
assert(
  "finds files in a Subs/ folder",
  sidecars.some((s) => s.path.endsWith("Subs/2_English.srt")),
);
assert(
  "reads a language written as a name, not a code",
  sidecars.find((s) => s.path.endsWith("2_English.srt"))?.language === "eng",
  sidecars.find((s) => s.path.endsWith("2_English.srt"))?.language ?? "none",
);
assert(
  "reads the SDH flag",
  sidecars.find((s) => s.path.endsWith("3_French.SDH.srt"))?.hearingImpaired === true,
);
assert(
  "ignores non-subtitle files",
  sidecars.every((s) => !s.path.endsWith(".nfo") && !s.path.endsWith(".mkv")),
);

// The prefix rule must require a real separator, or every episode picks up
// every other episode's subtitles.
const episodeFiles = [
  { path: "Show/Show.S01E01.mkv" },
  { path: "Show/Show.S01E01.srt" },
  { path: "Show/Show.S01E011.srt" },
  { path: "Show/Show.S01E02.srt" },
];
const episodeSidecars = findSidecarSubtitles(episodeFiles, "Show/Show.S01E01.mkv");
assert(
  "a longer basename with no separator is not a sidecar",
  episodeSidecars.length === 1 && episodeSidecars[0].path.endsWith("Show.S01E01.srt"),
  episodeSidecars.map((s) => s.path).join(", "),
);

// Different directory, no Subs/ folder → not a sidecar.
const otherDirFiles = [
  { path: "A/film.mkv" },
  { path: "B/film.srt" },
];
assert(
  "a subtitle in an unrelated directory is not a sidecar",
  findSidecarSubtitles(otherDirFiles, "A/film.mkv").length === 0,
);
assert(
  "…unless the torrent holds exactly one video, where it can only be for that",
  findSidecarSubtitles(otherDirFiles, "A/film.mkv", { soleVideo: true }).length === 1,
);

// ── Track assembly ──

const tracks = buildSubtitleTracks({
  probeStreams,
  files: sceneFiles,
  videoPath: "Film.2024.1080p.WEB-DL/Film.2024.1080p.WEB-DL.mkv",
});

assert(
  "sidecars are listed before embedded tracks (they cost nothing to serve)",
  tracks[0].kind === "sidecar" && tracks[tracks.length - 1].kind === "embedded",
  tracks.map((t) => t.kind).join(","),
);
assert(
  "every track id is unique",
  new Set(tracks.map((t) => t.id)).size === tracks.length,
);
assert(
  "every track has a non-empty label",
  tracks.every((t) => t.label.trim().length > 0),
);
assert(
  "sidecar tracks never need extraction",
  sidecarSubtitleTracks(sidecars).every((t) => !t.needsExtraction),
);

// ── Track ids ──

assert("parses an embedded id", parseSubtitleTrackId("embedded:3")?.kind === "embedded");
assert(
  "parses a sidecar id",
  parseSubtitleTrackId("sidecar:Show/a.srt")?.kind === "sidecar",
);
assert("rejects an unknown id scheme", parseSubtitleTrackId("magic:1") === null);
assert("rejects an empty id", parseSubtitleTrackId("") === null);
assert(
  "rejects a traversal attempt in a sidecar id",
  parseSubtitleTrackId("sidecar:../../etc/passwd") === null,
);
assert(
  "rejects a non-numeric embedded index",
  parseSubtitleTrackId("embedded:abc") === null,
);

assert(
  "the track URL carries the file and the track",
  subtitleTrackSrc("abc", "dir/film.mkv", "embedded:2").includes("track=embedded%3A2") &&
    subtitleTrackSrc("abc", "dir/film.mkv", "embedded:2").includes("filePath=dir%2Ffilm.mkv"),
  subtitleTrackSrc("abc", "dir/film.mkv", "embedded:2"),
);
assert(
  "the list URL carries only the file",
  subtitleListUrl("abc", "dir/film.mkv").endsWith("?filePath=dir%2Ffilm.mkv"),
  subtitleListUrl("abc", "dir/film.mkv"),
);

// ── Language naming ──

assert("maps a 3-letter code to a name", languageLabel("eng") === "English");
assert("maps a 2-letter code to a name", languageLabel("ja") === "Japanese");
assert("upper-cases an unknown code rather than guessing", languageLabel("zz9") === "ZZ9");
assert("has no label for no code", languageLabel(null) === null);
assert("recognises a language written out", languageFromToken("Spanish") === "spa");
assert("does not treat a random token as a language", languageFromToken("1080p") === null);

// ── Conversion ──

const srt = "1\r\n00:00:01,000 --> 00:00:03,500\r\nHello.\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000\r\nBye.\r\n";
const vtt = srtToVtt(srt);

assert("converted output starts with the WEBVTT header", vtt.startsWith("WEBVTT\n\n"));
assert(
  "commas in timestamps become dots",
  vtt.includes("00:00:01.000 --> 00:00:03.500") && vtt.includes("00:01:02.250 --> 00:01:04.000"),
  vtt.slice(0, 120),
);
assert("CRLF is normalised", !vtt.includes("\r"));
assert("cue text survives", vtt.includes("Hello.") && vtt.includes("Bye."));
assert("a BOM does not break the header", srtToVtt(`\uFEFF${srt}`).startsWith("WEBVTT"));
assert("recognises WebVTT that needs no conversion", isWebVtt("WEBVTT\n\n00:00.000 --> 00:01.000\nx"));
assert("does not mistake SubRip for WebVTT", !isWebVtt(srt));

// ── Cue rebasing ──
//
// Cues are cached in *source* time but an HLS session's media timeline restarts
// at zero, so serving unshifted cues after a seek to 1:30 would put every line
// 90 seconds late — i.e. the track would silently never appear.

const longVtt = [
  "WEBVTT",
  "",
  "1",
  "00:00:10.000 --> 00:00:12.000",
  "Early line.",
  "",
  "2",
  "00:01:29.500 --> 00:01:32.000",
  "Straddles the cut.",
  "",
  "3",
  "00:02:00.000 --> 00:02:03.000",
  "Later line.",
].join("\n");

const shifted = shiftVttCues(longVtt, -90);

assert("the WEBVTT header survives a shift", shifted.startsWith("WEBVTT"));
assert(
  "a cue entirely before the new zero is dropped, text and all",
  !shifted.includes("Early line."),
  shifted,
);
assert(
  "a cue straddling the new zero is clamped, not dropped",
  shifted.includes("Straddles the cut.") && shifted.includes("00:00:00.000 --> 00:00:02.000"),
  shifted,
);
assert(
  "a later cue moves back by exactly the offset",
  shifted.includes("00:00:30.000 --> 00:00:33.000") && shifted.includes("Later line."),
  shifted,
);
assert("a zero shift changes nothing", shiftVttCues(longVtt, 0) === longVtt);
assert(
  "shifting forward works too",
  shiftVttCues("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx", 5).includes(
    "00:00:06.000 --> 00:00:07.000",
  ),
  shiftVttCues("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx", 5),
);
assert(
  "cue settings on the timing line are preserved",
  shiftVttCues("WEBVTT\n\n00:00:10.000 --> 00:00:12.000 line:90% align:middle\nx", -5).includes(
    "line:90% align:middle",
  ),
);
assert(
  "the short MM:SS.mmm form is understood",
  shiftVttCues("WEBVTT\n\n00:10.000 --> 00:12.000\nx", -5).includes(
    "00:00:05.000 --> 00:00:07.000",
  ),
  shiftVttCues("WEBVTT\n\n00:10.000 --> 00:12.000\nx", -5),
);
assert(
  "the URL carries a non-zero offset and omits a zero one",
  subtitleTrackSrc("abc", "f.mkv", "embedded:2", 90).includes("offset=90") &&
    !subtitleTrackSrc("abc", "f.mkv", "embedded:2", 0).includes("offset"),
  subtitleTrackSrc("abc", "f.mkv", "embedded:2", 90),
);

console.log(failures === 0 ? "\nAll subtitle tests passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
