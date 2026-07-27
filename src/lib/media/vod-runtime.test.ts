/**
 * Tests for the parts of the complete-file runtime that are decisions rather
 * than processes.
 *
 * Nothing here spawns ffmpeg or ffprobe. What is worth pinning down is the
 * bookkeeping that decides *which* media a request gets:
 *
 *   - the cache key, because two different audio tracks or two different rungs
 *     are genuinely different conversions and sharing a directory would serve
 *     one viewer the other's film;
 *   - the keyframe index cache, because it is what makes a segment boundary
 *     land on a real keyframe instead of mid-GOP, and a silently discarded
 *     index means every seek on the re-encode path shows a black flash;
 *   - the segment naming round trip, because the playlist and the route parse
 *     the same string from opposite ends;
 *   - the on-disk candidate paths, because this is Windows and the owner's
 *     library is full of `Season 01` and apostrophes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  readKeyframeIndex,
  segmentName,
  parseSegmentIndex,
  vodId,
  vodCacheDir,
  VOD_DIR_NAME,
  MAX_WHOLE_FILE_CONVERSION_ATTEMPTS,
  shouldRetryWholeFileConversion,
} from "./vod-runtime";
import { localPathCandidates } from "./local-file";
import { chooseStrategy, keyframeAlignedSegments, VOD_SEGMENT_SECONDS } from "./vod";
import type { PlaybackPlan, PlaybackRung } from "./decide";

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

function plan(overrides: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    rung: "remux",
    reason: "test",
    video: { codec: "hevc", streamIndex: 0, action: "copy" },
    audio: [
      {
        streamIndex: 1,
        codec: "eac3",
        action: "copy",
        channels: 6,
        language: "eng",
        title: null,
      },
    ],
    selectedAudioIndex: 1,
    container: "matroska",
    cost: 1,
    ...overrides,
  };
}

/** Scratch inside the repo — never the OS temp directory. */
const scratchRoot = path.join(process.cwd(), ".sessions", "_vod-runtime-test");

function scratch(name: string): string {
  const dir = path.join(scratchRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Cache identity ──

console.log("\nvod cache identity");

check("the cache lives under the reserved directory, not loose in .sessions", () => {
  assert.equal(path.basename(vodCacheDir()), VOD_DIR_NAME);
});

check("the same file, track and rung always resolve to the same directory", () => {
  const key = {
    infoHash: "abc123",
    filePath: "Rick and Morty/Season 01/S01E01.mkv",
    audioStreamIndex: 1,
    rung: "remux",
  };
  assert.equal(vodId(key), vodId({ ...key }));
  assert.match(vodId(key), /^[a-f0-9]{20}$/);
});

const identityCases: Array<{ name: string; a: Parameters<typeof vodId>[0]; b: Parameters<typeof vodId>[0] }> = [
  {
    name: "a different audio track is a different conversion",
    a: { infoHash: "h", filePath: "f.mkv", audioStreamIndex: 1, rung: "remux" },
    b: { infoHash: "h", filePath: "f.mkv", audioStreamIndex: 2, rung: "remux" },
  },
  {
    name: "a different rung is a different conversion",
    a: { infoHash: "h", filePath: "f.mkv", audioStreamIndex: 1, rung: "remux" },
    b: { infoHash: "h", filePath: "f.mkv", audioStreamIndex: 1, rung: "transcode-full" },
  },
  {
    name: "two files in the same torrent do not share a conversion",
    a: { infoHash: "h", filePath: "Season 01/E01.mkv", audioStreamIndex: 1, rung: "remux" },
    b: { infoHash: "h", filePath: "Season 01/E02.mkv", audioStreamIndex: 1, rung: "remux" },
  },
  {
    name: "no audio track selected is not the same as track zero",
    a: { infoHash: "h", filePath: "f.mkv", audioStreamIndex: null, rung: "remux" },
    b: { infoHash: "h", filePath: "f.mkv", audioStreamIndex: 0, rung: "remux" },
  },
];

for (const testCase of identityCases) {
  check(testCase.name, () => {
    assert.notEqual(vodId(testCase.a), vodId(testCase.b));
  });
}

// ── Keyframe index cache ──

console.log("\nkeyframe index cache");

check("an index written once is read back intact", () => {
  const dir = scratch("keys-ok");
  const times = [0, 4.004, 8.008, 12.012];
  fs.writeFileSync(path.join(dir, "keyframes.json"), JSON.stringify(times), "utf8");
  assert.deepEqual(readKeyframeIndex(dir), times);
});

const badIndexCases: Array<{ name: string; write: (dir: string) => void }> = [
  { name: "a missing file", write: () => {} },
  {
    name: "a truncated write from a killed process",
    write: (dir) => fs.writeFileSync(path.join(dir, "keyframes.json"), "[0,4.0", "utf8"),
  },
  {
    name: "an empty index (the probe found nothing)",
    write: (dir) => fs.writeFileSync(path.join(dir, "keyframes.json"), "[]", "utf8"),
  },
  {
    name: "a non-array payload",
    write: (dir) => fs.writeFileSync(path.join(dir, "keyframes.json"), '{"a":1}', "utf8"),
  },
];

for (const testCase of badIndexCases) {
  check(`${testCase.name} yields no index rather than a bogus one`, () => {
    const dir = scratch(`keys-bad-${testCase.name.replace(/\W+/g, "-")}`);
    testCase.write(dir);
    assert.equal(readKeyframeIndex(dir), null);
  });
}

check("a cached index reproduces exactly the boundaries it was built from", () => {
  const dir = scratch("keys-stable");
  const keys = [0, 4.004, 8.008, 10.01, 16.016, 20.02];
  fs.writeFileSync(path.join(dir, "keyframes.json"), JSON.stringify(keys), "utf8");
  const first = keyframeAlignedSegments(keys, 24, VOD_SEGMENT_SECONDS);
  const reloaded = keyframeAlignedSegments(readKeyframeIndex(dir)!, 24, VOD_SEGMENT_SECONDS);
  assert.deepEqual(reloaded, first, "a restart must not move a boundary");
  for (const segment of reloaded) {
    assert.ok(
      keys.some((k) => Math.abs(k - segment.start) < 1e-6),
      `segment ${segment.index} starts at ${segment.start}, which is not a keyframe`,
    );
  }
});

// ── Segment naming ──

console.log("\nsegment naming");

for (const index of [0, 1, 9, 10, 99, 1799, 99999]) {
  check(`segment ${index} names and parses back to itself`, () => {
    const name = segmentName(index);
    assert.match(name, /^seg\d{5}\.m4s$/);
    assert.equal(parseSegmentIndex(name), index);
  });
}

for (const bogus of ["seg1.m4s", "seg00001.mp4", "../../etc/passwd", "playlist.m3u8", "init.mp4"]) {
  check(`"${bogus}" is not a segment name`, () => {
    assert.equal(parseSegmentIndex(bogus), null);
  });
}

// ── Complete-vs-incomplete routing, end to end ──

console.log("\nrouting into the runtime");

const routingCases: Array<{
  name: string;
  complete: boolean;
  rung: PlaybackRung;
  videoAction: "copy" | "transcode";
  expect: "session" | "whole-file" | "vod-segments";
  /** Does the chosen strategy cut segments itself (and so need keyframes)? */
  needsKeyframes: boolean;
}> = [
  {
    name: "the owner's HEVC film on a browser that decodes HEVC",
    complete: true,
    rung: "remux",
    videoAction: "copy",
    expect: "whole-file",
    needsKeyframes: false,
  },
  {
    name: "the same film on a browser that cannot decode HEVC",
    complete: true,
    rung: "transcode-full",
    videoAction: "transcode",
    expect: "vod-segments",
    needsKeyframes: true,
  },
  {
    name: "H.264 + E-AC-3 where only the audio has to be re-encoded",
    complete: true,
    rung: "transcode-audio",
    videoAction: "copy",
    expect: "whole-file",
    needsKeyframes: false,
  },
  {
    name: "the same file mid-download",
    complete: false,
    rung: "remux",
    videoAction: "copy",
    expect: "session",
    needsKeyframes: false,
  },
];

for (const testCase of routingCases) {
  check(testCase.name, () => {
    const decision = chooseStrategy({
      complete: testCase.complete,
      duration: 7265.5,
      plan: plan({
        rung: testCase.rung,
        video: { codec: "hevc", streamIndex: 0, action: testCase.videoAction },
      }),
    });
    assert.equal(decision.strategy, testCase.expect, decision.reason);
    // Only a strategy that cuts its own segments can be wrong about keyframes:
    // whole-file hands the cutting to ffmpeg's HLS muxer, which cuts on real
    // keyframes by construction.
    assert.equal(
      decision.strategy === "vod-segments",
      testCase.needsKeyframes,
      "only the on-demand segment path needs a keyframe index",
    );
  });
}

// ── Whole-file retry cap ──

console.log("\nwhole-file retry cap");

const retryCases: Array<{
  name: string;
  strategy: "whole-file" | "vod-segments";
  status: "preparing" | "ready" | "error";
  attempts: number;
  expect: boolean;
}> = [
  {
    name: "a first whole-file failure may be retried",
    strategy: "whole-file",
    status: "error",
    attempts: 1,
    expect: true,
  },
  {
    name: "the final whole-file failure is terminal",
    strategy: "whole-file",
    status: "error",
    attempts: MAX_WHOLE_FILE_CONVERSION_ATTEMPTS,
    expect: false,
  },
  {
    name: "segment VOD errors are not governed by the whole-file cap",
    strategy: "vod-segments",
    status: "error",
    attempts: MAX_WHOLE_FILE_CONVERSION_ATTEMPTS,
    expect: true,
  },
];

for (const testCase of retryCases) {
  check(testCase.name, () => {
    assert.equal(
      shouldRetryWholeFileConversion({
        strategy: testCase.strategy,
        status: testCase.status,
        conversionAttempts: testCase.attempts,
      }),
      testCase.expect,
    );
  });
}

// ── On-disk candidates (the direct-input path) ──

console.log("\nlocal path candidates");

const pathCases: Array<{ name: string; root: string; file: string; expectFirst: string }> = [
  {
    name: "a season folder with a space",
    root: "D:\\downloads\\TV",
    file: "Rick and Morty/Season 01/S01E01.mkv",
    expectFirst: path.join("D:\\downloads\\TV", "Rick and Morty", "Season 01", "S01E01.mkv"),
  },
  {
    name: "a title with an apostrophe",
    root: "D:\\downloads\\Movies",
    file: "Charlie's Angels (2000)/movie.mkv",
    expectFirst: path.join("D:\\downloads\\Movies", "Charlie's Angels (2000)", "movie.mkv"),
  },
  {
    name: "already-native separators",
    root: "D:\\downloads",
    file: "Supergirl\\Supergirl 1984 BluRay x265.mkv",
    expectFirst: path.join("D:\\downloads", "Supergirl", "Supergirl 1984 BluRay x265.mkv"),
  },
];

for (const testCase of pathCases) {
  check(`${testCase.name} resolves without quoting`, () => {
    const candidates = localPathCandidates(testCase.root, testCase.file);
    assert.equal(candidates[0], testCase.expectFirst);
    // The flattened fallback exists because the engine drops a junk single
    // folder root once a download completes.
    assert.ok(candidates.length >= 1);
    assert.ok(
      candidates.every((c) => !c.includes('"') && !c.includes("'\\''")),
      "paths are argv elements, never shell-quoted strings",
    );
  });
}

check("a file already at the save root does not produce a duplicate candidate", () => {
  const candidates = localPathCandidates("D:\\downloads", "movie.mkv");
  assert.equal(candidates.length, 1);
});

// ── Cleanup ──

try {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
} catch {
  /* Windows can hold a handle briefly; the sweep will get it */
}

console.log(
  `\n${failures === 0 ? "vod-runtime: all tests passed" : `vod-runtime: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
