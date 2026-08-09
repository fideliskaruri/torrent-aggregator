/**
 * Table-driven tests for ffmpeg argument construction.
 *
 * These args are the entire contract with ffmpeg, and every one of the
 * assertions below encodes a bug that was observed against real media rather
 * than a hypothetical:
 *   - relative HLS filenames (ffmpeg resolves the fMP4 init file against CWD,
 *     not against the segment path, so an absolute segment filename still
 *     scattered init.mp4 into the working directory and broke EXT-X-MAP);
 *   - explicit `-map` (without it ffmpeg silently keeps one audio stream and
 *     ignores per-output codec flags for the others);
 *   - `-c:v`/`-c:a` rather than `-c:a:N` (the plan carries *ffprobe* indexes,
 *     `-c:a:N` counts *output* audio streams — different index spaces);
 *   - `-ac <source channels>` on every transcode (never a downmix).
 */
import assert from "node:assert/strict";
import { buildFfmpegArgs, SEGMENT_SECONDS } from "./session";
import type { PlaybackPlan, AudioPlan } from "./decide";

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

const SRC = "http://127.0.0.1:3000/api/stream/abc/movie.mkv";

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
  const base: PlaybackPlan = {
    rung: "remux",
    reason: "test",
    container: "matroska",
    cost: 1,
    video: { codec: "hevc", streamIndex: 0, action: "copy" },
    audio: [audio()],
    selectedAudioIndex: 1,
  };
  return { ...base, ...overrides };
}

/** Value that follows `flag` in the arg list, or null. */
function valueOf(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** Every value that follows any occurrence of `flag`. */
function valuesOf(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag && i + 1 < args.length) out.push(args[i + 1]);
  });
  return out;
}

// ── HLS output shape (identical on every rung) ──

const shapeCases: Array<{ name: string; p: PlaybackPlan }> = [
  { name: "remux", p: plan() },
  {
    name: "transcode-audio",
    p: plan({
      rung: "transcode-audio",
      video: { codec: "h264", streamIndex: 0, action: "copy" },
      audio: [audio({ codec: "dts", action: "transcode", targetCodec: "eac3" })],
    }),
  },
  {
    name: "transcode-full",
    p: plan({
      rung: "transcode-full",
      video: { codec: "mpeg2video", streamIndex: 0, action: "transcode", targetCodec: "h264" },
      audio: [audio({ codec: "mp2", action: "transcode", targetCodec: "aac", channels: 2 })],
    }),
  },
];

for (const c of shapeCases) {
  check(`${c.name}: HLS output paths are relative to the session cwd`, () => {
    const args = buildFfmpegArgs({ sourceUrl: SRC, plan: c.p });
    assert.equal(valueOf(args, "-hls_segment_filename"), "seg%05d.m4s");
    assert.equal(valueOf(args, "-hls_fmp4_init_filename"), "init.mp4");
    assert.equal(args[args.length - 1], "playlist.m3u8");
    for (const a of args) {
      assert.ok(!/^[A-Za-z]:[\\/]/.test(a), `absolute path leaked into args: ${a}`);
    }
  });

  check(`${c.name}: emits an fMP4 HLS mux with a growing event playlist`, () => {
    const args = buildFfmpegArgs({ sourceUrl: SRC, plan: c.p });
    assert.equal(valueOf(args, "-f"), "hls");
    assert.equal(valueOf(args, "-hls_segment_type"), "fmp4");
    assert.equal(valueOf(args, "-hls_playlist_type"), "event");
    assert.equal(valueOf(args, "-hls_list_size"), "0");
    assert.equal(valueOf(args, "-hls_time"), String(SEGMENT_SECONDS));
  });

  check(`${c.name}: bounds a stalled source with -rw_timeout`, () => {
    const args = buildFfmpegArgs({ sourceUrl: SRC, plan: c.p });
    const rw = valueOf(args, "-rw_timeout");
    assert.ok(rw && Number(rw) > 0, "-rw_timeout must be set");
    assert.ok(args.indexOf("-rw_timeout") < args.indexOf("-i"), "-rw_timeout is an input option");
  });

  // A torrent-backed source is never a static file: the stream route caps an
  // open-ended `bytes=N-` at 8 MiB, and a swarm can drop a peer mid-response.
  // Without reconnect, ffmpeg calls the first short read "Stream ends
  // prematurely" and the session dies — which broke every file over the cap.
  check(`${c.name}: survives a short read by reconnecting, not by giving up`, () => {
    const args = buildFfmpegArgs({ sourceUrl: SRC, plan: c.p });
    for (const flag of ["-reconnect", "-reconnect_streamed", "-reconnect_on_network_error"]) {
      assert.equal(valueOf(args, flag), "1", `${flag} must be enabled`);
      assert.ok(args.indexOf(flag) < args.indexOf("-i"), `${flag} is an input option`);
    }
    const maxDelay = valueOf(args, "-reconnect_delay_max");
    assert.ok(
      maxDelay && Number(maxDelay) > 0 && Number(maxDelay) <= 15,
      "reconnect backoff must be bounded so the stall watchdog still gets its turn",
    );
    // At a genuine EOF the session is finished; retrying there would stop it
    // ever completing.
    assert.ok(!args.includes("-reconnect_at_eof"), "-reconnect_at_eof must not be set");
  });

  check(`${c.name}: drops subtitles rather than mis-muxing them`, () => {
    assert.ok(buildFfmpegArgs({ sourceUrl: SRC, plan: c.p }).includes("-sn"));
  });
}

check("local files never receive HTTP reconnect input options", () => {
  const localPath =
    "D:\\Torrents\\TV\\Rick And Morty\\Season 09\\Rick.and.Morty.S09E09.avi";
  const args = buildFfmpegArgs({ sourceUrl: localPath, plan: plan() });
  for (const flag of [
    "-rw_timeout",
    "-reconnect",
    "-reconnect_streamed",
    "-reconnect_on_network_error",
    "-reconnect_delay_max",
  ]) {
    assert.ok(!args.includes(flag), `${flag} is invalid for the file protocol`);
  }
  assert.equal(valueOf(args, "-analyzeduration"), "5000000");
  assert.equal(valueOf(args, "-probesize"), "10000000");
  assert.equal(valueOf(args, "-i"), localPath);
});

// ── Stream mapping ──

check("maps the planned video and selected audio stream explicitly", () => {
  const p = plan({
    video: { codec: "h264", streamIndex: 0, action: "copy" },
    audio: [
      audio({ streamIndex: 1, codec: "ac3", channels: 6, language: "eng" }),
      audio({ streamIndex: 2, codec: "aac", channels: 2, language: "jpn" }),
    ],
    selectedAudioIndex: 2,
  });
  assert.deepEqual(valuesOf(buildFfmpegArgs({ sourceUrl: SRC, plan: p }), "-map"), ["0:0", "0:2"]);
});

check("maps a non-zero video stream index (audio-first containers)", () => {
  const p = plan({ video: { codec: "h264", streamIndex: 2, action: "copy" }, audio: [audio({ streamIndex: 0 })], selectedAudioIndex: 0 });
  assert.deepEqual(valuesOf(buildFfmpegArgs({ sourceUrl: SRC, plan: p }), "-map"), ["0:2", "0:0"]);
});

check("uses -c:a, not -c:a:N — the plan carries ffprobe indexes", () => {
  const p = plan({
    audio: [
      audio({ streamIndex: 1, codec: "ac3" }),
      audio({ streamIndex: 5, codec: "dts", action: "transcode", targetCodec: "eac3" }),
    ],
    selectedAudioIndex: 5,
  });
  const args = buildFfmpegArgs({ sourceUrl: SRC, plan: p });
  assert.ok(!args.some((a) => /^-c:a:\d/.test(a)), "output-relative audio codec flags must not be used");
  assert.equal(valueOf(args, "-c:a"), "eac3");
});

check("no audio stream → -an, no -map for audio", () => {
  const args = buildFfmpegArgs({ sourceUrl: SRC, plan: plan({ audio: [], selectedAudioIndex: null }) });
  assert.ok(args.includes("-an"));
  assert.deepEqual(valuesOf(args, "-map"), ["0:0"]);
});

check("no video stream → -vn", () => {
  const args = buildFfmpegArgs({ sourceUrl: SRC, plan: plan({ video: null }) });
  assert.ok(args.includes("-vn"));
});

check("selectedAudioIndex pointing at a missing track falls back to -an", () => {
  const args = buildFfmpegArgs({ sourceUrl: SRC, plan: plan({ selectedAudioIndex: 99 }) });
  assert.ok(args.includes("-an"), "an unresolvable selection must not silently mux track 0");
});

// ── Channel preservation — the owner's hard rule ──

const channelCases: Array<{ name: string; codec: string; target: string; channels: number }> = [
  { name: "DTS 5.1 → E-AC-3 5.1", codec: "dts", target: "eac3", channels: 6 },
  { name: "TrueHD 7.1 → E-AC-3 7.1", codec: "truehd", target: "eac3", channels: 8 },
  { name: "DTS 5.1 → AAC 5.1 (no E-AC-3 support)", codec: "dts", target: "aac", channels: 6 },
  { name: "PCM stereo → AAC stereo", codec: "pcm", target: "aac", channels: 2 },
  { name: "mono stays mono", codec: "wmav2", target: "aac", channels: 1 },
];

for (const c of channelCases) {
  check(`never downmixes: ${c.name}`, () => {
    const p = plan({
      rung: "transcode-audio",
      audio: [audio({ codec: c.codec, action: "transcode", targetCodec: c.target, channels: c.channels })],
    });
    const args = buildFfmpegArgs({ sourceUrl: SRC, plan: p });
    assert.equal(valueOf(args, "-c:a"), c.target);
    assert.equal(valueOf(args, "-ac"), String(c.channels), "channel count must be carried through verbatim");
    const bitrate = valueOf(args, "-b:a");
    assert.ok(bitrate && Number.parseInt(bitrate, 10) >= 64 * c.channels, `bitrate ${bitrate} too low for ${c.channels}ch`);
  });
}

check("multichannel AAC gets -strict -2 (the native encoder refuses otherwise)", () => {
  const p = plan({ audio: [audio({ action: "transcode", targetCodec: "aac", channels: 6 })] });
  const args = buildFfmpegArgs({ sourceUrl: SRC, plan: p });
  assert.equal(valueOf(args, "-strict"), "-2");
});

check("stereo AAC does not need -strict", () => {
  const p = plan({ audio: [audio({ action: "transcode", targetCodec: "aac", channels: 2 })] });
  assert.ok(!buildFfmpegArgs({ sourceUrl: SRC, plan: p }).includes("-strict"));
});

check("copied audio is never given -ac", () => {
  const args = buildFfmpegArgs({ sourceUrl: SRC, plan: plan() });
  assert.equal(valueOf(args, "-c:a"), "copy");
  assert.ok(!args.includes("-ac"));
});

// ── HEVC tagging ──

check("copied HEVC is retagged hvc1", () => {
  const args = buildFfmpegArgs({ sourceUrl: SRC, plan: plan() });
  assert.equal(valueOf(args, "-tag:v"), "hvc1");
});

check("copied H.264 is not retagged", () => {
  const p = plan({ video: { codec: "h264", streamIndex: 0, action: "copy" } });
  assert.ok(!buildFfmpegArgs({ sourceUrl: SRC, plan: p }).includes("-tag:v"));
});

// ── Encoder selection ──

const encoderCases: Array<{
  name: string;
  hwAccel?: string;
  targetCodec: string;
  forceSoftware?: boolean;
  encoder: string;
  mustHave: string[];
  mustNotHave: string[];
}> = [
  {
    name: "software H.264",
    targetCodec: "h264",
    encoder: "libx264",
    mustHave: ["-preset", "-crf"],
    mustNotHave: ["-quality", "-rc"],
  },
  {
    name: "software HEVC",
    targetCodec: "hevc",
    encoder: "libx265",
    mustHave: ["-preset", "-crf"],
    mustNotHave: ["-quality"],
  },
  {
    // AMF has its own rate control; -crf is a libx26x concept it does not honour.
    name: "AMD AMF",
    hwAccel: "h264_amf",
    targetCodec: "h264",
    encoder: "h264_amf",
    mustHave: ["-quality", "-rc", "-b:v"],
    mustNotHave: ["-crf"],
  },
  {
    name: "NVENC",
    hwAccel: "h264_nvenc",
    targetCodec: "h264",
    encoder: "h264_nvenc",
    mustHave: ["-preset", "-rc", "-cq"],
    mustNotHave: ["-crf"],
  },
  {
    name: "QSV",
    hwAccel: "h264_qsv",
    targetCodec: "h264",
    encoder: "h264_qsv",
    mustHave: ["-preset", "-global_quality"],
    mustNotHave: ["-crf"],
  },
  {
    name: "hardware falls back to software on retry",
    hwAccel: "h264_amf",
    targetCodec: "h264",
    forceSoftware: true,
    encoder: "libx264",
    mustHave: ["-crf"],
    mustNotHave: ["-quality"],
  },
];

for (const c of encoderCases) {
  check(`encoder args: ${c.name} → ${c.encoder}`, () => {
    const p = plan({
      rung: "transcode-full",
      video: { codec: "mpeg2video", streamIndex: 0, action: "transcode", targetCodec: c.targetCodec, hwAccel: c.hwAccel },
    });
    const args = buildFfmpegArgs({ sourceUrl: SRC, plan: p, forceSoftware: c.forceSoftware });
    assert.equal(valueOf(args, "-c:v"), c.encoder);
    for (const flag of c.mustHave) assert.ok(args.includes(flag), `expected ${flag}`);
    for (const flag of c.mustNotHave) assert.ok(!args.includes(flag), `unexpected ${flag}`);
  });
}

check("re-encoded video gets a fixed GOP so segments land on keyframes", () => {
  const p = plan({
    rung: "transcode-full",
    video: { codec: "vc1", streamIndex: 0, action: "transcode", targetCodec: "h264" },
  });
  const args = buildFfmpegArgs({ sourceUrl: SRC, plan: p });
  assert.equal(valueOf(args, "-g"), "60");
  assert.equal(valueOf(args, "-keyint_min"), "60");
  assert.equal(valueOf(args, "-sc_threshold"), "0");
  assert.equal(valueOf(args, "-pix_fmt"), "yuv420p");
});

// ── Seeking ──

const seekCases: Array<{ name: string; startSec: number | undefined; expected: string | null }> = [
  { name: "no offset", startSec: undefined, expected: null },
  { name: "zero offset", startSec: 0, expected: null },
  { name: "whole seconds", startSec: 42, expected: "42" },
  { name: "fractional offsets are floored", startSec: 42.9, expected: "42" },
  { name: "negative offsets are clamped to the start", startSec: -10, expected: null },
];

for (const c of seekCases) {
  check(`seek: ${c.name}`, () => {
    const args = buildFfmpegArgs({ sourceUrl: SRC, plan: plan(), startSec: c.startSec });
    assert.equal(valueOf(args, "-ss"), c.expected);
  });
}

check("seek uses input seeking (-ss before -i), the only fast form", () => {
  const args = buildFfmpegArgs({ sourceUrl: SRC, plan: plan(), startSec: 30 });
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss must precede -i or ffmpeg decodes from zero");
});

check("the source URL is passed as the input, untouched", () => {
  const url = "http://127.0.0.1:4321/api/stream/abc/My%20Movie%20(2024).mkv";
  assert.equal(valueOf(buildFfmpegArgs({ sourceUrl: url, plan: plan() }), "-i"), url);
});

if (failures > 0) {
  console.error(`\nFAIL — ${failures} session test(s) failed`);
  process.exit(1);
}
console.log("\nPASS — all session tests passed.");
