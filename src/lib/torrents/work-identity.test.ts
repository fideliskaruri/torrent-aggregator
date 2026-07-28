import assert from "node:assert/strict";

import {
  catalogAgrees,
  groupReleasesByWork,
  releaseYear,
  workIdentity,
} from "./work-identity";
import type { MediaMetadata } from "./types";

/**
 * A catalog row. Only `title` and `posterUrl` matter to work identity; the
 * rest are required by `MediaMetadata` and are inert here.
 */
function catalog(title: string, posterUrl: string | null = null): MediaMetadata {
  return { source: "tmdb", mediaType: "movie", externalId: "0", title, posterUrl };
}

/**
 * The regression this module exists for.
 *
 * These are real release names from a live "dune" search that rendered as a
 * single card headed "DUNE · 2017 · 127 releases", with an S01 tab that mixed
 * Dune: Prophecy episodes into Children of Dune episodes.
 */
const DUNE_RELEASES = [
  "Dune.Prophecy.S01E01.The.Hidden.Hand.2160p.MAX.WEB-DL.DDP5.1.Atmos.HDR.H.265-NTb",
  "Dune Prophecy (2024) S01 (1080p BluRay x265 10bit EAC3 Atmos 5.1 Ghost)",
  "Dune.Prophecy.S01E01.WEB.x264-TORRENTGALAXY",
  "Children.of.Dune.S01.COMPLETE.720p.BluRay.x264-GalaxyTV",
  "Dune.2021.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.TrueHD.7.1.Atmos-SWTYBLZ",
  "Dune.Part.Two.2024.1080p.WEBRip.x264-RARBG",
  "Dune.1984.1080p.BluRay.x264-CiNEFiLE",
];

// --- Distinct works stay distinct ---
// This is the whole point. Five works, five groups. The old page produced one.
{
  const groups = groupReleasesByWork(DUNE_RELEASES, (t) => t);
  assert.equal(
    groups.length,
    5,
    `expected 5 distinct works, got ${groups.length}: ${groups.map((g) => g.key).join(", ")}`,
  );
}

// --- Dune: Prophecy is one series across three different release spellings ---
// An episode, a season pack with a parenthesised year, and a bare WEB rip.
// If the year leaked into a series key these would split three ways.
{
  const prophecy = DUNE_RELEASES.filter((t) => /Prophecy/i.test(t));
  const groups = groupReleasesByWork(prophecy, (t) => t);
  assert.equal(groups.length, 1, "Dune: Prophecy must be a single work");
  assert.equal(groups[0].items.length, 3);
  assert.equal(groups[0].isSeries, true);
  assert.equal(groups[0].year, null, "a series has no identifying year");
}

// --- Children of Dune never joins Dune: Prophecy ---
// Both declare S01. Bucketing on the season number alone put them in one list.
{
  const groups = groupReleasesByWork(
    [
      "Dune.Prophecy.S01E01.The.Hidden.Hand.2160p.MAX.WEB-DL",
      "Children.of.Dune.S01.COMPLETE.720p.BluRay.x264-GalaxyTV",
    ],
    (t) => t,
  );
  assert.equal(groups.length, 2, "two different S01 shows must not merge");
}

// --- Same name, different year, different film ---
{
  const groups = groupReleasesByWork(
    ["Dune.2021.2160p.UHD.BluRay.x265", "Dune.1984.1080p.BluRay.x264-CiNEFiLE"],
    (t) => t,
  );
  assert.equal(groups.length, 2, "Dune 1984 and Dune 2021 are different films");
  const years = groups.map((g) => g.year).sort();
  assert.deepEqual(years, [1984, 2021]);
}

// --- Several prints of one film collapse into one group ---
{
  const groups = groupReleasesByWork(
    [
      "Dune.2021.2160p.UHD.BluRay.x265.10bit.HDR.TrueHD.7.1.Atmos-SWTYBLZ",
      "Dune.2021.1080p.WEBRip.x264-RARBG",
      "Dune (2021) [1080p] [BluRay] [5.1] [YTS.MX]",
    ],
    (t) => t,
  );
  assert.equal(groups.length, 1, "three prints of Dune 2021 are one film");
  assert.equal(groups[0].items.length, 3);
}

// --- Site prefixes are not part of the work ---
//
// Some indexers glue their own hostname onto the front of every torrent they
// return. That prefix is not a release group, a studio, or a title word; it is
// the web page that carried the result. Leaving it in the release-derived name
// made `www.SomeTracker.to - Inside.Out.2.2024...` key apart from the clean
// `Inside.Out.2.2024...` print, so one film rendered as two browse cards. The
// rule is deliberately shape-based rather than tied to that tracker: a leading
// hostname-like token wrapped in brackets or followed by a separator is site
// furniture, but a real dot-separated title without that prefix boundary is
// still the title.
{
  const SITE_PREFIX_CASES: [string, string][] = [
    ["www.SomeTracker.to - Inside.Out.2.2024.1080p.WEB-DL.x264", "Inside Out 2"],
    ["SomeTracker.com - Inside.Out.2.2024.2160p.WEB-DL.HDR.x265", "Inside Out 2"],
    ["[some-tracker.to] Inside.Out.2.2024.1080p.WEB-DL.x264", "Inside Out 2"],
    ["(some-tracker.net) - Inside.Out.2.2024.1080p.WEB-DL.x264", "Inside Out 2"],
    ["[ www.Torrenting.com ] - Arrival.2016.1080p.BluRay.x264", "Arrival"],
  ];
  for (const [raw, expected] of SITE_PREFIX_CASES) {
    assert.equal(
      workIdentity(raw).name,
      expected,
      `leading tracker hostname must be dropped from "${raw}"`,
    );
  }

  const insideOut = groupReleasesByWork(
    [
      "www.SomeTracker.to - Inside.Out.2.2024.1080p.WEB-DL.x264",
      "Inside.Out.2.2024.2160p.WEB-DL.HDR.x265",
    ],
    (t) => t,
  );
  assert.equal(
    insideOut.length,
    1,
    `site-prefixed and clean Inside Out 2 prints are one film, got ${insideOut.length}: ` +
      insideOut.map((g) => `"${g.name}"`).join(", "),
  );

  const REAL_DOTTED_TITLES: [string, string][] = [
    ["Mr.Robot.S01E01.1080p.WEB-DL.x264", "Mr Robot"],
    ["Dr.No.1962.1080p.BluRay.x264", "Dr No"],
    ["Fear.com.2002.1080p.BluRay.x264", "Fear com"],
    ["Inside.Out.2.2024.2160p.WEB-DL.HDR.x265", "Inside Out 2"],
  ];
  for (const [raw, expected] of REAL_DOTTED_TITLES) {
    assert.equal(
      workIdentity(raw).name,
      expected,
      `a real dot-separated title must not be eaten as a tracker prefix: "${raw}"`,
    );
  }
}

// --- A film's name does not keep its year ---
// "Dune 2021" as a heading is the same film listed twice next to "Dune".
{
  const id = workIdentity("Dune.2021.2160p.UHD.BluRay.x265");
  assert.equal(id.year, 2021);
  assert.match(id.name, /^Dune$/i, `name should be "Dune", got "${id.name}"`);
}

// --- Three defects found on a live "breaking bad" search ---
//
// All three were invisible to the synthetic Dune fixtures because every one of
// those release names carries a year *and* a quality token, so a cut always
// fires before the trailing-token cleanup is reached. Real indexer results
// routinely carry neither.
{
  // 1. The last word of an ordinary title is not a scene group. A bare space
  //    is not a group delimiter; a hyphen or underscore is.
  const bare = workIdentity("Breaking Bad");
  assert.equal(
    bare.name,
    "Breaking Bad",
    `a plain two-word title must survive intact, got "${bare.name}"`,
  );

  // 2. A bracket block longer than the 48-character strip cap is not removed
  //    as a block, so the quality cut fires *inside* it and strands the
  //    opening bracket on the end of the name. The inner text here is 56
  //    characters; trim it under the cap and this stops reproducing, which is
  //    why the length is called out rather than left to look incidental.
  const dangling = workIdentity(
    "El Camino - A Breaking Bad Movie (2019) (1080p BluRay x265 HEVC 10bit AAC 5.1 Tigole QxR Extended)",
  );
  assert.ok(
    !/[[({]\s*$/.test(dangling.name),
    `name must not end in an unbalanced bracket, got "${dangling.name}"`,
  );
  assert.equal(dangling.name, "El Camino - A Breaking Bad Movie");

  // 3. ...and with both fixed, the two prints of El Camino are one film
  //    rather than two works whose names differ only by the truncation.
  const elCamino = groupReleasesByWork(
    [
      "El Camino - A Breaking Bad Movie (2019) (1080p BluRay x265 HEVC 10bit AAC 5.1 Tigole)",
      "El Camino A Breaking Bad Movie (2019) [1080p] [WEBRip]",
      "El.Camino.A.Breaking.Bad.Movie.2019.1080p.NF.WEB-DL.DDP5.1.H264-",
    ],
    (t) => t,
  );
  assert.equal(
    elCamino.length,
    1,
    `three prints of El Camino are one film, got ${elCamino.length}: ` +
      elCamino.map((g) => `"${g.name}"`).join(", "),
  );
}

// --- A scene group is still stripped when it is hyphen-delimited ---
{
  const grouped = workIdentity("Some.Obscure.Film.2019.1080p.BluRay.x264-RARBG");
  assert.equal(grouped.name, "Some Obscure Film");
}

// --- An indexer's trailing number must not fork a film into two works ---
//
// Observed live on a "dune" search: `Dune Part Two (2024) [1080p] [WEBRip] 88`
// keyed as `film:dune part two 88:2024` and rendered as a SECOND "Dune Part
// Two 88" work next to the real one, with no poster — no artwork provider can
// match a title with a stray number welded on. Both cut anchors (the year and
// the quality token) sat inside bracketed blocks, so the block-strip removed
// them before any cut could fire and the suffix survived into the name.
//
// The cases below are paired on purpose: the rule must delete the junk suffix
// WITHOUT touching the many real titles that legitimately end in a number.
// A blanket strip of trailing digits is the same bug pointed at more films.
{
  const JUNK_SUFFIX_CASES: [string, string][] = [
    ["Dune Part Two (2024) [1080p] [WEBRip] 88", "Dune Part Two"],
    ["Dune (2021) [2160p] [BluRay] 105", "Dune"],
    ["Arrival (2016) [1080p] [WEBRip] 7", "Arrival"],
  ];
  for (const [raw, expected] of JUNK_SUFFIX_CASES) {
    assert.equal(
      workIdentity(raw).name,
      expected,
      `trailing indexer number must be dropped from "${raw}"`,
    );
  }

  // Titles that really do end in a number. None of these has digits after a
  // closing bracket, which is exactly what makes them distinguishable.
  const REAL_NUMERIC_TITLES: [string, string][] = [
    ["Toy Story 5 (2026) [1080p] [WEBRip]", "Toy Story 5"],
    ["Alien 3 (1992) [1080p] [BluRay]", "Alien 3"],
    ["Ocean's 11 (1960) [720p] [BluRay]", "Ocean's 11"],
    ["1917.2019.1080p.BluRay.x264-SPARKS", "1917"],
    ["300.2006.2160p.UHD.BluRay.x265-TERMiNAL", "300"],
    ["Toy.Story.4.2019.1080p.WEBRip.x264-RARBG", "Toy Story 4"],
  ];
  for (const [raw, expected] of REAL_NUMERIC_TITLES) {
    assert.equal(
      workIdentity(raw).name,
      expected,
      `a title that genuinely ends in a number must survive: "${raw}"`,
    );
  }

  // The point of the fix: both prints are ONE work, not two.
  const dune = groupReleasesByWork(
    [
      "Dune Part Two (2024) [1080p] [WEBRip] 88",
      "Dune Part Two (2024) [2160p] [WEBRip]",
      "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX",
    ],
    (t) => t,
  );
  assert.equal(
    dune.length,
    1,
    `three prints of Dune Part Two are one film, got ${dune.length}: ` +
      dune.map((g) => `"${g.name}"`).join(", "),
  );

  // ...and Toy Story 5 must not be collapsed into Toy Story 4 by an
  // over-eager strip.
  const toys = groupReleasesByWork(
    ["Toy Story 5 (2026) [1080p] [WEBRip]", "Toy Story 4 (2019) [1080p] [WEBRip]"],
    (t) => t,
  );
  assert.equal(
    toys.length,
    2,
    `Toy Story 4 and 5 are different films, got ${toys.length}: ` +
      toys.map((g) => `"${g.name}"`).join(", "),
  );
}

// --- Year extraction ---
const YEAR_CASES: [string, number | null][] = [
  ["Dune.2021.2160p.UHD.BluRay.x265", 2021],
  ["Dune.1984.1080p.BluRay.x264", 1984],
  ["Dune.Part.Two.2024.1080p.WEBRip", 2024],

  // A title that is itself a number, followed by the real year. Taking the
  // first match would call the 2009 film "2012" a 2012 release.
  ["2012.2009.1080p.BluRay.x264", 2009],

  // Numbers in a title that are not years. Without the ceiling these read as
  // future releases and the real year is lost.
  ["Blade.Runner.2049.2017.2160p.UHD.BluRay", 2017],
  ["Death.Race.2000.1975.1080p.BluRay", 1975],

  // Resolution and codec tokens must never be mistaken for years.
  ["Some.Movie.2160p.x265.10bit", null],
  ["Some.Movie.1080p.DDP5.1.Atmos", null],

  ["No year at all here", null],
  ["", null],
];

for (const [title, expected] of YEAR_CASES) {
  assert.equal(
    releaseYear(title),
    expected,
    `releaseYear(${JSON.stringify(title)}) should be ${expected}`,
  );
}

// --- Series detection drives which identity rule applies ---
const SERIES_CASES: [string, boolean][] = [
  ["Dune.Prophecy.S01E01.The.Hidden.Hand.2160p", true],
  ["Children.of.Dune.S01.COMPLETE.720p", true],
  ["Dune Prophecy (2024) S01 (1080p BluRay x265)", true],
  ["The.Bear.S03E05.1080p.WEB.h264", true],
  ["Dune.2021.2160p.UHD.BluRay.x265", false],
  ["Dune.Part.Two.2024.1080p.WEBRip.x264-RARBG", false],
];

for (const [title, expected] of SERIES_CASES) {
  assert.equal(
    workIdentity(title).isSeries,
    expected,
    `${JSON.stringify(title)} isSeries should be ${expected}`,
  );
}

// --- A wrong catalog match cannot merge two works ---
// This is the exact failure that produced "DUNE · 2017". Both releases are
// enriched with the same bogus catalog row; identity must ignore it.
{
  const bogus = {
    source: "tmdb" as const,
    mediaType: "movie" as const,
    externalId: "0",
    title: "DUNE",
    year: 2017,
  };
  const groups = groupReleasesByWork(
    [
      { title: "Dune.Prophecy.S01E01.2160p.MAX.WEB-DL", metadata: bogus },
      { title: "Children.of.Dune.S01.COMPLETE.720p.BluRay", metadata: bogus },
      { title: "Dune.1984.1080p.BluRay.x264", metadata: bogus },
    ],
    (r) => r.title,
    (r) => r.metadata,
  );
  assert.equal(
    groups.length,
    3,
    "a shared wrong catalog title must not merge three distinct works",
  );
}

// --- A correct catalog match improves the label but not the grouping ---
// TMDB writes "Dune: Prophecy"; the release name drops the colon. The nicer
// spelling is worth borrowing; the grouping was already right without it.
{
  const groups = groupReleasesByWork(
    [
      {
        title: "Dune.Prophecy.S01E01.2160p.MAX.WEB-DL",
        metadata: {
          source: "tmdb" as const,
          mediaType: "tv" as const,
          externalId: "1",
          title: "Dune: Prophecy",
          posterUrl: "https://example.test/p.jpg",
        },
      },
      { title: "Dune.Prophecy.S01E02.2160p.MAX.WEB-DL", metadata: null },
    ],
    (r) => r.title,
    (r) => r.metadata,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "Dune: Prophecy");
  assert.equal(groups[0].posterUrl, "https://example.test/p.jpg");
}

// --- A poster is never borrowed from a disagreeing catalog row ---
// Artwork is a strong claim about identity; showing the wrong show's poster is
// the most convincing way to be wrong.
{
  const groups = groupReleasesByWork(
    [
      {
        title: "Children.of.Dune.S01.COMPLETE.720p.BluRay",
        metadata: {
          source: "tmdb" as const,
          mediaType: "tv" as const,
          externalId: "2",
          title: "Breaking Bad",
          posterUrl: "https://example.test/wrong.jpg",
        },
      },
    ],
    (r) => r.title,
    (r) => r.metadata,
  );
  assert.equal(groups[0].posterUrl, null, "must not borrow a disagreeing poster");
  assert.match(groups[0].name, /Children of Dune/i);
}

// --- Rank order is preserved ---
// The list arrives ranked. Grouping must not silently reorder it, or the best
// result stops being first.
{
  const ordered = [
    "Dune.Prophecy.S01E01.2160p",
    "Dune.1984.1080p.BluRay",
    "Dune.Prophecy.S01E02.2160p",
  ];
  const groups = groupReleasesByWork(ordered, (t) => t);
  assert.equal(groups[0].items[0], "Dune.Prophecy.S01E01.2160p");
  assert.equal(groups[0].items[1], "Dune.Prophecy.S01E02.2160p");
  assert.match(groups[1].items[0], /1984/);
}

// --- Empty and degenerate input ---
assert.deepEqual(groupReleasesByWork([], (t: string) => t), []);
{
  // A title that cleans down to nothing must still produce a usable group
  // rather than throwing or collapsing every such release together silently.
  const groups = groupReleasesByWork(["1080p.x265"], (t) => t);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].name.length > 0, "a group must always have a name");
}

// --- A vaguer catalog title must never overwrite a specific one ---
//
// This is the defect that made a *correct* five-way split render as five
// identical "Dune" headings under five copies of one poster. Enrichment
// matched several distinct works onto a single catalog row titled "Dune";
// because containment was bidirectional, that vaguer title was accepted as
// the label for every one of them.
{
  const vague = catalog("Dune", "https://img/dune.jpg");

  const prophecy = workIdentity("Dune.Prophecy.S01E01.2160p.MAX.WEB-DL", vague);
  assert.equal(
    prophecy.name,
    "Dune Prophecy",
    "a catalog title contained by the release name must not replace it",
  );

  const children = workIdentity(
    "Children.of.Dune.S01.COMPLETE.720p.BluRay.x264-GalaxyTV",
    vague,
  );
  assert.equal(
    children.name,
    "Children of Dune",
    "a vaguer catalog title must not blur a more specific work",
  );
}

// The catalog is still allowed to *refine* a name — that is why it is consulted
// at all. Only the blurring direction is forbidden.
{
  const refined = workIdentity(
    "Dune Prophecy S01E01 1080p WEB-DL",
    catalog("Dune: Prophecy"),
  );
  assert.equal(
    refined.name,
    "Dune: Prophecy",
    "a catalog title at least as specific as the release name is preferred",
  );

  const suffixed = workIdentity(
    "The Office S02E01 1080p WEB-DL",
    catalog("The Office (US)"),
  );
  assert.equal(
    suffixed.name,
    "The Office (US)",
    "a catalog title that adds a disambiguator is a refinement, not a blur",
  );
}

// And a poster is a strong claim about identity, so it may not be borrowed
// from a row whose title the work disagrees with.
{
  const groups = groupReleasesByWork(
    [
      "Children.of.Dune.S01.COMPLETE.720p.BluRay.x264-GalaxyTV",
      "Dune.Prophecy.S01E01.2160p.MAX.WEB-DL",
    ],
    (t) => t,
    () => catalog("Dune", "https://img/dune.jpg"),
  );
  assert.equal(groups.length, 2, "a shared vague catalog row must not merge works");
  for (const g of groups) {
    assert.equal(
      g.posterUrl,
      null,
      `${g.name} must not wear a poster borrowed from a vaguer catalog match`,
    );
    assert.notEqual(g.name, "Dune", `${g.name} must keep its own name`);
  }
}

// --- catalogAgrees: a bare title must not borrow a spin-off's metadata ---
//
// The mirror image of the "vaguer catalog" bug above. A title page for the 2021
// film "Dune" — which had no cached row of its own — contains-matched the longer
// cached rows "Dune: Prophecy" (a 2024 series) and "Dune: Part Two", and rendered
// the spin-off's poster and synopsis full-bleed. A colon/spaced-dash subtitle is
// a distinct work, not a refinement.
{
  // Rejections: a bare name never agrees with a subtitle spin-off.
  assert.equal(catalogAgrees("Dune", "Dune: Prophecy"), false);
  assert.equal(catalogAgrees("Dune", "Dune: Part Two"), false);
  assert.equal(catalogAgrees("Dune", "Dune - Part Two"), false);
  // Reverse containment stays rejected (the "blur" direction).
  assert.equal(catalogAgrees("Children of Dune", "Dune"), false);

  // Acceptances: equality after punctuation, and a parenthetical disambiguator.
  assert.equal(catalogAgrees("Dune Prophecy", "Dune: Prophecy"), true);
  assert.equal(catalogAgrees("The Office", "The Office (US)"), true);
  assert.equal(catalogAgrees("Dune", "Dune"), true);
  // A hyphenated single word ("Spider-Man") is not a subtitle boundary.
  assert.equal(catalogAgrees("Spider-Man", "Spider-Man (2002)"), true);
}

console.log("work-identity: ok");
