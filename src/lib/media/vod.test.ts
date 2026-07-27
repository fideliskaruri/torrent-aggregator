/**
 * Table-driven tests for the complete-file playback strategy.
 *
 * Three things here are worth testing and nothing else is:
 *
 *   - the routing decision, because getting it wrong either regresses the
 *     incomplete-torrent path (which must stay byte-for-byte as it was) or
 *     silently sends a copyable stream down a re-encode;
 *   - the playlist arithmetic, because an off-by-one on the last segment is
 *     invisible until a viewer reaches the end of a film;
 *   - the ffmpeg argument shape, because `-ss` on the wrong side of `-i` turns
 *     a seek to 55 minutes into 55 minutes of decoding, and a missing
 *     `-copyts` makes every independently produced segment claim to start at
 *     zero.
 */
import assert from "node:assert/strict";
import {
  buildKeyframeProbeArgs,
  buildVodPlaylist,
  buildVodSegmentArgs,
  buildWholeFileHlsArgs,
  chooseStrategy,
  fixedGridSegments,
  keyframeAlignedSegments,
  parseKeyframeTimes,
  splitFragmentedMp4,
  trimVodPlaylist,
  VOD_SEGMENT_SECONDS,
  WHOLE_FILE_DATA,
  WHOLE_FILE_PLAYLIST,
  type VodSegment,
} from "./vod";
import type { AudioPlan, PlaybackPlan, PlaybackRung } from "./decide";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

function audio(overrides: Partial<AudioPlan> = {}): AudioPlan {
  return {
    streamIndex: 1,
    codec: "ac3",
    action: "copy",
    channels: 6,
    language: "eng",
    title: null,
    ...overrides,
  };
}

function plan(overrides: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    rung: "remux",
    reason: "test",
    video: { codec: "hevc", streamIndex: 0, action: "copy" },
    audio: [audio()],
    selectedAudioIndex: 1,
    container: "matroska",
    cost: 1,
    ...overrides,
  };
}

// ── Routing ──

console.log("\nstrategy routing");

const routingCases: Array<{
  name: string;
  complete: boolean;
  rung: PlaybackRung;
  videoAction: "copy" | "transcode" | null;
  duration: number | null;
  expect: "session" | "whole-file" | "vod-segments";
}> = [
  {
    name: "incomplete remux stays on the session path",
    complete: false,
    rung: "remux",
    videoAction: "copy",
    duration: 3600,
    expect: "session",
  },
  {
    name: "incomplete transcode-full stays on the session path",
    complete: false,
    rung: "transcode-full",
    videoAction: "transcode",
    duration: 3600,
    expect: "session",
  },
  {
    name: "complete remux converts the whole file",
    complete: true,
    rung: "remux",
    videoAction: "copy",
    duration: 3600,
    expect: "whole-file",
  },
  {
    name: "complete transcode-audio converts the whole file (video still copies)",
    complete: true,
    rung: "transcode-audio",
    videoAction: "copy",
    duration: 3600,
    expect: "whole-file",
  },
  {
    name: "complete transcode-full segments on demand",
    complete: true,
    rung: "transcode-full",
    videoAction: "transcode",
    duration: 3600,
    expect: "vod-segments",
  },
  {
    name: "direct never reaches ffmpeg at all",
    complete: true,
    rung: "direct",
    videoAction: "copy",
    duration: 3600,
    expect: "session",
  },
  {
    name: "unknown duration cannot produce a VOD playlist",
    complete: true,
    rung: "remux",
    videoAction: "copy",
    duration: null,
    expect: "session",
  },
  {
    name: "zero duration cannot produce a VOD playlist",
    complete: true,
    rung: "transcode-full",
    videoAction: "transcode",
    duration: 0,
    expect: "session",
  },
  {
    name: "no video stream falls back to the session path",
    complete: true,
    rung: "transcode-audio",
    videoAction: null,
    duration: 3600,
    expect: "session",
  },
];

for (const testCase of routingCases) {
  check(testCase.name, () => {
    const decision = chooseStrategy({
      complete: testCase.complete,
      duration: testCase.duration,
      plan: plan({
        rung: testCase.rung,
        video:
          testCase.videoAction === null
            ? null
            : { codec: "hevc", streamIndex: 0, action: testCase.videoAction },
      }),
    });
    assert.equal(decision.strategy, testCase.expect, decision.reason);
    assert.ok(decision.reason.length > 0, "every decision explains itself");
  });
}

// ── Fixed grid arithmetic ──

console.log("\nfixed grid segments");

const gridCases: Array<{
  name: string;
  duration: number;
  segment: number;
  expectCount: number;
  expectLast: number;
}> = [
  { name: "exact multiple", duration: 40, segment: 4, expectCount: 10, expectLast: 4 },
  { name: "remainder becomes a short last segment", duration: 43, segment: 4, expectCount: 11, expectLast: 3 },
  { name: "sub-segment file is one segment", duration: 2.5, segment: 4, expectCount: 1, expectLast: 2.5 },
  {
    name: "sliver remainder folds into its predecessor",
    duration: 40.2,
    segment: 4,
    expectCount: 10,
    expectLast: 4.2,
  },
  {
    name: "half-second remainder is kept (at the threshold)",
    duration: 40.5,
    segment: 4,
    expectCount: 11,
    expectLast: 0.5,
  },
  { name: "feature length", duration: 7265.5, segment: 4, expectCount: 1817, expectLast: 1.5 },
];

for (const testCase of gridCases) {
  check(`${testCase.name} (${testCase.duration}s)`, () => {
    const segments = fixedGridSegments(testCase.duration, testCase.segment);
    assert.equal(segments.length, testCase.expectCount, "segment count");
    assert.equal(segments[segments.length - 1].duration, testCase.expectLast, "last segment length");
    assertContiguous(segments, testCase.duration);
  });
}

check("degenerate durations produce no segments", () => {
  assert.deepEqual(fixedGridSegments(0), []);
  assert.deepEqual(fixedGridSegments(-5), []);
  assert.deepEqual(fixedGridSegments(Number.NaN), []);
  assert.deepEqual(fixedGridSegments(100, 0), []);
});

/**
 * The property that actually matters: segments tile the timeline with no gap
 * and no overlap, and end exactly at the source duration. A gap is a stall; an
 * overlap is A/V drift.
 */
function assertContiguous(segments: VodSegment[], duration: number) {
  let cursor = 0;
  for (const segment of segments) {
    assert.ok(
      Math.abs(segment.start - cursor) < 0.002,
      `segment ${segment.index} starts at ${segment.start}, expected ${cursor}`,
    );
    assert.ok(segment.duration > 0, `segment ${segment.index} has no duration`);
    cursor = Math.round((cursor + segment.duration) * 1000) / 1000;
  }
  assert.ok(
    Math.abs(cursor - duration) < 0.002,
    `segments cover ${cursor}s of a ${duration}s source`,
  );
}

// ── Keyframe-aligned arithmetic ──

console.log("\nkeyframe-aligned segments");

check("boundaries land only on real keyframes", () => {
  const keys = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
  const segments = keyframeAlignedSegments(keys, 20, 4);
  assert.deepEqual(
    segments.map((s) => s.start),
    [0, 4, 8, 12, 16],
  );
  for (const segment of segments) {
    assert.ok(keys.includes(segment.start), `${segment.start} is a keyframe`);
  }
  assertContiguous(segments, 20);
});

check("a sparse keyframe run produces longer segments, never a mid-GOP cut", () => {
  // Keyframes every 10s: a 4s target cannot be honoured, and must not be faked.
  const keys = [0, 10, 20, 30];
  const segments = keyframeAlignedSegments(keys, 40, 4);
  assert.deepEqual(
    segments.map((s) => s.start),
    [0, 10, 20, 30],
  );
  assert.deepEqual(
    segments.map((s) => s.duration),
    [10, 10, 10, 10],
  );
});

check("irregular keyframes still tile the timeline", () => {
  const keys = [0, 1.5, 3.2, 7.9, 8.1, 12.4, 19.0];
  const segments = keyframeAlignedSegments(keys, 22, 4);
  for (const segment of segments) {
    assert.ok(keys.includes(segment.start), `${segment.start} is a keyframe`);
  }
  assertContiguous(segments, 22);
});

check("a source whose first keyframe is late starts there", () => {
  const segments = keyframeAlignedSegments([1.2, 5.4, 9.9], 14, 4);
  assert.equal(segments[0].start, 1.2);
});

check("no keyframe index falls back to the fixed grid", () => {
  assert.deepEqual(keyframeAlignedSegments([], 12, 4), fixedGridSegments(12, 4));
});

// ── Keyframe index parsing ──

console.log("\nkeyframe probe output");

check("only packets flagged K are keyframes", () => {
  const csv = ["0.000000,K_", "0.041667,__", "2.000000,K_", "2.041667,__", "4.000000,K_"].join("\n");
  assert.deepEqual(parseKeyframeTimes(csv), [0, 2, 4]);
});

check("N/A timestamps and blank lines are discarded, output is sorted and unique", () => {
  const csv = ["4.000000,K_", "", "N/A,K_", "0.000000,K_", "4.000000,K_", "  ", "2.5,K_"].join("\r\n");
  assert.deepEqual(parseKeyframeTimes(csv), [0, 2.5, 4]);
});

check("a probe that produced nothing yields no keyframes rather than throwing", () => {
  assert.deepEqual(parseKeyframeTimes(""), []);
});

check("keyframe probe reads packets, never frames", () => {
  const args = buildKeyframeProbeArgs("D:\\media\\film.mkv");
  assert.ok(args.includes("-show_packets"), "packets carry the flag without decoding");
  assert.ok(!args.includes("-show_frames"), "-show_frames decodes the whole file");
  assert.ok(args.includes("packet=pts_time,flags"));
  assert.equal(args[args.length - 1], "D:\\media\\film.mkv");
});

// ── Playlist ──

console.log("\nVOD playlist");

check("playlist is VOD, ends, and lists every segment", () => {
  const segments = fixedGridSegments(10, 4);
  const text = buildVodPlaylist(segments, {
    initUri: "init.mp4",
    segmentUri: (i) => `seg${String(i).padStart(5, "0")}.m4s`,
  });
  assert.ok(text.includes("#EXT-X-PLAYLIST-TYPE:VOD"), "must be VOD, not EVENT");
  assert.ok(text.includes("#EXT-X-ENDLIST"), "the player must know where the film ends");
  assert.ok(text.includes('#EXT-X-MAP:URI="init.mp4"'));
  assert.ok(text.includes("#EXT-X-TARGETDURATION:4"));
  assert.equal((text.match(/#EXTINF:/g) ?? []).length, 3);
  assert.ok(text.includes("seg00000.m4s"));
  assert.ok(text.includes("seg00002.m4s"));
  assert.ok(text.trimEnd().endsWith("#EXT-X-ENDLIST"));
});

check("EXTINF durations sum to the source duration", () => {
  const segments = fixedGridSegments(43, 4);
  const text = buildVodPlaylist(segments, {
    initUri: "init.mp4",
    segmentUri: (i) => `seg${i}.m4s`,
  });
  const total = (text.match(/#EXTINF:([\d.]+)/g) ?? [])
    .map((line) => Number(line.slice("#EXTINF:".length)))
    .reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 43) < 0.002, `EXTINF total ${total}`);
});

check("target duration is rounded up, never down", () => {
  const text = buildVodPlaylist([{ index: 0, start: 0, duration: 4.2 }], {
    initUri: "init.mp4",
    segmentUri: () => "seg0.m4s",
  });
  assert.ok(text.includes("#EXT-X-TARGETDURATION:5"), "a 4.2s segment needs a target of 5");
});

// ── Playlist trimming ──

console.log("\nplaylist trimming");

/** The exact shape ffmpeg's single-file HLS muxer emits (measured, not invented). */
const FFMPEG_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-PLAYLIST-TYPE:VOD",
  "#EXT-X-INDEPENDENT-SEGMENTS",
  '#EXT-X-MAP:URI="data.m4s",BYTERANGE="1294@0"',
  "#EXTINF:4.000000,",
  "#EXT-X-BYTERANGE:606527@1294",
  "data.m4s",
  "#EXTINF:4.000000,",
  "#EXT-X-BYTERANGE:623898@607821",
  "data.m4s",
  "#EXTINF:4.000000,",
  "#EXT-X-BYTERANGE:601223@1231719",
  "data.m4s",
  "#EXTINF:3.937500,",
  "#EXT-X-BYTERANGE:603966@1832942",
  "data.m4s",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

check("trimming keeps the header, the map and the endlist", () => {
  const { text } = trimVodPlaylist(FFMPEG_PLAYLIST, 8);
  assert.ok(text.startsWith("#EXTM3U"));
  assert.ok(text.includes('#EXT-X-MAP:URI="data.m4s",BYTERANGE="1294@0"'), "init range survives");
  assert.ok(text.includes("#EXT-X-PLAYLIST-TYPE:VOD"));
  assert.ok(text.trimEnd().endsWith("#EXT-X-ENDLIST"));
});

check("trimming drops whole segments and reports where it now starts", () => {
  const { text, offsetSeconds } = trimVodPlaylist(FFMPEG_PLAYLIST, 8);
  assert.equal(offsetSeconds, 8, "segment 2 starts at 8s");
  assert.equal((text.match(/#EXTINF:/g) ?? []).length, 2);
  assert.ok(text.includes("#EXT-X-BYTERANGE:601223@1231719"), "segment 2 kept");
  assert.ok(!text.includes("#EXT-X-BYTERANGE:606527@1294"), "segment 0 dropped");
  assert.ok(text.includes("#EXT-X-MEDIA-SEQUENCE:2"), "sequence must follow the trim");
});

check("a target inside a segment keeps that whole segment", () => {
  const { offsetSeconds, text } = trimVodPlaylist(FFMPEG_PLAYLIST, 9.5);
  assert.equal(offsetSeconds, 8, "cutting inside a segment would mean re-muxing it");
  assert.equal((text.match(/#EXTINF:/g) ?? []).length, 2);
});

check("a zero or negative target returns the playlist untouched", () => {
  assert.equal(trimVodPlaylist(FFMPEG_PLAYLIST, 0).text, FFMPEG_PLAYLIST);
  assert.equal(trimVodPlaylist(FFMPEG_PLAYLIST, -30).offsetSeconds, 0);
});

check("a target past the end keeps the last segment rather than nothing", () => {
  const { text, offsetSeconds } = trimVodPlaylist(FFMPEG_PLAYLIST, 10_000);
  assert.equal((text.match(/#EXTINF:/g) ?? []).length, 1, "an empty playlist would stall the player");
  assert.equal(offsetSeconds, 12);
});

check("a generated (non-byterange) playlist trims the same way", () => {
  const generated = buildVodPlaylist(fixedGridSegments(20, 4), {
    initUri: "init.mp4",
    segmentUri: (i) => `seg${String(i).padStart(5, "0")}.m4s`,
  });
  const { text, offsetSeconds } = trimVodPlaylist(generated, 12);
  assert.equal(offsetSeconds, 12);
  assert.ok(text.includes("seg00003.m4s"));
  assert.ok(text.includes("seg00004.m4s"));
  assert.ok(!text.includes("seg00002.m4s"));
  assert.ok(text.includes('#EXT-X-MAP:URI="init.mp4"'));
});

// ── fMP4 splitting ──

console.log("\nfMP4 splitting");

function box(type: string, payloadLength: number): Buffer {
  const buf = Buffer.alloc(8 + payloadLength);
  buf.writeUInt32BE(8 + payloadLength, 0);
  buf.write(type, 4, "latin1");
  return buf;
}

check("init is everything before the first moof", () => {
  const buffer = Buffer.concat([box("ftyp", 24), box("moov", 200), box("moof", 100), box("mdat", 900)]);
  const split = splitFragmentedMp4(buffer);
  assert.ok(split, "well-formed fragment splits");
  assert.equal(split.init.length, 32 + 208);
  assert.equal(split.media.length, 108 + 908);
  assert.equal(split.media.toString("latin1", 4, 8), "moof");
});

check("a buffer with no moof does not split", () => {
  assert.equal(splitFragmentedMp4(Buffer.concat([box("ftyp", 24), box("moov", 200)])), null);
});

check("a truncated box does not split", () => {
  const buffer = Buffer.concat([box("ftyp", 24), box("moov", 200)]).subarray(0, 40);
  assert.equal(splitFragmentedMp4(buffer), null);
});

check("a fragment that begins with moof has no init to give", () => {
  assert.equal(splitFragmentedMp4(Buffer.concat([box("moof", 100), box("mdat", 900)])), null);
});

// ── Segment ffmpeg arguments ──

console.log("\nsegment ffmpeg arguments");

check("input seeking: -ss precedes -i", () => {
  const args = buildVodSegmentArgs({
    sourcePath: "D:\\media\\film.mkv",
    plan: plan(),
    segment: { index: 100, start: 400, duration: 4 },
  });
  const ss = args.indexOf("-ss");
  const i = args.indexOf("-i");
  assert.ok(ss > -1, "-ss present");
  assert.ok(ss < i, "-ss must be an input option or the seek decodes everything before it");
  assert.equal(args[ss + 1], "400");
  assert.equal(args[args.indexOf("-to") + 1], "404");
});

check("segment zero omits -ss entirely", () => {
  const args = buildVodSegmentArgs({
    sourcePath: "film.mkv",
    plan: plan(),
    segment: { index: 0, start: 0, duration: 4 },
  });
  assert.ok(!args.includes("-ss"));
  assert.equal(args[args.indexOf("-to") + 1], "4");
});

check("-copyts keeps the fragment on the real timeline", () => {
  const args = buildVodSegmentArgs({
    sourcePath: "film.mkv",
    plan: plan(),
    segment: { index: 3, start: 12, duration: 4 },
  });
  assert.ok(args.includes("-copyts"), "without it every fragment claims to start at zero");
  assert.ok(args.includes("-avoid_negative_ts"), "copyts requires the shift to be disabled");
});

check("delay_moov is present — Dolby segments cannot be written without it", () => {
  const args = buildVodSegmentArgs({
    sourcePath: "film.mkv",
    plan: plan({ audio: [audio({ codec: "ac3" })] }),
    segment: { index: 0, start: 0, duration: 4 },
  });
  const movflags = args[args.indexOf("-movflags") + 1];
  assert.ok(movflags.includes("delay_moov"), movflags);
  assert.ok(movflags.includes("empty_moov"));
  assert.ok(movflags.includes("default_base_moof"));
  assert.equal(args[args.indexOf("-f") + 1], "mp4");
});

check("only the selected audio track is muxed, by explicit map", () => {
  const args = buildVodSegmentArgs({
    sourcePath: "film.mkv",
    plan: plan({
      audio: [audio({ streamIndex: 1 }), audio({ streamIndex: 2, language: "jpn", channels: 2 })],
      selectedAudioIndex: 2,
    }),
    segment: { index: 0, start: 0, duration: 4 },
  });
  assert.ok(args.includes("0:0"), "video mapped");
  assert.ok(args.includes("0:2"), "selected audio mapped");
  assert.ok(!args.includes("0:1"), "unselected audio must not be muxed");
});

check("a re-encoded audio track keeps its channel count", () => {
  const args = buildVodSegmentArgs({
    sourcePath: "film.mkv",
    plan: plan({
      rung: "transcode-audio",
      audio: [audio({ codec: "dts", action: "transcode", targetCodec: "eac3", channels: 6 })],
    }),
    segment: { index: 0, start: 0, duration: 4 },
  });
  assert.equal(args[args.indexOf("-c:a") + 1], "eac3");
  assert.equal(args[args.indexOf("-ac") + 1], "6", "5.1 must never become stereo");
});

check("a re-encoded video forces a keyframe on every segment boundary", () => {
  const args = buildVodSegmentArgs({
    sourcePath: "film.mkv",
    plan: plan({
      rung: "transcode-full",
      video: { codec: "mpeg2video", streamIndex: 0, action: "transcode", targetCodec: "libx264" },
    }),
    segment: { index: 5, start: 20, duration: 4 },
    segmentSeconds: VOD_SEGMENT_SECONDS,
  });
  assert.equal(
    args[args.indexOf("-force_key_frames") + 1],
    `expr:gte(t,n_forced*${VOD_SEGMENT_SECONDS})`,
  );
  assert.equal(args[args.indexOf("-sc_threshold") + 1], "0", "scene cuts must not move boundaries");
});

check("the hardware encoder is dropped on the software retry", () => {
  const encodePlan = plan({
    rung: "transcode-full",
    video: {
      codec: "vc1",
      streamIndex: 0,
      action: "transcode",
      targetCodec: "libx264",
      hwAccel: "h264_amf",
    },
  });
  const segment = { index: 0, start: 0, duration: 4 };
  const hw = buildVodSegmentArgs({ sourcePath: "f.mkv", plan: encodePlan, segment });
  const sw = buildVodSegmentArgs({
    sourcePath: "f.mkv",
    plan: encodePlan,
    segment,
    forceSoftware: true,
  });
  assert.equal(hw[hw.indexOf("-c:v") + 1], "h264_amf");
  assert.equal(sw[sw.indexOf("-c:v") + 1], "libx264");
});

check("HEVC copies carry the hvc1 tag browsers require", () => {
  const args = buildVodSegmentArgs({
    sourcePath: "film.mkv",
    plan: plan({ video: { codec: "hevc", streamIndex: 0, action: "copy" } }),
    segment: { index: 0, start: 0, duration: 4 },
  });
  assert.equal(args[args.indexOf("-tag:v") + 1], "hvc1");
});

// ── Whole-file ffmpeg arguments ──

console.log("\nwhole-file ffmpeg arguments");

check("whole-file output is a single-file VOD playlist, not a growing EVENT one", () => {
  const args = buildWholeFileHlsArgs({ sourcePath: "D:\\media\\film.mkv", plan: plan() });
  assert.equal(args[args.length - 1], WHOLE_FILE_PLAYLIST, "playlist is the output");
  assert.equal(
    args[args.indexOf("-hls_playlist_type") + 1],
    "vod",
    "EVENT is exactly what makes seeking stutter",
  );
  assert.equal(args[args.indexOf("-hls_segment_type") + 1], "fmp4");
  assert.equal(args[args.indexOf("-hls_list_size") + 1], "0", "every segment must be listed");
  assert.equal(args[args.indexOf("-hls_segment_filename") + 1], WHOLE_FILE_DATA);
});

check("single_file is on and temp_file is off", () => {
  const args = buildWholeFileHlsArgs({ sourcePath: "f.mkv", plan: plan() });
  const value = args[args.indexOf("-hls_flags") + 1];
  assert.ok(value.includes("single_file"), "one file on disk, not ~1800");
  assert.ok(value.includes("independent_segments"));
  assert.ok(
    !value.includes("temp_file"),
    "measured: with single_file, temp_file leaves data.m4s.tmp in every playlist URI",
  );
});

check("output filenames are relative — ffmpeg resolves them against its cwd", () => {
  const args = buildWholeFileHlsArgs({ sourcePath: "D:\\media\\film.mkv", plan: plan() });
  for (const name of [WHOLE_FILE_DATA, WHOLE_FILE_PLAYLIST]) {
    assert.ok(!name.includes(":") && !name.startsWith("/"), `${name} must be relative`);
    assert.ok(args.includes(name));
  }
});

check("whole-file always copies video — an encode here would take longer than the film", () => {
  const args = buildWholeFileHlsArgs({
    sourcePath: "film.mkv",
    plan: plan({ video: { codec: "hevc", streamIndex: 0, action: "copy" } }),
  });
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-tag:v") + 1], "hvc1");
});

check("whole-file re-encodes audio without downmixing", () => {
  const args = buildWholeFileHlsArgs({
    sourcePath: "film.mkv",
    plan: plan({
      rung: "transcode-audio",
      audio: [audio({ codec: "dts", action: "transcode", targetCodec: "eac3", channels: 8 })],
    }),
  });
  assert.equal(args[args.indexOf("-c:a") + 1], "eac3");
  assert.equal(args[args.indexOf("-ac") + 1], "8", "7.1 must survive the conversion");
});

check("subtitles and chapters are stripped from both paths", () => {
  for (const args of [
    buildWholeFileHlsArgs({ sourcePath: "a.mkv", plan: plan() }),
    buildVodSegmentArgs({
      sourcePath: "a.mkv",
      plan: plan(),
      segment: { index: 0, start: 0, duration: 4 },
    }),
  ]) {
    assert.ok(args.includes("-sn"), "image subtitles cannot be muxed into MP4");
    assert.equal(args[args.indexOf("-map_chapters") + 1], "-1");
  }
});

console.log(`\n${failures === 0 ? "vod: all tests passed" : `vod: ${failures} failing`}`);
process.exit(failures === 0 ? 0 : 1);
