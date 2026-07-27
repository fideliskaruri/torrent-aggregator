/**
 * Table-driven tests for the playback decision engine.
 *
 * Every case asserts the chosen rung AND that channel count is never reduced.
 * The rule class: any combination of container × video codec × audio codec ×
 * browser capabilities must select the cheapest rung that actually works.
 */
import assert from "node:assert/strict";
import type { ProbeResult, ProbeStream } from "./probe";
import type { ClientCapabilities, CodecEntry } from "./capabilities";
import { DEFAULT_CAPABILITIES } from "./capabilities";
import { decidePlayback, type PlaybackPlan, type PlaybackRung } from "./decide";

// ── Helpers ──

function makeStream(overrides: Partial<ProbeStream> & { codecType: string; codec: string }): ProbeStream {
  return {
    index: 0,
    profile: null,
    pixFmt: null,
    width: null,
    height: null,
    colorTransfer: null,
    colorPrimaries: null,
    channels: null,
    channelLayout: null,
    language: null,
    title: null,
    bitRate: null,
    sampleRate: null,
    ...overrides,
  };
}

function makeProbe(opts: {
  container: string;
  video?: Partial<ProbeStream>;
  audio?: Partial<ProbeStream> | Partial<ProbeStream>[];
  subtitle?: Partial<ProbeStream>;
  duration?: number | null;
}): ProbeResult {
  const streams: ProbeStream[] = [];
  let idx = 0;
  if (opts.video) {
    streams.push(makeStream({
      codecType: "video",
      codec: opts.video.codec ?? "h264",
      index: idx++,
      width: opts.video.width ?? 1920,
      height: opts.video.height ?? 1080,
      ...opts.video,
    }));
  }
  const audioArr = opts.audio
    ? Array.isArray(opts.audio) ? opts.audio : [opts.audio]
    : [];
  for (const a of audioArr) {
    streams.push(makeStream({
      codecType: "audio",
      codec: a.codec ?? "aac",
      index: idx++,
      channels: a.channels ?? 2,
      ...a,
    }));
  }
  if (opts.subtitle) {
    streams.push(makeStream({
      codecType: "subtitle",
      codec: opts.subtitle.codec ?? "subrip",
      index: idx++,
      ...opts.subtitle,
    }));
  }
  return {
    container: opts.container,
    duration: opts.duration ?? 5400,
    streams,
  };
}

/**
 * Full Chromium/Edge on Windows capabilities — matches the real probe output.
 * Supports H.264, HEVC, AV1, VP9, AAC, AC-3, E-AC-3, FLAC, Opus.
 */
const EDGE_CAPS: ClientCapabilities = {
  ua: "Mozilla/5.0 Edge/150",
  codecs: [
    { mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="avc1.640028,ac-3"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="avc1.640028,ec-3"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="avc1.640028"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="hvc1.1.6.L93.B0"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="hev1.1.6.L93.B0"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="hvc1.2.4.L120.B0"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="hvc1.1.6.L93.B0,ac-3"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="av01.0.05M.08"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="vp09.00.10.08"', canPlay: "probably", mse: true },
    { mime: 'video/webm; codecs="vp9,opus"', canPlay: "probably", mse: true },
    { mime: 'audio/mp4; codecs="mp4a.40.2"', canPlay: "probably", mse: true },
    { mime: 'audio/mp4; codecs="flac"', canPlay: "probably", mse: true },
    { mime: 'audio/mp4; codecs="ac-3"', canPlay: "probably", mse: true },
    { mime: 'audio/mp4; codecs="ec-3"', canPlay: "probably", mse: true },
    // MKV under MSE — NOT supported (this is the key blocker)
    { mime: 'video/x-matroska; codecs="avc1.640028,mp4a.40.2"', canPlay: "", mse: false },
  ],
  mseSupported: true,
};

/** Minimal capabilities — only H.264 + AAC in MP4. */
const MINIMAL_CAPS: ClientCapabilities = {
  codecs: [
    { mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"', canPlay: "probably", mse: true },
    { mime: 'video/mp4; codecs="avc1.640028"', canPlay: "probably", mse: true },
    { mime: 'audio/mp4; codecs="mp4a.40.2"', canPlay: "probably", mse: true },
  ],
  mseSupported: true,
};

// ── Test cases ──

type TestCase = {
  name: string;
  probe: ProbeResult;
  caps: ClientCapabilities;
  expectedRung: PlaybackRung;
  /** If set, verify these audio channels are preserved */
  expectChannels?: number[];
  /** If set, verify audio target codec */
  expectAudioTarget?: string;
  /** Verify no audio plans exist (for no-audio files) */
  expectNoAudio?: boolean;
};

const cases: TestCase[] = [
  // ── Direct play cases ──
  {
    name: "H.264 + AAC in MP4 → direct",
    probe: makeProbe({ container: "mp4", video: { codec: "h264" }, audio: { codec: "aac", channels: 2 } }),
    caps: EDGE_CAPS,
    expectedRung: "direct",
    expectChannels: [2],
  },
  {
    name: "H.264 + AAC 5.1 in MP4 → direct",
    probe: makeProbe({ container: "mp4", video: { codec: "h264" }, audio: { codec: "aac", channels: 6 } }),
    caps: EDGE_CAPS,
    expectedRung: "direct",
    expectChannels: [6],
  },
  {
    name: "H.264 + AC-3 5.1 in MP4 → direct (Edge supports AC-3)",
    probe: makeProbe({ container: "mp4", video: { codec: "h264" }, audio: { codec: "ac3", channels: 6 } }),
    caps: EDGE_CAPS,
    expectedRung: "direct",
    expectChannels: [6],
  },
  {
    name: "HEVC Main + E-AC-3 5.1 in MP4 → direct",
    probe: makeProbe({ container: "mp4", video: { codec: "hevc" }, audio: { codec: "eac3", channels: 6 } }),
    caps: EDGE_CAPS,
    expectedRung: "direct",
    expectChannels: [6],
  },
  {
    name: "AV1 + Opus in WebM → direct",
    probe: makeProbe({ container: "webm", video: { codec: "av1" }, audio: { codec: "opus", channels: 2 } }),
    caps: EDGE_CAPS,
    expectedRung: "direct",
    expectChannels: [2],
  },

  // ── Remux cases (the dominant MKV scenario) ──
  {
    name: "H.264 + AAC in MKV → remux (container is the problem)",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "aac", channels: 2 } }),
    caps: EDGE_CAPS,
    expectedRung: "remux",
    expectChannels: [2],
  },
  {
    name: "HEVC Main10 HDR + E-AC-3 5.1 in MKV → remux",
    probe: makeProbe({
      container: "matroska,webm",
      video: { codec: "hevc", profile: "Main 10", colorTransfer: "smpte2084", width: 3840, height: 2160 },
      audio: { codec: "eac3", channels: 6, channelLayout: "5.1" },
    }),
    caps: EDGE_CAPS,
    expectedRung: "remux",
    expectChannels: [6],
  },
  {
    name: "VP9 + Opus in MKV → remux",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "vp9" }, audio: { codec: "opus", channels: 2 } }),
    caps: EDGE_CAPS,
    expectedRung: "remux",
    expectChannels: [2],
  },
  {
    name: "HEVC + AAC in MKV → remux",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "hevc" }, audio: { codec: "aac", channels: 2 } }),
    caps: EDGE_CAPS,
    expectedRung: "remux",
    expectChannels: [2],
  },
  {
    name: "H.264 + FLAC in MKV → remux (FLAC is browser-supported)",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "flac", channels: 2 } }),
    caps: EDGE_CAPS,
    expectedRung: "remux",
    expectChannels: [2],
  },

  // ── Transcode-audio cases ──
  {
    name: "HEVC + DTS-HD 5.1 in MKV → transcode-audio (DTS unsupported, video fine)",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "hevc" }, audio: { codec: "dts", channels: 6, channelLayout: "5.1" } }),
    caps: EDGE_CAPS,
    expectedRung: "transcode-audio",
    expectChannels: [6],
    expectAudioTarget: "eac3",
  },
  {
    name: "H.264 + TrueHD 7.1 → transcode-audio (preserve 8 channels)",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "truehd", channels: 8, channelLayout: "7.1" } }),
    caps: EDGE_CAPS,
    expectedRung: "transcode-audio",
    expectChannels: [8],
    expectAudioTarget: "eac3",
  },
  {
    name: "H.264 + DTS stereo in MKV → transcode-audio (DTS never plays)",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "dts", channels: 2 } }),
    caps: EDGE_CAPS,
    expectedRung: "transcode-audio",
    expectChannels: [2],
    expectAudioTarget: "aac",
  },
  {
    name: "H.264 + TrueHD 7.1 with minimal caps → transcode-audio, falls back to AAC",
    probe: makeProbe({ container: "mp4", video: { codec: "h264" }, audio: { codec: "truehd", channels: 8 } }),
    caps: MINIMAL_CAPS,
    expectedRung: "transcode-audio",
    expectChannels: [8],
    expectAudioTarget: "aac",
  },
  {
    name: "H.264 + PCM Bluray audio → transcode-audio (PCM not browser-playable)",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "pcm", channels: 6, channelLayout: "5.1" } }),
    caps: EDGE_CAPS,
    expectedRung: "transcode-audio",
    expectChannels: [6],
    expectAudioTarget: "eac3",
  },
  {
    name: "HEVC + DTS 5.1 in MP4 → transcode-audio (container fine, audio not)",
    probe: makeProbe({ container: "mp4", video: { codec: "hevc" }, audio: { codec: "dts", channels: 6 } }),
    caps: EDGE_CAPS,
    expectedRung: "transcode-audio",
    expectChannels: [6],
    expectAudioTarget: "eac3",
  },

  // ── Full transcode cases ──
  {
    name: "VC-1 + PCM from Bluray → transcode-full",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "vc1" }, audio: { codec: "pcm", channels: 6 } }),
    caps: EDGE_CAPS,
    expectedRung: "transcode-full",
    expectChannels: [6],
  },
  {
    name: "MPEG-2 + MP2 → transcode-full",
    probe: makeProbe({ container: "mpegts", video: { codec: "mpeg2" }, audio: { codec: "mp2", channels: 2 } }),
    caps: EDGE_CAPS,
    expectedRung: "transcode-full",
    expectChannels: [2],
  },
  {
    name: "WMV3 + WMA in AVI → transcode-full",
    probe: makeProbe({ container: "avi", video: { codec: "wmv3" }, audio: { codec: "wmapro", channels: 6 } }),
    caps: EDGE_CAPS,
    expectedRung: "transcode-full",
    expectChannels: [6],
  },
  {
    name: "HEVC + AAC in MKV with minimal caps (no HEVC support) → transcode-full",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "hevc" }, audio: { codec: "aac", channels: 2 } }),
    caps: MINIMAL_CAPS,
    expectedRung: "transcode-full",
    expectChannels: [2],
  },

  // ── Edge cases ──
  {
    name: "File with no audio stream → video remux only",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "h264" } }),
    caps: EDGE_CAPS,
    expectedRung: "remux",
    expectNoAudio: true,
  },
  {
    name: "H.264 no-audio in MP4 → direct",
    probe: makeProbe({ container: "mp4", video: { codec: "h264" } }),
    caps: EDGE_CAPS,
    expectedRung: "direct",
    expectNoAudio: true,
  },
  {
    name: "Multiple audio tracks in different languages — channels preserved for all",
    probe: makeProbe({
      container: "matroska,webm",
      video: { codec: "hevc" },
      audio: [
        { codec: "dts", channels: 6, language: "eng", channelLayout: "5.1" },
        { codec: "aac", channels: 2, language: "jpn" },
        { codec: "truehd", channels: 8, language: "eng", channelLayout: "7.1" },
      ],
    }),
    caps: EDGE_CAPS,
    expectedRung: "transcode-audio",
    expectChannels: [6, 2, 8],
  },
  {
    name: "Unknown/corrupt probe with only a subtitle stream",
    probe: {
      container: "unknown",
      duration: null,
      streams: [makeStream({ codecType: "subtitle", codec: "subrip", index: 0 })],
    },
    caps: EDGE_CAPS,
    expectedRung: "direct",
    expectNoAudio: true,
  },
  {
    name: "VP9 + Opus in WebM with minimal caps (no VP9) → transcode-full",
    probe: makeProbe({ container: "webm", video: { codec: "vp9" }, audio: { codec: "opus", channels: 2 } }),
    caps: MINIMAL_CAPS,
    expectedRung: "transcode-full",
    expectChannels: [2],
  },
  {
    name: "H.264 + MP2 audio in MPEG-TS → transcode-audio (MP2 unsupported)",
    probe: makeProbe({ container: "mpegts", video: { codec: "h264" }, audio: { codec: "mp2", channels: 2 } }),
    caps: EDGE_CAPS,
    expectedRung: "transcode-audio",
    expectChannels: [2],
  },
  {
    name: "HEVC HLG + AAC in MKV → remux (HLG is just a color transfer, codec fine)",
    probe: makeProbe({
      container: "matroska,webm",
      video: { codec: "hevc", colorTransfer: "arib-std-b67" },
      audio: { codec: "aac", channels: 2 },
    }),
    caps: EDGE_CAPS,
    expectedRung: "remux",
    expectChannels: [2],
  },
  {
    name: "AV1 + EAC3 5.1 in MKV → remux (both codecs fine, container not)",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "av1" }, audio: { codec: "eac3", channels: 6 } }),
    caps: EDGE_CAPS,
    expectedRung: "remux",
    expectChannels: [6],
  },
  {
    name: "H.264 + AC-3 5.1 in MKV → remux (AC-3 supported on Edge)",
    probe: makeProbe({ container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "ac3", channels: 6 } }),
    caps: EDGE_CAPS,
    expectedRung: "remux",
    expectChannels: [6],
  },
];

// ── Runner ──

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

async function main() {
  console.log("decide.test.ts — playback decision table\n");

  for (const tc of cases) {
    await check(tc.name, () => {
      const plan = decidePlayback(tc.probe, tc.caps);

      // Assert correct rung
      assert.equal(
        plan.rung,
        tc.expectedRung,
        `Expected rung "${tc.expectedRung}" but got "${plan.rung}" (reason: ${plan.reason})`,
      );

      // Assert channel count is NEVER reduced
      if (tc.expectChannels) {
        assert.equal(
          plan.audio.length,
          tc.expectChannels.length,
          `Expected ${tc.expectChannels.length} audio plan(s) but got ${plan.audio.length}`,
        );
        for (let i = 0; i < tc.expectChannels.length; i++) {
          assert.equal(
            plan.audio[i].channels,
            tc.expectChannels[i],
            `Audio stream ${i}: expected ${tc.expectChannels[i]} channels, got ${plan.audio[i].channels}`,
          );
        }
      }

      // Assert audio target codec when specified
      if (tc.expectAudioTarget) {
        const transcoded = plan.audio.filter((a) => a.action === "transcode");
        assert.ok(transcoded.length > 0, "Expected at least one transcoded audio stream");
        for (const a of transcoded) {
          assert.equal(
            a.targetCodec,
            tc.expectAudioTarget,
            `Expected audio target "${tc.expectAudioTarget}" but got "${a.targetCodec}"`,
          );
        }
      }

      // Assert no audio when expected
      if (tc.expectNoAudio) {
        assert.equal(plan.audio.length, 0, `Expected no audio plans but got ${plan.audio.length}`);
      }

      // Global invariant: channel count in plan must match probe for every stream
      const audioStreams = tc.probe.streams.filter((s) => s.codecType === "audio");
      for (let i = 0; i < plan.audio.length; i++) {
        const probeChannels = audioStreams[i]?.channels ?? 2;
        assert.equal(
          plan.audio[i].channels,
          probeChannels,
          `Channel count reduced! Stream ${i}: probe had ${probeChannels}, plan has ${plan.audio[i].channels}`,
        );
      }
    });
  }

  // Additional structural assertions
  await check("decidePlayback is a pure function (no side effects)", () => {
    const probe = makeProbe({ container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "aac", channels: 2 } });
    const plan1 = decidePlayback(probe, EDGE_CAPS);
    const plan2 = decidePlayback(probe, EDGE_CAPS);
    assert.deepEqual(plan1, plan2, "Same inputs must produce identical outputs");
  });

  await check("cost ordering is consistent: direct < remux < transcode-audio < transcode-full", () => {
    const directProbe = makeProbe({ container: "mp4", video: { codec: "h264" }, audio: { codec: "aac", channels: 2 } });
    const remuxProbe = makeProbe({ container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "aac", channels: 2 } });
    const audioProbe = makeProbe({ container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "dts", channels: 6 } });
    const fullProbe = makeProbe({ container: "matroska,webm", video: { codec: "vc1" }, audio: { codec: "pcm", channels: 6 } });

    const d = decidePlayback(directProbe, EDGE_CAPS);
    const r = decidePlayback(remuxProbe, EDGE_CAPS);
    const a = decidePlayback(audioProbe, EDGE_CAPS);
    const f = decidePlayback(fullProbe, EDGE_CAPS);

    assert.ok(d.cost < r.cost, `direct cost ${d.cost} should be < remux cost ${r.cost}`);
    assert.ok(r.cost < a.cost, `remux cost ${r.cost} should be < transcode-audio cost ${a.cost}`);
    assert.ok(a.cost < f.cost, `transcode-audio cost ${a.cost} should be < transcode-full cost ${f.cost}`);
  });

  await check("DEFAULT_CAPABILITIES gives a valid plan for common content", () => {
    const probe = makeProbe({ container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "aac", channels: 2 } });
    const plan = decidePlayback(probe, DEFAULT_CAPABILITIES);
    assert.ok(["direct", "remux", "transcode-audio", "transcode-full"].includes(plan.rung));
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} decide test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll decide tests passed.");
});
