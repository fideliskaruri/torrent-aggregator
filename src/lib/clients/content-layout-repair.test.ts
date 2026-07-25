import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { liftWrapperFolder, repairContentLayout } from "./content-layout-repair";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "tf-layout-"));

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

const tree = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
};

// --- A single release folder is lifted ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "Movies", "Dune Part Two");
    const wrapper = "Dune Part Two (2024) [2160p] [4K] [WEB] [5.1] [YTS.MX]";
    write(path.join(dest, wrapper, "Dune.mp4"), "video");
    write(path.join(dest, wrapper, "subs", "en.srt"), "subs");

    const result = liftWrapperFolder(dest, wrapper);
    assert.equal(result.flattened, true, JSON.stringify(result));
    assert.deepEqual(tree(dest), ["Dune.mp4", "subs/en.srt"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- A flat folder is a no-op, and repeated calls stay a no-op ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "Movies", "X");
    write(path.join(dest, "movie.mkv"), "video");
    assert.equal(liftWrapperFolder(dest, "X 2024").flattened, false);
    assert.equal(repairContentLayout(dest, "X 2024").moved, 0);
    assert.deepEqual(tree(dest), ["movie.mkv"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Several folders and none is ours → leave it alone ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "TV", "Show");
    fs.mkdirSync(path.join(dest, "A.Release.S01E01.1080p"), { recursive: true });
    fs.mkdirSync(path.join(dest, "other"), { recursive: true });
    assert.equal(
      liftWrapperFolder(dest, "Something Else Entirely").flattened,
      false,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Structural folders are never lifted (shared with the planner) ---
for (const name of ["Season 02", "Disc 1", "CD2", "Volume 03", "Subs", "Sample"]) {
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "TV", "Show");
    write(path.join(dest, name, "file.mkv"), "video");
    assert.equal(
      liftWrapperFolder(dest, name).flattened,
      false,
      `${name} must survive`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- …but a season folder that merely repeats the destination goes ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "TV", "Show", "Season 01");
    write(path.join(dest, "Season 01", "ep.mkv"), "video");
    const result = liftWrapperFolder(dest, "Season 01");
    assert.equal(result.flattened, true, JSON.stringify(result));
    assert.deepEqual(tree(dest), ["ep.mkv"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Protected media structures are never lifted ---
for (const name of ["VIDEO_TS", "BDMV", "PS3_GAME"]) {
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "Movies", "Film");
    write(path.join(dest, name, "data.bin"), "x");
    assert.equal(
      liftWrapperFolder(dest, name).flattened,
      false,
      `${name} must survive`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- A collision aborts the ENTIRE lift, never half of it (duck #2) ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "TV", "Show", "Season 03");
    const wrapper = "Show S03E02 1080p WEB";
    write(path.join(dest, "Screens", "screen0001.png"), "episode one");
    write(path.join(dest, wrapper, "episode.mkv"), "video");
    write(
      path.join(dest, wrapper, "Screens", "screen0001.png"),
      "episode two — different bytes, same name",
    );

    const result = liftWrapperFolder(dest, wrapper);
    assert.equal(result.flattened, false, "one collision blocks the lift");
    assert.ok(
      !fs.existsSync(path.join(dest, "episode.mkv")),
      "nothing may move when the lift cannot complete",
    );
    assert.equal(
      fs.readFileSync(
        path.join(dest, wrapper, "Screens", "screen0001.png"),
        "utf8",
      ),
      "episode two — different bytes, same name",
      "the other copy is untouched",
    );
    assert.equal(
      fs.readFileSync(path.join(dest, "Screens", "screen0001.png"), "utf8"),
      "episode one",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Directories merge when nothing actually collides ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "TV", "Show", "Season 03");
    const wrapper = "Show S03E02 1080p WEB";
    write(path.join(dest, "Screens", "e01.png"), "one");
    write(path.join(dest, wrapper, "episode.mkv"), "video");
    write(path.join(dest, wrapper, "Screens", "e02.png"), "two");

    const result = liftWrapperFolder(dest, wrapper);
    assert.equal(result.flattened, true, JSON.stringify(result));
    assert.deepEqual(tree(dest), [
      "Screens/e01.png",
      "Screens/e02.png",
      "episode.mkv",
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- An identical duplicate is NOT deleted; the lift aborts instead ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "TV", "Show", "Season 03");
    const wrapper = "Show S03E02 1080p WEB";
    write(path.join(dest, "episode.mkv"), "same bytes both sides");
    write(path.join(dest, wrapper, "episode.mkv"), "same bytes both sides");
    write(path.join(dest, wrapper, "Screens", "s1.png"), "art");

    const result = liftWrapperFolder(dest, wrapper);
    assert.equal(
      result.flattened,
      false,
      "matching size and samples do not prove the bytes are the same",
    );
    assert.equal(
      fs.readFileSync(path.join(dest, wrapper, "episode.mkv"), "utf8"),
      "same bytes both sides",
      "no file is ever deleted on sampled evidence",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Without a name match nothing is lifted, even a lone child (duck #8) ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "Movies", "Blade Runner");
    write(path.join(dest, "Director's Cut", "movie.mkv"), "video");
    const result = liftWrapperFolder(dest, "Blade Runner 1982 1080p BluRay");
    assert.equal(result.flattened, false, "Director's Cut must survive");
    assert.ok(fs.existsSync(path.join(dest, "Director's Cut", "movie.mkv")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- A file where a folder should go aborts rather than guessing ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "Movies", "X");
    const wrapper = "X 2024 1080p WEB";
    write(path.join(dest, "Subs"), "actually a file");
    write(path.join(dest, wrapper, "Subs", "en.srt"), "subs");
    write(path.join(dest, wrapper, "movie.mkv"), "video");

    assert.equal(liftWrapperFolder(dest, wrapper).flattened, false);
    assert.ok(!fs.existsSync(path.join(dest, "movie.mkv")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- A pack wrapped twice, as reported under Anime\Solo Leveling ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "Anime", "Solo Leveling", "Season 01");
    const outer = "Solo Leveling 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
    const inner = "Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
    write(path.join(dest, outer, inner, "S01E01.mkv"), "video");
    write(path.join(dest, outer, inner, "Subs", "S01E01.eng.srt"), "subs");

    const { moved, roots } = repairContentLayout(dest, outer);
    assert.ok(moved > 0, "the double wrap must be lifted");
    assert.deepEqual(roots, [outer, inner]);
    assert.deepEqual(tree(dest), ["S01E01.mkv", "Subs/S01E01.eng.srt"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- A meaningful inner folder survives the second pass (duck #4) ---
{
  const tmp = tmpdir();
  try {
    const dest = path.join(tmp, "Music", "Artist", "Album");
    const outer = "Artist Album 2024 FLAC 24bit";
    const inner = "Artist Album 2024 Disc 1 FLAC 24bit";
    write(path.join(dest, outer, inner, "01.flac"), "audio");

    const { roots } = repairContentLayout(dest, outer);
    assert.deepEqual(roots, [outer], "the disc folder is not a duplicate");
    assert.deepEqual(tree(dest), [`${inner}/01.flac`]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("content-layout-repair.test.ts: all assertions passed");
