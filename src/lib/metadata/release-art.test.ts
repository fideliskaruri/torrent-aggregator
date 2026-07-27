/**
 * Release names are the only thing the Client, Activity and Download-log pages
 * hold, so every poster on those three surfaces depends on this file getting
 * `Dune.Prophecy.S01E01.The.Hidden.Hand.2160p.MAX.WEB-DL…` down to
 * "Dune Prophecy" and nothing else.
 *
 * The table below is not invented: every left-hand string is a name taken from
 * the seeded database or from a live indexer response, which is how the
 * *Blade Runner 2049* regression turned up — the year scanner used to stop at
 * the first `20xx` it saw and threw away half the title.
 */
import assert from "node:assert/strict";
import {
  artworkKey,
  artworkQueryForRelease,
  distinctArtworkQueries,
} from "./release-art";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

/** [release name, stored category, expected title, expected year] */
const PARSE: [string, string | null, string, number | null][] = [
  // Season/episode marker — the episode title is not noise a denylist can see.
  [
    "Dune.Prophecy.S01E01.The.Hidden.Hand.2160p.MAX.WEB-DL.DDP5.1.Atmos.HDR.H.265-NTb",
    "tv",
    "Dune Prophecy",
    null,
  ],
  ["The.Bear.S03E06.1080p.BluRay.x265.DDP5.1-GalaxyTV", "tv", "The Bear", null],
  ["Silo.S02E09.1080p.ATVP.WEB-DL.DDP5.1.Atmos.H.264-FLUX", "tv", "Silo", null],
  ["Breaking Bad S05E14 Ozymandias 1080p BluRay x265-RARBG", null, "Breaking Bad", null],
  // A season marker after a year: the year is kept, the title still ends early.
  ["Shogun.2024.S01.COMPLETE.1080p.DSNP.WEB-DL.DDP5.1.H.264-NTb", "tv", "Shogun", 2024],
  // Fansub episode dash, with the container extension stripped.
  [
    "[SubsPlease] Sousou no Frieren - 28 (1080p) [F1D2A9C0].mkv",
    "anime",
    "Sousou no Frieren",
    null,
  ],
  ["One Piece - 1122 (1080p) [SubsPlease]", null, "One Piece", null],
  // Plain year marker.
  ["Arrival.2016.1080p.BluRay.x264.DTS-HD.MA.7.1-SWTYBLZ", "movie", "Arrival", 2016],
  [
    "Dune.Part.Two.2024.2160p.BluRay.REMUX.HDR.DV.TrueHD.7.1.Atmos-FraMeSToR",
    "movie",
    "Dune Part Two",
    2024,
  ],
  ["Dune Part Two (2024) [1080p] [WEBRip] 88", "movie", "Dune Part Two", 2024],
  // A four-digit number that belongs to the title, with and without a release
  // year following it. Both used to lose everything after "Blade Runner".
  ["Blade Runner 2049 2017 2160p UHD BluRay x265-TERMiNAL", "movie", "Blade Runner 2049", 2017],
  ["Blade Runner 2049 2160p UHD BluRay x265-TERMiNAL", "movie", "Blade Runner 2049", null],
  ["1917 (2019) [1080p] [BluRay]", "movie", "1917", 2019],
  ["2012.2009.1080p.BluRay.x264", "movie", "2012", 2009],
  // No year, no episode, no resolution: the last-resort path. The title's own
  // four-digit number has to survive it, and the technical tail must not.
  ["Blade Runner 2049 REPACK", "movie", "Blade Runner 2049", null],
  ["Arrival x264 5.1ch", "movie", "Arrival", null],
  // A bare file name — the client stores these verbatim for single-file
  // torrents, and "The Quiet Cartographer mkv" matches nothing anywhere.
  ["The Quiet Cartographer.mkv", null, "The Quiet Cartographer", null],
  // A tracker's own name stamped on the front. Taken verbatim from this app's
  // torrent list, where it rendered a card captioned "Rick and Morty" beside a
  // letter tile reading "W".
  [
    "www.UIndex.org - Rick and Morty S01E01 Pilot 1080p AMZN WEB-DL DDP5.1 H.264",
    null,
    "Rick and Morty",
    null,
  ],
  ["[ www.Torrenting.com ] - Arrival.2016.1080p.BluRay.x264", "movie", "Arrival", 2016],
  // A dotted title is not a site tag: only a real TLD counts. (Dots become
  // spaces via the shared title cleaner — that is pre-existing behaviour.)
  ["S.W.A.T.2017.S01E01.1080p.WEB-DL", "tv", "S W A T", 2017],
];

for (const [name, category, title, year] of PARSE) {
  check(`parses ${name.slice(0, 46)}`, () => {
    const q = artworkQueryForRelease(name, category);
    assert.equal(q.title, title);
    assert.equal(q.year, year);
  });
}

check("a stored category is used verbatim", () => {
  assert.equal(artworkQueryForRelease("Arrival.2016.1080p.BluRay", "movie").mediaType, "movie");
  assert.equal(artworkQueryForRelease("Some Show S01E01 1080p", "anime").mediaType, "anime");
});

check("a season marker means television when nothing said so", () => {
  assert.equal(artworkQueryForRelease("Silo.S02E09.1080p.ATVP.WEB-DL").mediaType, "tv");
});

check("a fansub tag with an episode dash means anime", () => {
  // The download log stores no category at all, so this inference is the only
  // thing routing One Piece at AniList instead of guessing.
  assert.equal(
    artworkQueryForRelease("One Piece - 1122 (1080p) [SubsPlease]").mediaType,
    "anime",
  );
});

check("an episode dash without a fansub tag is television, not anime", () => {
  assert.equal(artworkQueryForRelease("Some Show - 12 1080p WEB-DL").mediaType, "tv");
});

check("a year and no episode marker means a film", () => {
  assert.equal(artworkQueryForRelease("Arrival 2016 1080p BluRay x264").mediaType, "movie");
});

check("nothing structural means no guess", () => {
  assert.equal(artworkQueryForRelease("Some Unlabelled Thing").mediaType, null);
});

check("a stored category overrules what the name looks like", () => {
  // `Shogun.2024.S01…` looks like television and is; `Dune Part Two (2024)`
  // looks like a film and is. The one that matters is a name that lies —
  // an anime released with scene-style episode numbering.
  assert.equal(
    artworkQueryForRelease("Sousou no Frieren S01E28 1080p WEB-DL", "anime").mediaType,
    "anime",
  );
});

check("the key ignores punctuation and case", () => {
  assert.equal(artworkKey("The Bear", null), artworkKey("the.bear", null));
  assert.equal(artworkKey("Dune: Part Two", 2024), artworkKey("Dune Part Two", 2024));
});

check("the key keeps two films of the same name apart", () => {
  assert.notEqual(artworkKey("Dune", 1984), artworkKey("Dune", 2021));
});

check("the key does not depend on media type", () => {
  // The activity log carries a category and the download log does not, for the
  // very same send. If media type were in the key those two rows would be two
  // lookups and could show two different posters on one screen. The name here
  // is deliberately structureless, so inference cannot quietly supply the same
  // media type to both and make the comparison prove nothing.
  const typed = artworkQueryForRelease("The Quiet Cartographer", "movie");
  const untyped = artworkQueryForRelease("The Quiet Cartographer");
  assert.equal(typed.mediaType, "movie");
  assert.equal(untyped.mediaType, null);
  assert.equal(typed.key, untyped.key);
});

check("distinct queries collapse a show's episodes to one lookup", () => {
  const queries = distinctArtworkQueries([
    { name: "The.Bear.S03E06.1080p.BluRay.x265-GalaxyTV", category: "tv" },
    { name: "The.Bear.S03E07.1080p.BluRay.x265-GalaxyTV", category: "tv" },
    { name: "The Bear S03E08 1080p WEB-DL", category: "tv" },
  ]);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].title, "The Bear");
});

check("distinct queries keep first-appearance order", () => {
  const queries = distinctArtworkQueries([
    { name: "Silo.S02E09.1080p.ATVP.WEB-DL", category: "tv" },
    { name: "Arrival.2016.1080p.BluRay", category: "movie" },
    { name: "Silo.S02E10.1080p.ATVP.WEB-DL", category: "tv" },
  ]);
  assert.deepEqual(
    queries.map((q) => q.title),
    ["Silo", "Arrival"],
  );
});

check("a typed row teaches an untyped row of the same work", () => {
  // Structureless on purpose: with a name the inference can read, both rows
  // would already agree and this would assert nothing.
  const queries = distinctArtworkQueries([
    { name: "The Quiet Cartographer", category: null },
    { name: "The Quiet Cartographer", category: "movie" },
  ]);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].mediaType, "movie");
});

check("blank names are dropped rather than queried", () => {
  const queries = distinctArtworkQueries([
    { name: "   " },
    { name: "" },
    { name: "Arrival.2016.1080p.BluRay", category: "movie" },
  ]);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].title, "Arrival");
});

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("  all passed");
