/**
 * Section and quality-ladder tests, plus the "dune" regression.
 *
 * The bug these exist for was not a bad season number — it was asking a
 * per-work question over a whole page. So the tables below check the rule
 * class (how any work's releases arrange), and the last block proves the
 * specific failure is unreachable: five works, five cards, and no season tab
 * containing two shows.
 *
 * Run: npx tsx src/components/search/work-sections.test.ts
 */
import assert from "node:assert/strict";
import { groupReleasesByWork } from "@/lib/torrents/work-identity";
import type { MediaMetadata } from "@/lib/torrents/types";
import {
  buildSections,
  defaultSectionKey,
  qualityLadder,
  seasonCount,
  workSubtitle,
  type SectionableRelease,
} from "./work-sections";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Row extends SectionableRelease {
  id: string;
  title: string;
}

function row(
  id: string,
  title: string,
  episode?: Partial<NonNullable<SectionableRelease["episode"]>>,
): Row {
  return {
    id,
    title,
    episode: episode
      ? { isBatch: false, isSeasonPack: false, ...episode }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// buildSections
// ---------------------------------------------------------------------------

console.log("work-sections: sections…");

const SECTION_CASES: Array<{
  name: string;
  items: Row[];
  includeSeasons: boolean;
  keys: string[];
}> = [
  {
    name: "seasons come back newest first",
    items: [
      row("a", "Show S01E01", { season: 1 }),
      row("b", "Show S03E01", { season: 3 }),
      row("c", "Show S02E01", { season: 2 }),
    ],
    includeSeasons: true,
    keys: ["s3", "s2", "s1"],
  },
  {
    name: "packs get their own section, ahead of the seasons",
    items: [
      row("a", "Show S01E01", { season: 1 }),
      row("b", "Show COMPLETE", { isSeasonPack: true }),
    ],
    includeSeasons: true,
    keys: ["complete", "s1"],
  },
  {
    name: "a multi-season range is never filed under one season",
    items: [
      row("a", "Show S01-S05", { season: 1, isMultiSeason: true, isSeasonPack: true }),
      row("b", "Show S02E01", { season: 2 }),
    ],
    includeSeasons: true,
    keys: ["complete", "s2"],
  },
  {
    name: "unstructured rows fall to Everything else beside real sections",
    items: [
      row("a", "Show S01E01", { season: 1 }),
      row("b", "Show extras"),
    ],
    includeSeasons: true,
    keys: ["s1", "other"],
  },
  {
    name: "a work with no structure is one plain Results section",
    items: [row("a", "Dune 2021 1080p"), row("b", "Dune 2021 2160p")],
    includeSeasons: true,
    keys: ["other"],
  },
  {
    name: "includeSeasons=false collapses even a structured work",
    items: [
      row("a", "Show S01E01", { season: 1 }),
      row("b", "Show COMPLETE", { isSeasonPack: true }),
    ],
    includeSeasons: false,
    keys: ["other"],
  },
  { name: "nothing in, nothing out", items: [], includeSeasons: true, keys: [] },
  {
    name: "season 0 (specials) is a real season, not a falsy hole",
    items: [
      row("a", "Show S00E01", { season: 0 }),
      row("b", "Show S01E01", { season: 1 }),
    ],
    includeSeasons: true,
    keys: ["s1", "s0"],
  },
];

for (const c of SECTION_CASES) {
  check(`buildSections: ${c.name}`, () => {
    const sections = buildSections(c.items, { includeSeasons: c.includeSeasons });
    assert.deepEqual(sections.map((s) => s.key), c.keys);
    // Nothing may be hidden for structural reasons — every release stays
    // reachable in exactly one section.
    const seen = sections.flatMap((s) => s.items.map((i) => i.id)).sort();
    assert.deepEqual(seen, c.items.map((i) => i.id).sort());
  });
}

check("buildSections: rank order survives inside a section", () => {
  const sections = buildSections(
    [
      row("first", "Show S01E01", { season: 1 }),
      row("second", "Show S01E02", { season: 1 }),
      row("third", "Show S01E03", { season: 1 }),
    ],
    { includeSeasons: true },
  );
  assert.deepEqual(sections[0].items.map((i) => i.id), [
    "first",
    "second",
    "third",
  ]);
});

check("buildSections: the leftovers section renames itself when alone", () => {
  const alone = buildSections([row("a", "Dune 2021")], { includeSeasons: true });
  assert.equal(alone[0].short, "Results");
  assert.equal(alone[0].label, "Results");

  const beside = buildSections(
    [row("a", "Dune 2021"), row("b", "Show S01E01", { season: 1 })],
    { includeSeasons: true },
  );
  const other = beside.find((s) => s.key === "other")!;
  assert.equal(other.short, "Other");
  assert.equal(other.label, "Everything else");
});

const SEASON_COUNT_CASES: Array<[string[], number]> = [
  [["s1", "s2", "s3"], 3],
  [["complete", "s1", "other"], 1],
  [["complete", "other"], 0],
  [["other"], 0],
  [[], 0],
];

for (const [keys, expected] of SEASON_COUNT_CASES) {
  check(`seasonCount(${keys.join(",") || "none"})`, () => {
    const sections = keys.map((key) => ({
      key,
      label: key,
      short: key,
      items: [],
    }));
    assert.equal(seasonCount(sections), expected);
  });
}

// ---------------------------------------------------------------------------
// defaultSectionKey
// ---------------------------------------------------------------------------

console.log("work-sections: default season…");

const SECTIONS = ["complete", "s5", "s2", "s1", "other"].map((key) => ({
  key,
  label: key,
  short: key,
  items: [],
}));

const DEFAULT_CASES: Array<[string, string | null]> = [
  // The query names a season, and it exists.
  ["the bear s02", "s2"],
  ["the bear season 2", "s2"],
  ["the bear S2", "s2"],
  ["the bear s002", "s2"],
  ["The Bear Season 05", "s5"],
  // Named but absent — fall through to the newest rather than showing nothing.
  ["the bear s09", "s5"],
  // No season named: the reason to search a running show is the newest season.
  ["the bear", "s5"],
  ["", "s5"],
  // A number that is not a season marker must not be read as one.
  ["blade runner 2049", "s5"],
];

for (const [query, expected] of DEFAULT_CASES) {
  check(`defaultSectionKey("${query}")`, () => {
    assert.equal(defaultSectionKey(SECTIONS, query), expected);
  });
}

check("defaultSectionKey: falls back to the first section, then to null", () => {
  const noSeasons = [
    { key: "complete", label: "c", short: "c", items: [] },
    { key: "other", label: "o", short: "o", items: [] },
  ];
  assert.equal(defaultSectionKey(noSeasons, "dune"), "complete");
  assert.equal(defaultSectionKey([], "dune"), null);
});

// ---------------------------------------------------------------------------
// qualityLadder
// ---------------------------------------------------------------------------

console.log("work-sections: quality ladder…");

check("qualityLadder: descending rungs, unlabelled last", () => {
  const ladder = qualityLadder([
    { title: "Show 1080p x264" },
    { title: "Show 2160p HDR" },
    { title: "Show DVDRip" },
    { title: "Show 720p" },
  ]);
  assert.ok(ladder);
  assert.deepEqual(ladder.map((g) => g.key), ["q2160", "q1080", "q720", "q0"]);
  assert.equal(ladder[3].label, "Unlabelled quality");
  assert.equal(ladder[0].label, "2160p");
});

check("qualityLadder: a ladder of one rung is noise, not a ladder", () => {
  assert.equal(qualityLadder([{ title: "Show 1080p" }]), null);
  assert.equal(
    qualityLadder([{ title: "A 1080p" }, { title: "B 1080p" }]),
    null,
  );
  assert.equal(qualityLadder([]), null);
});

check("qualityLadder: nothing is dropped, and rank order holds per rung", () => {
  const items = [
    { title: "first 1080p" },
    { title: "second 2160p" },
    { title: "third 1080p" },
    { title: "fourth 1080p" },
  ];
  const ladder = qualityLadder(items)!;
  const flat = ladder.flatMap((g) => g.items.map((i) => i.title));
  assert.equal(flat.length, items.length, "a release vanished from the ladder");
  const hd = ladder.find((g) => g.key === "q1080")!;
  assert.deepEqual(hd.items.map((i) => i.title), [
    "first 1080p",
    "third 1080p",
    "fourth 1080p",
  ]);
});

// ---------------------------------------------------------------------------
// workSubtitle
// ---------------------------------------------------------------------------

console.log("work-sections: subtitle…");

const SUBTITLE_CASES: Array<[{ seasons: number; releaseCount: number }, string]> = [
  [{ seasons: 0, releaseCount: 1 }, "1 release"],
  [{ seasons: 0, releaseCount: 34 }, "34 releases"],
  [{ seasons: 1, releaseCount: 12 }, "12 releases"],
  [{ seasons: 3, releaseCount: 93 }, "3 seasons · 93 releases"],
  [{ seasons: 2, releaseCount: 1000 }, "2 seasons · 1,000 releases"],
];

for (const [input, expected] of SUBTITLE_CASES) {
  check(`workSubtitle(${JSON.stringify(input)})`, () => {
    assert.equal(workSubtitle(input), expected);
  });
}

// ---------------------------------------------------------------------------
// The regression: one "dune" page, five works
// ---------------------------------------------------------------------------

console.log("work-sections: the dune page…");

/**
 * A representative slice of the page that produced "DUNE · 2017 · 127
 * releases". Every row carries the *same wrong* catalog title, which is what
 * the old majority vote keyed on — so if identity were still taken from
 * metadata these would all collapse into one card again.
 */
function wrongCatalog(posterUrl: string | null = null): MediaMetadata {
  return {
    source: "tmdb",
    mediaType: "movie",
    externalId: "0",
    title: "Dune",
    year: 2017,
    ...(posterUrl ? { posterUrl } : {}),
  };
}

const DUNE_PAGE = [
  row("p1", "Dune.Prophecy.S01E01.The.Hidden.Hand.2160p.MAX.WEB-DL.DDP5.1.H.265", { season: 1, episode: 1 }),
  row("p2", "Dune Prophecy (2024) S01 (1080p BluRay x265 10bit EAC3 Atmos 5.1 Ghost)", { season: 1, isSeasonPack: true }),
  row("c1", "Children.of.Dune.S01.COMPLETE.720p.BluRay.x264-GalaxyTV", { season: 1, isSeasonPack: true }),
  row("c2", "Children.of.Dune.S01E02.720p.BluRay.x264", { season: 1, episode: 2 }),
  row("f84", "Dune.1984.1080p.BluRay.x264-SWTYBLZ"),
  row("f21", "Dune.2021.2160p.WEB-DL.DDP5.1.Atmos.HDR.HEVC-CMRG"),
  row("f21b", "Dune 2021 1080p BluRay x264-RARBG"),
  row("p2t", "Dune.Part.Two.2024.2160p.WEB-DL.HDR.H265-FLUX"),
];

const dune = groupReleasesByWork(
  DUNE_PAGE,
  (t) => t.title,
  () => wrongCatalog(),
);

check("dune: one shared wrong catalog title still yields five works", () => {
  assert.equal(
    dune.length,
    5,
    `expected 5 works, got ${dune.length}: ${dune.map((g) => g.key).join(" | ")}`,
  );
});

check("dune: every release lands in exactly one work", () => {
  const seen = dune.flatMap((g) => g.items.map((i) => i.id)).sort();
  assert.deepEqual(seen, DUNE_PAGE.map((r) => r.id).sort());
});

check("dune: no season section ever mixes two shows", () => {
  // The harmful failure: clicking S01 and getting another series' episodes.
  for (const work of dune) {
    const sections = buildSections(work.items, {
      includeSeasons: work.isSeries,
    });
    for (const section of sections) {
      const shows = new Set(
        section.items.map((i) =>
          /children/i.test(i.title) ? "children-of-dune" : "dune-prophecy",
        ),
      );
      assert.ok(
        shows.size <= 1,
        `${work.key} / ${section.key} mixed: ${[...shows].join(" + ")}`,
      );
    }
  }
});

check("dune: the two Prophecy releases share a season, the two shows do not", () => {
  const prophecy = dune.find((g) => g.items.some((i) => i.id === "p1"))!;
  const children = dune.find((g) => g.items.some((i) => i.id === "c1"))!;
  assert.notEqual(prophecy.key, children.key, "two series merged");
  assert.ok(prophecy.items.some((i) => i.id === "p2"), "S01 pack left its show");
  assert.ok(children.items.some((i) => i.id === "c2"));
});

check("dune: the 1984 and 2021 films are separate works", () => {
  const f84 = dune.find((g) => g.items.some((i) => i.id === "f84"))!;
  const f21 = dune.find((g) => g.items.some((i) => i.id === "f21"))!;
  assert.notEqual(f84.key, f21.key, "two films of the same name merged");
  assert.equal(f84.year, 1984);
  assert.equal(f21.year, 2021);
  // Both 2021 prints belong to the same film.
  assert.ok(f21.items.some((i) => i.id === "f21b"));
});

check("dune: each heading counts only its own releases", () => {
  // The original lie was "127 releases" under one name. A work's count must
  // equal the number of rows its card actually draws.
  let total = 0;
  for (const work of dune) {
    const sections = buildSections(work.items, {
      includeSeasons: work.isSeries,
    });
    const drawn = sections.reduce((n, s) => n + s.items.length, 0);
    assert.equal(
      drawn,
      work.items.length,
      `${work.key} draws ${drawn} rows but claims ${work.items.length}`,
    );
    total += work.items.length;
    assert.ok(
      work.items.length < DUNE_PAGE.length,
      `${work.key} claims the whole page`,
    );
  }
  assert.equal(total, DUNE_PAGE.length);
});

check("dune: series carry no year, films do", () => {
  for (const work of dune) {
    if (work.isSeries) {
      assert.equal(work.year, null, `${work.key} put a year on a series`);
    } else {
      assert.ok(work.year, `${work.key} is a film with no year`);
    }
  }
});

check("dune: a poster is never borrowed from a disagreeing catalog row", () => {
  // Every row here carries the same "Dune" catalog match. Works whose name is
  // not "Dune" must not inherit its artwork.
  const withPoster = groupReleasesByWork(
    DUNE_PAGE,
    (t) => t.title,
    () => wrongCatalog("https://x/dune.jpg"),
  );
  for (const work of withPoster) {
    // Keyed on `key`, not `name`: the group name is the field a mismatched
    // catalog row would overwrite, so asserting on it could silently stop
    // testing anything. Only the two works actually *called* Dune may wear it.
    const mayWearIt = work.key === "film:dune:2021" || work.key === "film:dune:1984";
    assert.equal(
      work.posterUrl,
      mayWearIt ? "https://x/dune.jpg" : null,
      `${work.key} drew the wrong artwork`,
    );
  }
});

check("dune: the five headings the UI draws are all distinct", () => {
  // The UI renders `work.name` and `work.year` verbatim, so this asserts the
  // contract it depends on: one shared, wrong catalog title across the page
  // must not collapse five works into five identical headings.
  const headings = dune.map((work) =>
    work.year ? `${work.name} ${work.year}` : work.name,
  );
  assert.equal(
    new Set(headings).size,
    dune.length,
    `headings collide: ${headings.join(" | ")}`,
  );
  for (const expected of [
    "Dune Prophecy",
    "Children of Dune",
    "Dune 1984",
    "Dune 2021",
    "Dune Part Two 2024",
  ]) {
    assert.ok(
      headings.includes(expected),
      `missing heading ${expected} in ${headings.join(" | ")}`,
    );
  }
});

console.log(
  failures === 0
    ? "All work-sections tests passed."
    : `${failures} work-sections test(s) failed.`,
);
if (failures > 0) process.exit(1);
