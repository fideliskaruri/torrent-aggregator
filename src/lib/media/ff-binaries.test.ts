/**
 * Tests for ff-binaries.ts — locating the bundled ffmpeg/ffprobe executables.
 *
 * The interesting case is not "the file is missing"; it is "the package told us
 * a path that is a lie". Next's server compiler rewrites `__dirname`, so inside
 * a route handler ffprobe-static advertises `/ROOT/node_modules/...`. Every
 * test here therefore drives the pure re-rooting function with an injected
 * filesystem, so the behaviour is asserted without a real install.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { rerootBundledBinary, FfBinaryMissingError } from "./ff-binaries";

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

const CWD = path.join("D:", "code", "torrent-aggregator");
const REAL_FFPROBE = path.join(CWD, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe");
const REAL_FFMPEG = path.join(CWD, "node_modules", "ffmpeg-static", "ffmpeg.exe");

/** Only the two genuinely-installed binaries exist in this fake filesystem. */
const onDisk = (p: string) => p === REAL_FFPROBE || p === REAL_FFMPEG;

type Case = {
  name: string;
  raw: string;
  exists?: (p: string) => boolean;
  expected: string | null;
};

const cases: Case[] = [
  {
    name: "an honest path that exists is used verbatim",
    raw: REAL_FFPROBE,
    expected: REAL_FFPROBE,
  },
  {
    name: "the Next /ROOT rewrite is re-rooted at the real project",
    raw: "/ROOT/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe",
    expected: REAL_FFPROBE,
  },
  {
    name: "a backslash /ROOT rewrite is re-rooted too",
    raw: "\\ROOT\\node_modules\\ffprobe-static\\bin\\win32\\x64\\ffprobe.exe",
    expected: REAL_FFPROBE,
  },
  {
    name: "mixed separators still resolve",
    raw: "/ROOT\\node_modules/ffprobe-static\\bin/win32/x64/ffprobe.exe",
    expected: REAL_FFPROBE,
  },
  {
    name: "ffmpeg-static's flat layout re-roots as well",
    raw: "/ROOT/node_modules/ffmpeg-static/ffmpeg.exe",
    expected: REAL_FFMPEG,
  },
  {
    name: "nested node_modules re-roots from the LAST marker, not the first",
    raw: "/ROOT/node_modules/some-wrapper/node_modules/ffmpeg-static/ffmpeg.exe",
    expected: REAL_FFMPEG,
  },
  {
    name: "a path with no node_modules segment cannot be salvaged",
    raw: "/ROOT/dist/ffprobe.exe",
    expected: null,
  },
  {
    name: "an empty path is not a path",
    raw: "",
    expected: null,
  },
  {
    name: "re-rooting still fails honestly when the binary is genuinely absent",
    raw: "/ROOT/node_modules/ffprobe-static/bin/linux/arm64/ffprobe",
    expected: null,
  },
  {
    name: "a real but relative path is resolved against the project, not the shell cwd",
    raw: "node_modules/ffmpeg-static/ffmpeg.exe",
    expected: REAL_FFMPEG,
  },
];

async function main() {
  console.log("\nff-binaries tests\n");

  for (const c of cases) {
    await check(c.name, () => {
      assert.equal(rerootBundledBinary(c.raw, CWD, c.exists ?? onDisk), c.expected);
    });
  }

  await check("the missing-binary error names the package and the remedy", () => {
    const err = new FfBinaryMissingError("ffprobe", "ffprobe-static", new Error("boom"));
    assert.match(err.message, /ffprobe-static/);
    assert.match(err.message, /npm install ffprobe-static/);
    assert.match(err.message, /boom/);
    assert.equal(err.name, "FfBinaryMissingError");
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} ff-binaries test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll ff-binaries tests passed.");
});
