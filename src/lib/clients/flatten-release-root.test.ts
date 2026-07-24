/**
 * Best-effort flatten of junk release roots under smart savepaths.
 * Run: npx tsx src/lib/clients/flatten-release-root.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  flattenSingleReleaseRoot,
  isJunkReleaseRoot,
  normalizeReleaseKey,
} from "./flatten-release-root";

// --- Classification ---
{
  assert.equal(
    isJunkReleaseRoot("Family.Guy.S24E11.1080p.WEB.h264-playWEB", "Family.Guy.S24E11.1080p.WEB.h264-playWEB"),
    true,
  );
  assert.equal(
    isJunkReleaseRoot(
      "Family.Guy.S24E11.1080p.WEB.h264-playWEB",
      "Family Guy S24E11 1080p WEB h264-playWEB",
    ),
    true,
    "dots vs spaces must match via normalize",
  );
  assert.equal(
    isJunkReleaseRoot("The.Simpsons.S32E10.720p.HDTV.x264"),
    true,
    "scene slug without explicit torrent name",
  );
  assert.equal(isJunkReleaseRoot("Season 24"), false);
  assert.equal(isJunkReleaseRoot("Season 01"), false);
  assert.equal(isJunkReleaseRoot("Specials"), false);
  assert.equal(isJunkReleaseRoot("Extras"), false);
  assert.equal(isJunkReleaseRoot("Family Guy"), false, "clean show name alone is not junk");
  assert.equal(
    normalizeReleaseKey("One.Piece.S23E01"),
    normalizeReleaseKey("One Piece S23E01"),
  );
}

// --- Filesystem flatten ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-flatten-"));
  try {
    const dest = path.join(tmp, "TV", "Family Guy", "Season 24");
    const junk = "Family.Guy.S24E11.1080p.WEB.h264-playWEB";
    const nested = path.join(dest, junk);
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "Family.Guy.S24E11.mkv"), "video");
    fs.writeFileSync(path.join(nested, "RARBG.txt"), "nfo");

    const result = flattenSingleReleaseRoot(dest, junk);
    assert.equal(result.flattened, true, JSON.stringify(result));
    if (!result.flattened) throw new Error("unreachable");
    assert.equal(result.moved, 2);
    assert.ok(fs.existsSync(path.join(dest, "Family.Guy.S24E11.mkv")));
    assert.ok(fs.existsSync(path.join(dest, "RARBG.txt")));
    assert.ok(!fs.existsSync(nested), "junk root removed");

    // Second call is a no-op (files already at root)
    const again = flattenSingleReleaseRoot(dest, junk);
    assert.equal(again.flattened, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Do not flatten Season folders
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-flatten-"));
  try {
    const dest = path.join(tmp, "Anime", "One Piece");
    fs.mkdirSync(path.join(dest, "Season 23"), { recursive: true });
    fs.writeFileSync(path.join(dest, "Season 23", "ep.mkv"), "x");
    const result = flattenSingleReleaseRoot(dest, "One Piece S23");
    assert.equal(result.flattened, false);
    assert.ok(fs.existsSync(path.join(dest, "Season 23", "ep.mkv")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Multiple subfolders → skip
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-flatten-"));
  try {
    const dest = path.join(tmp, "TV", "Show");
    fs.mkdirSync(path.join(dest, "A.Release.S01E01.1080p"), { recursive: true });
    fs.mkdirSync(path.join(dest, "other"), { recursive: true });
    const result = flattenSingleReleaseRoot(dest, "A.Release.S01E01.1080p");
    assert.equal(result.flattened, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("flatten-release-root.test.ts: all assertions passed");
