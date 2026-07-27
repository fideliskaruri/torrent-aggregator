/**
 * Table-driven tests for the HLS segment route's pure helpers.
 *
 * The route itself needs a live session and a Next request, but the parts that
 * historically go wrong — range parsing, path containment, content types — are
 * pure and are tested here directly.
 */
import assert from "node:assert/strict";
import path from "node:path";
import {
  parseSegmentRange,
  resolveWithinSessionDir,
  contentTypeForSegment,
  type ParsedRange,
} from "../../app/api/playback/hls/[sessionId]/[...segment]/route";

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

// ── contentTypeForSegment ──

const typeCases: Array<[string, string]> = [
  ["playlist.m3u8", "application/vnd.apple.mpegurl"],
  ["PLAYLIST.M3U8", "application/vnd.apple.mpegurl"],
  ["seg00000.m4s", "video/iso.segment"],
  ["init.mp4", "video/mp4"],
  ["seg0.ts", "video/mp2t"],
  ["notes.txt", "application/octet-stream"],
  ["", "application/octet-stream"],
];

for (const [name, expected] of typeCases) {
  check(`contentTypeForSegment ${name || "(empty)"} → ${expected}`, () => {
    assert.equal(contentTypeForSegment(name), expected);
  });
}

// ── parseSegmentRange ──

const SIZE = 1000;

const rangeCases: Array<{ header: string | null; expected: ParsedRange; why: string }> = [
  { header: null, expected: null, why: "no Range header means send the whole thing" },
  { header: "bytes=0-99", expected: { start: 0, end: 99 }, why: "closed range" },
  { header: "bytes=0-", expected: { start: 0, end: SIZE - 1 }, why: "open-ended range" },
  { header: "bytes=500-", expected: { start: 500, end: SIZE - 1 }, why: "open-ended from an offset" },
  { header: "bytes=-100", expected: { start: 900, end: SIZE - 1 }, why: "suffix range" },
  { header: "bytes=-5000", expected: { start: 0, end: SIZE - 1 }, why: "oversized suffix clamps to the file" },
  { header: "bytes=0-99999", expected: { start: 0, end: SIZE - 1 }, why: "end past EOF clamps" },
  { header: "  bytes=10-20  ", expected: { start: 10, end: 20 }, why: "surrounding whitespace is tolerated" },
  { header: "bytes=1000-", expected: "unsatisfiable", why: "start at EOF" },
  { header: "bytes=2000-3000", expected: "unsatisfiable", why: "entirely past EOF" },
  { header: "bytes=99-10", expected: "unsatisfiable", why: "inverted range" },
  { header: "bytes=-0", expected: "unsatisfiable", why: "zero-length suffix" },
  { header: "bytes=", expected: "unsatisfiable", why: "no bounds at all" },
  { header: "items=0-10", expected: "unsatisfiable", why: "non-byte unit" },
  { header: "bytes=0-10, 20-30", expected: "unsatisfiable", why: "multi-range is not supported" },
  { header: "garbage", expected: "unsatisfiable", why: "unparseable" },
];

for (const c of rangeCases) {
  check(`parseSegmentRange ${c.header ?? "(none)"} — ${c.why}`, () => {
    assert.deepEqual(parseSegmentRange(c.header, SIZE), c.expected);
  });
}

check("parseSegmentRange on an empty file is always unsatisfiable", () => {
  assert.equal(parseSegmentRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(parseSegmentRange("bytes=-1", 0), "unsatisfiable");
});

// ── resolveWithinSessionDir ──

const base = path.resolve(process.cwd(), ".sessions", "abc123");

const pathCases: Array<{ name: string; input: string; allowed: boolean }> = [
  { name: "playlist", input: "playlist.m3u8", allowed: true },
  { name: "init segment", input: "init.mp4", allowed: true },
  { name: "media segment", input: "seg00042.m4s", allowed: true },
  { name: "parent traversal", input: "../other/playlist.m3u8", allowed: false },
  { name: "deep parent traversal", input: "../../../../etc/passwd", allowed: false },
  { name: "backslash traversal", input: "..\\other\\playlist.m3u8", allowed: false },
  { name: "embedded traversal", input: "sub/../../escape.m4s", allowed: false },
  { name: "absolute posix path", input: "/etc/passwd", allowed: false },
  { name: "absolute windows path", input: "C:\\Windows\\System32\\config\\SAM", allowed: false },
  { name: "null byte", input: "seg\0.m4s", allowed: false },
  { name: "empty", input: "", allowed: false },
  // A sibling directory whose name merely starts with the base name must not
  // pass a naive startsWith check.
  { name: "prefix sibling", input: "../abc123-evil/playlist.m3u8", allowed: false },
];

for (const c of pathCases) {
  check(`resolveWithinSessionDir ${c.name} → ${c.allowed ? "allowed" : "rejected"}`, () => {
    const result = resolveWithinSessionDir(base, c.input);
    if (c.allowed) {
      assert.ok(result, "expected the path to resolve");
      assert.ok(result.startsWith(base + path.sep), `${result} escaped ${base}`);
    } else {
      assert.equal(result, null);
    }
  });
}

check("resolveWithinSessionDir keeps nested segment paths inside the session dir", () => {
  const result = resolveWithinSessionDir(base, "sub/seg00001.m4s");
  assert.equal(result, path.join(base, "sub", "seg00001.m4s"));
});

if (failures > 0) {
  console.error(`\nFAIL — ${failures} HLS route test(s) failed`);
  process.exit(1);
}
console.log("\nPASS — all HLS route tests passed.");
