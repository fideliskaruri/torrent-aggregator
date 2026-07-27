/**
 * Tests for probe.ts — parsing ffprobe JSON output.
 *
 * These exercise parseProbeOutput (the pure parser) directly, so they do not
 * need ffprobe installed or a running torrent engine. The goal is to verify
 * that every field the decision engine needs is correctly extracted from the
 * diverse JSON shapes ffprobe emits for different containers and codecs.
 */
import assert from "node:assert/strict";
import {
  parseProbeOutput,
  normalizeCodecName,
  normalizeContainer,
  videoStream,
  primaryAudioStream,
  audioStreams,
  isHDR,
  streamUrl,
  requestOrigin,
  type ProbeResult,
} from "./probe";

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

// ── Sample ffprobe outputs ──

const H264_AAC_MP4 = JSON.stringify({
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "7200.123" },
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      profile: "High",
      width: 1920,
      height: 1080,
      color_transfer: "bt709",
      color_primaries: "bt709",
      bit_rate: "5000000",
      tags: { language: "eng" },
    },
    {
      index: 1,
      codec_type: "audio",
      codec_name: "aac",
      profile: "LC",
      channels: 2,
      channel_layout: "stereo",
      sample_rate: "48000",
      bit_rate: "128000",
      tags: { language: "eng", title: "Stereo" },
    },
  ],
});

const HEVC_HDR_DTS_MKV = JSON.stringify({
  format: { format_name: "matroska,webm", duration: "5400.000" },
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "hevc",
      profile: "Main 10",
      width: 3840,
      height: 2160,
      color_transfer: "smpte2084",
      color_primaries: "bt2020",
      bit_rate: "25000000",
    },
    {
      index: 1,
      codec_type: "audio",
      codec_name: "dts",
      channels: 6,
      channel_layout: "5.1",
      sample_rate: "48000",
      bit_rate: "1536000",
      tags: { language: "eng", title: "DTS-HD MA 5.1" },
    },
    {
      index: 2,
      codec_type: "audio",
      codec_name: "aac",
      channels: 2,
      channel_layout: "stereo",
      sample_rate: "48000",
      tags: { language: "jpn" },
    },
    {
      index: 3,
      codec_type: "subtitle",
      codec_name: "subrip",
      tags: { language: "eng", title: "English" },
    },
  ],
});

const MULTI_AUDIO_BLURAY = JSON.stringify({
  format: { format_name: "matroska,webm", duration: "8100.500" },
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "vc1",
      profile: "Advanced",
      width: 1920,
      height: 1080,
    },
    {
      index: 1,
      codec_type: "audio",
      codec_name: "truehd",
      channels: 8,
      channel_layout: "7.1",
      tags: { language: "eng", title: "TrueHD 7.1" },
    },
    {
      index: 2,
      codec_type: "audio",
      codec_name: "pcm_bluray",
      channels: 2,
      tags: { language: "eng", title: "Commentary" },
    },
  ],
});

const EMPTY_STREAMS = JSON.stringify({
  format: { format_name: "matroska,webm" },
  streams: [],
});

const NO_STREAMS_KEY = JSON.stringify({
  format: { format_name: "mp4" },
});

const CORRUPT_JSON = "not json at all {{{";

const MINIMAL_STREAM = JSON.stringify({
  format: {},
  streams: [{ codec_type: "video", codec_name: "h264" }],
});

async function main() {
  console.log("probe.test.ts — ffprobe output parsing\n");

  // ── parseProbeOutput ──

  await check("parses H.264 + AAC MP4 correctly", () => {
    const result = parseProbeOutput(H264_AAC_MP4);
    assert.ok(result.ok, "Should succeed");
    const r = result.result;
    assert.ok(r.container.includes("mov") || r.container.includes("mp4"));
    assert.equal(r.duration, 7200.123);
    assert.equal(r.streams.length, 2);

    const v = videoStream(r)!;
    assert.equal(v.codec, "h264");
    assert.equal(v.profile, "High");
    assert.equal(v.width, 1920);
    assert.equal(v.height, 1080);
    assert.equal(v.language, "eng");

    const a = primaryAudioStream(r)!;
    assert.equal(a.codec, "aac");
    assert.equal(a.channels, 2);
    assert.equal(a.channelLayout, "stereo");
    assert.equal(a.language, "eng");
    assert.equal(a.title, "Stereo");
  });

  await check("parses HEVC HDR + DTS MKV with multiple audio and subtitles", () => {
    const result = parseProbeOutput(HEVC_HDR_DTS_MKV);
    assert.ok(result.ok);
    const r = result.result;
    assert.equal(r.duration, 5400);
    assert.ok(r.container.includes("matroska"));

    const v = videoStream(r)!;
    assert.equal(v.codec, "hevc");
    assert.equal(v.profile, "Main 10");
    assert.equal(v.width, 3840);
    assert.equal(v.height, 2160);
    assert.equal(v.colorTransfer, "smpte2084");
    assert.ok(isHDR(v), "Should detect HDR10 via smpte2084");

    const allAudio = audioStreams(r);
    assert.equal(allAudio.length, 2);
    assert.equal(allAudio[0].codec, "dts");
    assert.equal(allAudio[0].channels, 6);
    assert.equal(allAudio[0].language, "eng");
    assert.equal(allAudio[1].codec, "aac");
    assert.equal(allAudio[1].channels, 2);
    assert.equal(allAudio[1].language, "jpn");

    const subs = r.streams.filter((s) => s.codecType === "subtitle");
    assert.equal(subs.length, 1);
    assert.equal(subs[0].codec, "subrip");
  });

  await check("parses Bluray VC-1 + TrueHD + PCM", () => {
    const result = parseProbeOutput(MULTI_AUDIO_BLURAY);
    assert.ok(result.ok);
    const r = result.result;

    const v = videoStream(r)!;
    assert.equal(v.codec, "vc1");
    assert.equal(v.profile, "Advanced");

    const allAudio = audioStreams(r);
    assert.equal(allAudio.length, 2);
    assert.equal(allAudio[0].codec, "truehd");
    assert.equal(allAudio[0].channels, 8);
    assert.equal(allAudio[0].channelLayout, "7.1");
    assert.equal(allAudio[1].codec, "pcm");
    assert.equal(allAudio[1].channels, 2);
  });

  await check("empty streams array returns no_streams error", () => {
    const result = parseProbeOutput(EMPTY_STREAMS);
    assert.ok(!result.ok);
    assert.equal(result.error.error, "no_streams");
  });

  await check("missing streams key returns no_streams error", () => {
    const result = parseProbeOutput(NO_STREAMS_KEY);
    assert.ok(!result.ok);
    assert.equal(result.error.error, "no_streams");
  });

  await check("corrupt JSON returns probe_failed error", () => {
    const result = parseProbeOutput(CORRUPT_JSON);
    assert.ok(!result.ok);
    assert.equal(result.error.error, "probe_failed");
  });

  await check("minimal stream with missing optional fields", () => {
    const result = parseProbeOutput(MINIMAL_STREAM);
    assert.ok(result.ok);
    const r = result.result;
    assert.equal(r.duration, null);
    const v = videoStream(r)!;
    assert.equal(v.codec, "h264");
    assert.equal(v.width, null);
    assert.equal(v.height, null);
    assert.equal(v.profile, null);
    assert.equal(v.language, null);
  });

  // ── normalizeCodecName ──

  await check("normalizeCodecName handles all known codecs", () => {
    const expectations: [string, string][] = [
      ["h264", "h264"],
      ["H264", "h264"],
      ["avc", "h264"],
      ["avc1", "h264"],
      ["hevc", "hevc"],
      ["h265", "hevc"],
      ["hvc1", "hevc"],
      ["hev1", "hevc"],
      ["av1", "av1"],
      ["vp9", "vp9"],
      ["mpeg2video", "mpeg2"],
      ["vc1", "vc1"],
      ["wmv3", "wmv3"],
      ["aac", "aac"],
      ["ac3", "ac3"],
      ["ac-3", "ac3"],
      ["eac3", "eac3"],
      ["dts", "dts"],
      ["dca", "dts"],
      ["truehd", "truehd"],
      ["mlp", "truehd"],
      ["opus", "opus"],
      ["flac", "flac"],
      ["pcm_s16le", "pcm"],
      ["pcm_bluray", "pcm"],
      ["mp3", "mp3"],
      ["mp2", "mp2"],
      ["unknown_codec", "unknown_codec"],
    ];
    for (const [input, expected] of expectations) {
      assert.equal(normalizeCodecName(input), expected, `normalizeCodecName("${input}") should be "${expected}"`);
    }
  });

  // ── normalizeContainer ──

  await check("normalizeContainer handles diverse format names", () => {
    const expectations: [string, string][] = [
      ["matroska,webm", "matroska"],
      ["mov,mp4,m4a,3gp,3g2,mj2", "mp4"],
      ["mpegts", "mpegts"],
      ["avi", "avi"],
      ["asf", "asf"],
      ["ogg", "ogg"],
      ["webm", "webm"],
      ["unknown", "unknown"],
    ];
    for (const [input, expected] of expectations) {
      assert.equal(normalizeContainer(input), expected, `normalizeContainer("${input}") should be "${expected}"`);
    }
  });

  // ── isHDR ──

  await check("isHDR detects HDR10, HLG, and SDR correctly", () => {
    const hdr10 = { colorTransfer: "smpte2084" } as unknown as import("./probe").ProbeStream;
    const hlg = { colorTransfer: "arib-std-b67" } as unknown as import("./probe").ProbeStream;
    const sdr = { colorTransfer: "bt709" } as unknown as import("./probe").ProbeStream;
    const none = { colorTransfer: null } as unknown as import("./probe").ProbeStream;

    assert.ok(isHDR(hdr10), "smpte2084 is HDR10");
    assert.ok(isHDR(hlg), "arib-std-b67 is HLG");
    assert.ok(!isHDR(sdr), "bt709 is SDR");
    assert.ok(!isHDR(none), "null is not HDR");
  });

  // ── streamUrl ──

  await check("streamUrl encodes paths correctly", () => {
    const url = streamUrl("abc123", "Movies/My Movie (2024)/file.mkv", "http://127.0.0.1:3000");
    assert.ok(url.includes("abc123"));
    assert.ok(url.includes("Movies"));
    assert.ok(url.includes("My%20Movie%20(2024)"));
    assert.ok(url.includes("file.mkv"));
    assert.ok(url.startsWith("http://127.0.0.1:3000"));
  });

  await check("streamUrl honours a non-default origin", () => {
    const url = streamUrl("abc123", "a.mkv", "https://box.lan:8443");
    assert.ok(url.startsWith("https://box.lan:8443/api/stream/abc123/"), url);
  });

  // ── requestOrigin ──

  const originCases: Array<{ name: string; url: string; headers: Record<string, string>; expected: string }> = [
    {
      name: "prefers x-forwarded-host + x-forwarded-proto",
      url: "http://127.0.0.1:3000/api/playback/plan",
      headers: { host: "127.0.0.1:3000", "x-forwarded-host": "flow.example.com", "x-forwarded-proto": "https" },
      expected: "https://flow.example.com",
    },
    {
      name: "falls back to host header",
      url: "http://127.0.0.1:3000/api/playback/plan",
      headers: { host: "192.168.1.50:4321" },
      expected: "http://192.168.1.50:4321",
    },
    {
      name: "uses the request URL when no host header is present",
      url: "http://localhost:7777/api/playback/plan",
      headers: {},
      expected: "http://localhost:7777",
    },
    {
      name: "takes the first entry of a comma-joined forwarded host",
      url: "http://127.0.0.1:3000/x",
      headers: { "x-forwarded-host": "a.example.com, b.example.com", "x-forwarded-proto": "https, http" },
      expected: "https://a.example.com",
    },
  ];

  for (const c of originCases) {
    await check(`requestOrigin ${c.name}`, () => {
      const headers = new Headers(c.headers);
      assert.equal(requestOrigin({ url: c.url, headers }), c.expected);
    });
  }
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} probe test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll probe tests passed.");
});
