import assert from "node:assert/strict";

import {
  applyContentLayout,
  planContentLayout,
  type ExistingFile,
  type TorrentFileLike,
} from "./content-layout";
import {
  isSameRelease,
  physicalKey,
  seasonFolderRename,
} from "./content-layout-policy";

const files = (...paths: string[]): TorrentFileLike[] =>
  paths.map((p) => ({ path: p, length: 100 }));

const plan = (paths: string[], dest?: string) =>
  planContentLayout(files(...paths), dest);

// --- The reported case: a pack wrapped twice ---
{
  const outer = "Solo Leveling 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
  const inner = "Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
  const p = plan(
    [
      `${outer}/${inner}/S01E01.mkv`,
      `${outer}/${inner}/S01E02.mkv`,
      `${outer}/${inner}/Subs/S01E01.eng.srt`,
    ],
    "D:/downloads/Anime/Solo Leveling/Season 01",
  );
  assert.ok(p, "a double wrap must be flattened");
  assert.deepEqual(p.roots, [outer, inner]);
  assert.deepEqual(p.paths, [
    "S01E01.mkv",
    "S01E02.mkv",
    "Subs/S01E01.eng.srt",
  ]);
}

// --- A single release folder, the ordinary case ---
{
  const p = plan(
    [
      "Dune Part Two (2024) [2160p] [4K] [WEB] [5.1] [YTS.MX]/Dune.mp4",
      "Dune Part Two (2024) [2160p] [4K] [WEB] [5.1] [YTS.MX]/subs/en.srt",
    ],
    "D:/downloads/Movies/Dune Part Two",
  );
  assert.ok(p);
  assert.deepEqual(p.paths, ["Dune.mp4", "subs/en.srt"]);
}

// --- Already flat: nothing to do ---
assert.equal(plan(["movie.mkv", "poster.jpg"]), null);

// --- A single-file torrent is untouched ---
assert.equal(plan(["Some.Movie.2024.mkv"]), null);

// --- An NFO beside the folder does not change the container decision ---
{
  const p = plan(["Release.Name/movie.mkv", "Release.Name/info.nfo"]);
  assert.ok(p);
  assert.deepEqual(p.roots, ["Release.Name"]);
}

// --- Files under different roots are left alone ---
assert.equal(plan(["A/one.mkv", "B/two.mkv"]), null);

// === Structures that must survive ===

// A DVD rip: VIDEO_TS is looked up by name, so it is never the container.
{
  const p = plan([
    "Some Film 1998 DVD/VIDEO_TS/VIDEO_TS.IFO",
    "Some Film 1998 DVD/VIDEO_TS/VTS_01_1.VOB",
  ]);
  assert.ok(p);
  assert.deepEqual(p.roots, ["Some Film 1998 DVD"]);
  assert.deepEqual(p.paths, ["VIDEO_TS/VIDEO_TS.IFO", "VIDEO_TS/VTS_01_1.VOB"]);
}

// A Blu-ray with BDMV directly at the root keeps it.
assert.equal(plan(["BDMV/index.bdmv", "BDMV/STREAM/00001.m2ts"]), null);

// A console layout keeps its game root.
assert.equal(plan(["PS3_GAME/USRDIR/EBOOT.BIN", "PS3_GAME/ICON0.PNG"]), null);

// --- A disc folder is organisation, not a wrapper (duck #6) ---
assert.equal(plan(["Disc 1/track01.flac", "Disc 1/track02.flac"]), null);

// --- …and stays even one level down ---
{
  const p = plan([
    "Live Concert 2019 FLAC/Disc 1/track01.flac",
    "Live Concert 2019 FLAC/Disc 2/track01.flac",
  ]);
  assert.ok(p);
  assert.deepEqual(p.roots, ["Live Concert 2019 FLAC"]);
  assert.deepEqual(p.paths, ["Disc 1/track01.flac", "Disc 2/track01.flac"]);
}

// --- A season folder is not dropped just for being alone (duck #6) ---
assert.equal(
  plan(["Season 01/ep.mkv", "Season 01/ep2.mkv"], "D:/downloads/TV/Show"),
  null,
);

// --- …but is dropped when the destination already says it ---
{
  const p = plan(
    ["Season 01/ep.mkv", "Season 01/ep2.mkv"],
    "D:/downloads/TV/Show/Season 1",
  );
  assert.ok(p, "Season 01 inside .../Season 1 is pure repetition");
  assert.deepEqual(p.paths, ["ep.mkv", "ep2.mkv"]);
}

// --- A meaningful nested folder is kept, however deep the chain ---
{
  const p = plan(["a/b/c/d/e/file.mkv", "a/b/c/d/e/other.mkv"]);
  assert.ok(p);
  assert.deepEqual(p.roots, ["a"], "only the container root goes");
}

// --- A book series keeps its structure ---
{
  const p = plan([
    "Author Collection/Series/Book One/book.epub",
    "Author Collection/Series/Book Two/book.epub",
  ]);
  assert.ok(p);
  assert.deepEqual(p.roots, ["Author Collection"]);
}

// === Duck #4: similarity false positives that must NOT strip ===

// A multi-disc album where the inner folder names the disc.
{
  const p = plan([
    "Artist Album 2024 FLAC 24bit/Artist Album 2024 Disc 1 FLAC 24bit/01.flac",
    "Artist Album 2024 FLAC 24bit/Artist Album 2024 Disc 1 FLAC 24bit/02.flac",
  ]);
  assert.ok(p);
  assert.deepEqual(
    p.roots,
    ["Artist Album 2024 FLAC 24bit"],
    "the disc folder distinguishes discs and must survive",
  );
}

// An audio-language variant.
{
  const p = plan([
    "Show S01 1080p WEB DL Dual Audio/Show S01 1080p WEB DL English Audio/e01.mkv",
    "Show S01 1080p WEB DL Dual Audio/Show S01 1080p WEB DL English Audio/e02.mkv",
  ]);
  assert.ok(p);
  assert.equal(p.roots.length, 1, "a language variant is not a duplicate");
}

// An alternate encode.
{
  const p = plan([
    "Movie 2024 1080p BluRay x264/Movie 2024 1080p BluRay x265/movie.mkv",
    "Movie 2024 1080p BluRay x264/Movie 2024 1080p BluRay x265/sample.mkv",
  ]);
  assert.ok(p);
  assert.equal(p.roots.length, 1, "x264 and x265 are different releases");
}

// --- isSameRelease directly ---
const soloDest = new Set(["season 1"]);
assert.equal(
  isSameRelease(
    "Solo Leveling 1080p Dual Audio BDRip x265-EMBER",
    "Solo Leveling S01 1080p Dual Audio BDRip x265-EMBER",
    soloDest,
  ),
  true,
);
assert.equal(
  isSameRelease(
    "Solo Leveling 1080p Dual Audio BDRip x265-EMBER",
    "Solo Leveling S01 1080p Dual Audio BDRip x265-EMBER",
    new Set(),
  ),
  false,
  "a season may only be dropped when the destination already names it",
);
assert.equal(isSameRelease("Movie 1080p x264", "Movie 1080p x265"), false);
assert.equal(isSameRelease("VIDEO_TS", "Some Film 1998 DVD"), false);
assert.equal(isSameRelease("Album FLAC", "Album Disc 1 FLAC"), false);

// Duck round 3: collection markers are NOT interchangeable with a season.
assert.equal(
  isSameRelease("Frieren Complete 1080p Batch", "Frieren S01 1080p Pack", new Set()),
  false,
  "Complete/Batch vs S01 is not the same folder",
);
assert.equal(
  isSameRelease("Show 1080p WEB Complete", "Show S01 1080p WEB", new Set()),
  false,
);
assert.equal(
  isSameRelease("Show S01 1080p Pack", "Show S01 E01 1080p", new Set()),
  false,
);
// Two unrelated releases must not match on encode jargon alone.
assert.equal(isSameRelease("1080p x265 WEB", "1080p x265 WEB DD"), false);

// --- A season pack keeps its season folder when the destination lacks one ---
{
  const p = plan(
    [
      "Frieren Complete 1080p Batch/Frieren S01 1080p Batch/e01.mkv",
      "Frieren Complete 1080p Batch/Frieren S01 1080p Batch/e02.mkv",
    ],
    "D:/downloads/Anime/Frieren",
  );
  assert.ok(p);
  assert.equal(
    p.roots.length,
    1,
    "the inner folder is the only thing naming the season",
  );
}

// === Safety ===

// --- Traversal in the input is refused ---
assert.equal(plan(["Release/../../etc/passwd", "Release/ok.mkv"]), null);
assert.equal(plan(["Release/./a.mkv", "Release/b.mkv"]), null);

// --- Two files must not collapse onto one path ---
{
  // Same physical name after the store strips reserved characters (duck #5).
  const p = plan(["R/Ep 01: Arrival.mkv", "R/Ep 01 Arrival.mkv"]);
  assert.equal(p, null, "reserved-character twins collide on disk");
}
{
  // Windows folds case; two files differing only in case are one file.
  const p = plan(["R/Cover.jpg", "R/cover.jpg"]);
  if (process.platform === "win32") {
    assert.equal(p, null, "a case-only difference collides on Windows");
  } else {
    assert.ok(p);
  }
}

// --- physicalKey strips exactly what the store strips ---
assert.equal(
  physicalKey("Dir/Ep 01: Arrival.mkv"),
  physicalKey("Dir/Ep 01 Arrival.mkv"),
);
assert.notEqual(physicalKey("Dir/a.mkv"), physicalKey("Dir/b.mkv"));

// === Cross-torrent collisions ===

const asProbe =
  (map: Record<string, ExistingFile>) =>
  (rel: string): ExistingFile | null =>
    map[rel] ?? null;

// --- A path owned by another torrent cancels the whole rewrite (duck #1) ---
{
  const torrent = {
    infoHash: "aaaa",
    path: "D:/downloads/TV/Show/Season 03",
    files: files("Release/episode.mkv", "Release/Screens/s1.png"),
  };
  const dropped = applyContentLayout(
    torrent,
    asProbe({
      // Same size — under the old rule this passed as "resume data".
      "Screens/s1.png": { size: 100, owner: "bbbb" },
    }),
  );
  assert.equal(dropped, null, "another torrent's file is never resume data");
  assert.equal(torrent.files[0].path, "Release/episode.mkv");
}

// --- Our own claim is resume data, whatever the size ---
{
  const torrent = {
    infoHash: "AAAA",
    path: "D:/downloads/TV/Show/Season 03",
    files: files("Release/episode.mkv"),
  };
  const dropped = applyContentLayout(
    torrent,
    asProbe({ "episode.mkv": { size: 7, owner: "aaaa" } }),
  );
  assert.deepEqual(dropped?.roots, ["Release"]);
  assert.equal(torrent.files[0].path, "episode.mkv");
}

// --- An unclaimed file of a different size still blocks ---
{
  const torrent = {
    infoHash: "aaaa",
    path: "D:/downloads/Movies/X",
    files: files("Release/movie.mkv"),
  };
  assert.equal(
    applyContentLayout(
      torrent,
      asProbe({ "movie.mkv": { size: 999, owner: null } }),
    ),
    null,
  );
}

// --- An unclaimed file of the right size is a pre-manifest download of ours ---
{
  const torrent = {
    infoHash: "aaaa",
    path: "D:/downloads/Movies/X",
    files: files("Release/movie.mkv"),
  };
  assert.deepEqual(
    applyContentLayout(
      torrent,
      asProbe({ "movie.mkv": { size: 100, owner: null } }),
    )?.roots,
    ["Release"],
  );
}

// --- A directory in the way blocks (duck #1, type collision) ---
{
  const torrent = {
    infoHash: "aaaa",
    path: "D:/downloads/Movies/X",
    files: files("Release/Subs"),
  };
  assert.equal(
    applyContentLayout(
      torrent,
      asProbe({ Subs: { size: 100, owner: null, isDirectory: true } }),
    ),
    null,
  );
}

// --- Solo Leveling: the shapes that shipped nested folders to the library ---
// Reported as
//   …/Anime/Solo Leveling/Season 01/Solo Leveling S01 1080p … x265-EMBER
//   …/Anime/Solo Leveling/Season 01/Solo Leveling S02 1080p … x265-EMBER
// The season marker must be droppable when the destination already names that
// season, and must NOT be when it names a different one — filing S02 under
// Season 01 is the one case where keeping the folder is the safe answer.
{
  const S01 = "Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
  const S02 = "Solo Leveling S02 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
  const ROOT = "Solo Leveling 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
  const SEASON_01 = "D:/Torrents/Anime/Solo Leveling/Season 01";

  // Wrapped twice: both levels go.
  assert.deepEqual(
    planContentLayout(
      files(`${ROOT}/${S01}/Solo Leveling - S01E01.mkv`, `${ROOT}/${S01}/Solo Leveling - S01E02.mkv`),
      SEASON_01,
    )?.roots,
    [ROOT, S01],
  );

  // Wrapped once: the release root goes.
  assert.deepEqual(
    planContentLayout(files(`${S01}/Solo Leveling - S01E01.mkv`), SEASON_01)
      ?.roots,
    [S01],
  );
  assert.deepEqual(
    planContentLayout(
      files(`${S02}/Solo Leveling - S02E01.mkv`),
      "D:/Torrents/Anime/Solo Leveling/Season 02",
    )?.roots,
    [S02],
  );

  // A second season wrapped inside the first season's folder must survive:
  // dropping it would merge two seasons of identically numbered episodes.
  assert.deepEqual(
    planContentLayout(
      files(`${ROOT}/${S02}/Solo Leveling - S02E01.mkv`),
      SEASON_01,
    )?.roots,
    [ROOT],
  );

  // The real batch: dest is the show root, so the batch root goes and each
  // release folder becomes the season it names. Without the rename the
  // library keeps two `… x265-EMBER` folders where it wants `Season NN`.
  {
    const plan = planContentLayout(
      files(
        `${ROOT}/${S01}/S01E01-I'm Used to It [28559867].mkv`,
        `${ROOT}/${S02}/S02E02-I Suppose You Aren't Aware [15146868].mkv`,
      ),
      "D:/Torrents/Anime/Solo Leveling",
    );
    assert.deepEqual(plan?.roots, [ROOT]);
    assert.deepEqual(plan?.paths, [
      "Season 01/S01E01-I'm Used to It [28559867].mkv",
      "Season 02/S02E02-I Suppose You Aren't Aware [15146868].mkv",
    ]);
  }

  // A rename alone is enough to be worth applying — no wrapper to drop here.
  {
    const plan = planContentLayout(
      files(`${S01}/ep.mkv`, `${S02}/ep.mkv`),
      "D:/Torrents/Anime/Solo Leveling",
    );
    assert.deepEqual(plan?.roots, []);
    assert.deepEqual(plan?.paths, ["Season 01/ep.mkv", "Season 02/ep.mkv"]);
  }
}

// --- The rename never touches a folder whose season is not unambiguous ---
{
  const keep = (folder: string, why: string) =>
    assert.equal(seasonFolderRename(folder), null, why);

  keep("Season 01", "a structural folder is already right");
  keep("S01", "a structural folder is already right");
  keep("Specials", "not a season");
  keep("BDMV", "a protected folder is never rewritten");
  keep("Show S01-S02 1080p x265", "a range names two seasons");
  keep("Show S01 S03 1080p x265", "two seasons is not one season");
  keep("The Show S2", "a title without encode tokens is not a release folder");
  keep("Behind The Scenes", "no season marker at all");
  keep("Some Film 1998 1080p x265", "a year is not a season");

  assert.equal(
    seasonFolderRename("Some Show S03 1080p WEB-DL x265-GRP"),
    "Season 03",
  );
  assert.equal(
    seasonFolderRename("Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER"),
    "Season 01",
  );
  assert.equal(seasonFolderRename("Show Season 4 1080p BluRay"), "Season 04");
}

console.log("content-layout.test.ts: all assertions passed");
