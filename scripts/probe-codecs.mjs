/**
 * Empirical codec capability probe.
 *
 * The playback ladder is only worth building if we know what the browser can
 * actually decode. Guessing here is expensive in both directions: transcoding a
 * file the browser could have direct-played wastes CPU and delays first frame,
 * while direct-playing something it cannot decode produces the silent black
 * screen this whole effort exists to eliminate.
 */
import { chromium } from "playwright";

const CANDIDATES = [
  ["H.264 High + AAC-LC", 'video/mp4; codecs="avc1.640028,mp4a.40.2"'],
  ["H.264 High + AC-3", 'video/mp4; codecs="avc1.640028,ac-3"'],
  ["H.264 High + E-AC-3", 'video/mp4; codecs="avc1.640028,ec-3"'],
  ["HEVC Main (hvc1)", 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
  ["HEVC Main (hev1)", 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  ["HEVC Main10", 'video/mp4; codecs="hvc1.2.4.L120.B0"'],
  ["HEVC + AC-3", 'video/mp4; codecs="hvc1.1.6.L93.B0,ac-3"'],
  ["AV1 Main", 'video/mp4; codecs="av01.0.05M.08"'],
  ["VP9", 'video/mp4; codecs="vp09.00.10.08"'],
  ["Matroska H.264/AAC", 'video/x-matroska; codecs="avc1.640028,mp4a.40.2"'],
  ["WebM VP9 + Opus", 'video/webm; codecs="vp9,opus"'],
  ["MP2T (HLS-TS)", 'video/mp2t; codecs="avc1.640028,mp4a.40.2"'],
  ["AAC 5.1 (audio only)", 'audio/mp4; codecs="mp4a.40.2"'],
  ["DTS", 'audio/mp4; codecs="dtsc"'],
  ["TrueHD", 'audio/mp4; codecs="mlpa"'],
  ["FLAC", 'audio/mp4; codecs="flac"'],
];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
// A real document is required: canPlayType/MSE are unavailable on about:blank in
// some builds, and MediaSource support can differ from HTMLVideoElement.
await page.setContent("<!doctype html><title>probe</title><video></video>");

const result = await page.evaluate((candidates) => {
  const video = document.querySelector("video");
  const out = candidates.map(([label, type]) => ({
    label,
    type,
    canPlayType: video.canPlayType(type) || "no",
    mse:
      typeof MediaSource !== "undefined" && MediaSource.isTypeSupported
        ? MediaSource.isTypeSupported(type)
        : null,
  }));
  return { ua: navigator.userAgent, out };
}, CANDIDATES);

// MediaCapabilities is the only API that distinguishes "will decode" from
// "will decode smoothly with hardware acceleration" -- the difference between a
// pleasant 4K HEVC stream and a stuttering one that should have been transcoded.
const decodeInfo = await page.evaluate(async () => {
  if (!navigator.mediaCapabilities?.decodingInfo) return null;
  const probes = [
    ["HEVC 1080p", 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
    ["HEVC 4K", 'video/mp4; codecs="hvc1.2.4.L153.B0"'],
    ["H.264 1080p", 'video/mp4; codecs="avc1.640028"'],
    ["AV1 4K", 'video/mp4; codecs="av01.0.13M.08"'],
  ];
  const results = [];
  for (const [label, contentType] of probes) {
    const is4k = label.includes("4K");
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: "media-source",
        video: {
          contentType,
          width: is4k ? 3840 : 1920,
          height: is4k ? 2160 : 1080,
          bitrate: is4k ? 25_000_000 : 8_000_000,
          framerate: 24,
        },
      });
      results.push({ label, ...info });
    } catch (err) {
      results.push({ label, error: String(err) });
    }
  }
  return results;
});

console.log(`UA: ${result.ua}\n`);
console.log("container/codec support".padEnd(26), "canPlayType".padEnd(12), "MSE");
console.log("-".repeat(58));
for (const row of result.out) {
  console.log(
    row.label.padEnd(26),
    String(row.canPlayType).padEnd(12),
    row.mse === null ? "n/a" : row.mse ? "yes" : "no",
  );
}

if (decodeInfo) {
  console.log("\nhardware decode profile");
  console.log("-".repeat(58));
  for (const row of decodeInfo) {
    if (row.error) {
      console.log(row.label.padEnd(16), row.error);
      continue;
    }
    console.log(
      row.label.padEnd(16),
      `supported=${row.supported}`.padEnd(18),
      `smooth=${row.smooth}`.padEnd(14),
      `powerEfficient=${row.powerEfficient}`,
    );
  }
}

await browser.close();
