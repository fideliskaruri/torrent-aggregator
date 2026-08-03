/**
 * Pure pack-file → episode mapping tests.
 *
 * The bug this guards: a completed season pack seeds real episode files beside
 * junk (featurettes that parse to "episode 01", .nfo, "Torrent Downloaded
 * From ....txt"). Mapping the junk onto episode rows offers a phantom Play.
 *
 * Run: npx tsx src/lib/torrents/pack-episode-files.test.ts
 */
import assert from "node:assert/strict";
import { packEpisodeFiles } from "./pack-episode-files";

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

console.log("\npackEpisodeFiles");

// The real Rick and Morty S02 pack file list, faithful to the evidence.
const RM_S02 = [
  {
    path: "D:\\Torrents\\Rick and Morty (2013) Season 2 S02 (1080p BluRay)\\Season 02\\Rick and Morty S02E03 One Crew over the Crewcoo's Morty (1080p BluRay).mkv",
    size: 1_500_000_000,
  },
  {
    path: "D:\\Torrents\\Rick and Morty (2013) Season 2 S02 (1080p BluRay)\\Season 02\\Rick and Morty S02E04 Total Rickall (1080p BluRay).mkv",
    size: 1_600_000_000,
  },
  {
    path: "D:\\Torrents\\Rick and Morty (2013) Season 2 S02 (1080p BluRay)\\Season 02\\Rick and Morty S02E05 Get Schwifty (1080p BluRay).mkv",
    size: 1_550_000_000,
  },
  // Junk that falsely parses to an episode — must be excluded by folder.
  // This one carries a real SxxExx so ONLY the Featurettes/Animatics folder
  // rule keeps it out (the season+episode requirement would let it through).
  {
    path: "D:\\Torrents\\Rick and Morty (2013) Season 2 S02 (1080p BluRay)\\Featurettes\\Animatics\\Rick and Morty S02E01 (Animatic Attempt 1).mkv",
    size: 40_000_000,
  },
  // Non-video junk. The .nfo names a real SxxExx (S02E09) that has NO real
  // episode file, so only the video-file rule keeps it from mapping episode 9.
  {
    path: "D:\\Torrents\\Rick and Morty (2013) Season 2 S02 (1080p BluRay)\\Season 02\\Rick and Morty S02E09.nfo",
    size: 2_000,
  },
  {
    path: "D:\\Torrents\\Rick and Morty (2013) Season 2 S02 (1080p BluRay)\\Torrent Downloaded From ExtraTorrent.txt",
    size: 100,
  },
];

check("maps real SxxExx episode files for the season", () => {
  const map = packEpisodeFiles(RM_S02, 2);
  assert.equal(map.get(3), RM_S02[0].path);
  assert.equal(map.get(4), RM_S02[1].path);
  assert.equal(map.get(5), RM_S02[2].path);
});

check("Featurettes/Animatics junk creates no phantom episode", () => {
  const map = packEpisodeFiles(RM_S02, 2);
  // "...\\Featurettes\\Animatics\\...S02E01...mkv" must not become episode 1.
  assert.equal(map.has(1), false);
});

check(".nfo and .txt files never map", () => {
  const map = packEpisodeFiles(RM_S02, 2);
  // The S02E09 .nfo must not become a (phantom) episode 9.
  assert.equal(map.has(9), false);
  // Only the three real video episodes.
  assert.equal(map.size, 3);
});

check("a file for a different season is ignored", () => {
  const map = packEpisodeFiles(
    [{ path: "X\\Season 03\\Show S03E01 Title.mkv", size: 10 }],
    2,
  );
  assert.equal(map.size, 0);
});

check("a bare leading number with no SxxExx is ignored", () => {
  const map = packEpisodeFiles(
    [{ path: "X\\Season 02\\01 - Some Title.mkv", size: 10 }],
    2,
  );
  assert.equal(map.size, 0);
});

check("Extras / Specials / Sample / Behind the Scenes segments excluded", () => {
  const files = [
    { path: "P\\Extras\\Show S02E09 Bonus.mkv", size: 10 },
    { path: "P\\Specials\\Show S02E10 Special.mkv", size: 10 },
    { path: "P\\Sample\\Show S02E11 sample.mkv", size: 10 },
    { path: "P\\Behind.the.Scenes\\Show S02E12.mkv", size: 10 },
  ];
  const map = packEpisodeFiles(files, 2);
  assert.equal(map.size, 0);
});

check("duplicate episode keeps the largest file", () => {
  const files = [
    { path: "P\\Season 02\\Show S02E01 proper.mkv", size: 2_000 },
    { path: "P\\Season 02\\Show S02E01 tiny.mkv", size: 500 },
  ];
  const map = packEpisodeFiles(files, 2);
  assert.equal(map.get(1), files[0].path);
});

console.log(
  `\n${failures === 0 ? "pack-episode-files: all tests passed" : `pack-episode-files: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
