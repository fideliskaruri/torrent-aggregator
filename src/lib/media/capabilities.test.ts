/**
 * Table-driven tests for browser capability interpretation.
 *
 * The rule under test: capability is a property of a *codec tag* in a container
 * family, not of the exact MIME string the client happened to probe. The client
 * can only send a finite probe list, but the decision engine asks combinatorial
 * questions (every video tag × every audio tag), so whole-string matching
 * silently answered "no" to pairings that were never probed — and a "no" costs
 * a needless transcode.
 */
import assert from "node:assert/strict";
import {
  parseMime,
  supportsCodecTag,
  canDecodeViaMSE,
  supportsContainer,
  videoCodecTag,
  audioCodecTag,
  fmp4Mime,
  parseCapabilities,
  DEFAULT_CAPABILITIES,
  type ClientCapabilities,
} from "./capabilities";

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

/**
 * The empirically measured Edge/Chromium-on-Windows profile. Everything here
 * was verified with scripts/probe-codecs.mjs against a real browser — including
 * the one fact that drives the whole ladder: MKV is not an MSE container.
 */
function edgeCaps(): ClientCapabilities {
  const yes = (mime: string) => ({ mime, canPlay: "probably", mse: true });
  const no = (mime: string) => ({ mime, canPlay: "", mse: false });
  return {
    ua: "edge-test",
    mseSupported: true,
    codecs: [
      yes('video/mp4; codecs="avc1.640028,mp4a.40.2"'),
      yes('video/mp4; codecs="avc1.640028,ac-3"'),
      yes('video/mp4; codecs="avc1.640028,ec-3"'),
      yes('video/mp4; codecs="avc1.640028"'),
      yes('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      yes('video/mp4; codecs="hvc1.2.4.L120.B0"'),
      yes('video/mp4; codecs="av01.0.05M.08"'),
      yes('video/mp4; codecs="vp09.00.10.08"'),
      yes('audio/mp4; codecs="mp4a.40.2"'),
      yes('audio/mp4; codecs="flac"'),
      yes('audio/mp4; codecs="ac-3"'),
      yes('audio/mp4; codecs="ec-3"'),
      no('audio/mp4; codecs="dtsc"'),
      no('audio/mp4; codecs="mlpa"'),
      no('video/x-matroska; codecs="avc1.640028,mp4a.40.2"'),
    ],
  };
}

// ── parseMime ──

const mimeCases: Array<{ mime: string; family: string; tags: string[] }> = [
  { mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"', family: "mp4", tags: ["avc1.640028", "mp4a.40.2"] },
  { mime: 'audio/mp4; codecs="ec-3"', family: "mp4", tags: ["ec-3"] },
  { mime: "video/mp4", family: "mp4", tags: [] },
  // `x-` prefixes are a historical wart, not a different decoder family.
  { mime: 'video/x-matroska; codecs="avc1.640028"', family: "matroska", tags: ["avc1.640028"] },
  { mime: 'video/webm; codecs="vp9,opus"', family: "webm", tags: ["vp9", "opus"] },
  { mime: 'VIDEO/MP4; CODECS="AVC1.640028"', family: "mp4", tags: ["avc1.640028"] },
];

for (const c of mimeCases) {
  check(`parseMime ${c.mime}`, () => {
    const parsed = parseMime(c.mime);
    assert.equal(parsed.family, c.family);
    assert.deepEqual(parsed.tags, c.tags);
  });
}

// ── supportsCodecTag ──

const tagCases: Array<{ tag: string; family?: string; expected: boolean; why: string }> = [
  { tag: "avc1.640028", expected: true, why: "probed standalone" },
  { tag: "ac-3", expected: true, why: "probed in audio/mp4 and paired with avc1" },
  { tag: "ec-3", expected: true, why: "probed in audio/mp4" },
  { tag: "hvc1.2.4.L120.B0", expected: true, why: "HEVC Main10 was probed" },
  { tag: "dtsc", expected: false, why: "probed and rejected" },
  { tag: "mlpa", expected: false, why: "probed and rejected" },
  { tag: "vc-1", expected: false, why: "never probed — unknown fails safe" },
  // Negative evidence must not leak across families: avc1 appears in a rejected
  // matroska mime, but that says nothing about avc1 itself.
  { tag: "avc1.640028", family: "matroska", expected: false, why: "matroska attestation was negative" },
];

for (const c of tagCases) {
  check(`supportsCodecTag ${c.tag}${c.family ? ` in ${c.family}` : ""} → ${c.expected} (${c.why})`, () => {
    assert.equal(supportsCodecTag(edgeCaps(), c.tag, c.family), c.expected);
  });
}

// ── canDecodeViaMSE ──

const mseCases: Array<{ mime: string; expected: boolean; why: string }> = [
  { mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"', expected: true, why: "exact probe hit" },
  // The combination below was never probed; both tags individually were.
  { mime: 'video/mp4; codecs="hvc1.2.4.L120.B0,ec-3"', expected: true, why: "HEVC Main10 + E-AC-3 by decomposition" },
  { mime: 'video/mp4; codecs="hvc1.1.6.L93.B0,ac-3"', expected: true, why: "HEVC Main + AC-3 by decomposition" },
  { mime: 'video/mp4; codecs="avc1.640028,dtsc"', expected: false, why: "one unsupported tag poisons the set" },
  // An exact "no" is authoritative — this is what keeps MKV off the direct rung.
  { mime: 'video/x-matroska; codecs="avc1.640028,mp4a.40.2"', expected: false, why: "explicitly rejected by the browser" },
  { mime: "video/mp4", expected: false, why: "no codec tags to attest" },
  { mime: 'video/mp4; codecs="vc-1,ac-3"', expected: false, why: "unknown video tag" },
];

for (const c of mseCases) {
  check(`canDecodeViaMSE ${c.mime} → ${c.expected} (${c.why})`, () => {
    assert.equal(canDecodeViaMSE(edgeCaps(), c.mime), c.expected);
  });
}

check("canDecodeViaMSE ignores entries the browser could not play", () => {
  const caps: ClientCapabilities = {
    mseSupported: true,
    codecs: [{ mime: 'video/mp4; codecs="avc1.640028"', canPlay: "", mse: true }],
  };
  assert.equal(canDecodeViaMSE(caps, 'video/mp4; codecs="avc1.640028"'), false);
});

// ── supportsContainer ──

const containerCases: Array<{ container: string; expected: boolean }> = [
  { container: "mp4", expected: true },
  { container: "mov", expected: true },
  { container: "matroska", expected: false },
  { container: "mkv", expected: false },
  { container: "mpegts", expected: false },
  { container: "avi", expected: false },
  { container: "webm", expected: false },
];

for (const c of containerCases) {
  check(`supportsContainer ${c.container} → ${c.expected}`, () => {
    assert.equal(supportsContainer(edgeCaps(), c.container), c.expected);
  });
}

// ── videoCodecTag — the profile is not optional ──

const videoTagCases: Array<{ codec: string; profile: string | null; expected: string }> = [
  { codec: "h264", profile: "High", expected: "avc1.640028" },
  { codec: "h264", profile: null, expected: "avc1.640028" },
  { codec: "hevc", profile: "Main", expected: "hvc1.1.6.L93.B0" },
  // ffprobe 4.0.2 emits exactly "Main 10" for 10-bit HEVC — every HDR x265
  // release lands here, and asking MSE the 8-bit question is the wrong question.
  { codec: "hevc", profile: "Main 10", expected: "hvc1.2.4.L120.B0" },
  { codec: "hevc", profile: "Rext", expected: "hvc1.2.4.L120.B0" },
  { codec: "h265", profile: "Main 10 Intra", expected: "hvc1.2.4.L120.B0" },
  { codec: "av1", profile: "Main", expected: "av01.0.05M.08" },
  { codec: "vp9", profile: null, expected: "vp09.00.10.08" },
  { codec: "mpeg2video", profile: "Main", expected: "mpeg2video" },
];

for (const c of videoTagCases) {
  check(`videoCodecTag ${c.codec}/${c.profile ?? "-"} → ${c.expected}`, () => {
    assert.equal(videoCodecTag(c.codec, c.profile), c.expected);
  });
}

// ── audioCodecTag — real ffprobe 4.0.2 codec_name spellings ──

const audioTagCases: Array<[string, string]> = [
  ["aac", "mp4a.40.2"],
  ["ac3", "ac-3"],
  ["eac3", "ec-3"],
  ["e-ac-3", "ec-3"],
  ["flac", "flac"],
  ["opus", "opus"],
  ["dts", "dts"],
];

for (const [codec, expected] of audioTagCases) {
  check(`audioCodecTag ${codec} → ${expected}`, () => {
    assert.equal(audioCodecTag(codec), expected);
  });
}

check("fmp4Mime carries the video profile into the tag", () => {
  assert.equal(fmp4Mime("hevc", "eac3", "Main 10"), 'video/mp4; codecs="hvc1.2.4.L120.B0,ec-3"');
  assert.equal(fmp4Mime("h264", "aac", "High"), 'video/mp4; codecs="avc1.640028,mp4a.40.2"');
  assert.equal(fmp4Mime("h264", null, null), 'video/mp4; codecs="avc1.640028"');
});

// ── parseCapabilities ──

const parseCases: Array<{ name: string; input: unknown; expectDefault: boolean }> = [
  { name: "null", input: null, expectDefault: true },
  { name: "empty object", input: {}, expectDefault: true },
  { name: "codecs not an array", input: { codecs: "nope" }, expectDefault: true },
  { name: "codecs with malformed entries only", input: { codecs: [{ mime: 1 }] }, expectDefault: true },
];

for (const c of parseCases) {
  check(`parseCapabilities ${c.name} falls back to defaults`, () => {
    assert.deepEqual(parseCapabilities(c.input), DEFAULT_CAPABILITIES);
  });
}

check("parseCapabilities keeps only well-formed entries", () => {
  const caps = parseCapabilities({
    ua: "x",
    mseSupported: true,
    codecs: [
      { mime: 'video/mp4; codecs="avc1.640028"', canPlay: "probably", mse: true },
      { mime: "bad" },
      { mime: 'audio/mp4; codecs="ec-3"', canPlay: "probably", mse: true },
    ],
  });
  assert.equal(caps.codecs.length, 2);
  assert.ok(supportsCodecTag(caps, "ec-3"));
});

check("DEFAULT_CAPABILITIES is conservative but usable", () => {
  assert.ok(supportsCodecTag(DEFAULT_CAPABILITIES, "avc1.640028"));
  assert.ok(supportsCodecTag(DEFAULT_CAPABILITIES, "mp4a.40.2"));
  assert.ok(!supportsCodecTag(DEFAULT_CAPABILITIES, "ec-3"));
  assert.ok(!supportsCodecTag(DEFAULT_CAPABILITIES, "hvc1.1.6.L93.B0"));
});

if (failures > 0) {
  console.error(`\nFAIL — ${failures} capability test(s) failed`);
  process.exit(1);
}
console.log("\nPASS — all capability tests passed.");
