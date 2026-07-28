/**
 * Rail organization tests — the "one item, one state" rules that keep a title
 * from appearing in three rails at once, keep mid-download items out of
 * "Ready to Play", and keep movies and series from jumbling.
 *
 * Table-driven over diverse inputs. Each case asserts the rule class, not one
 * example, and each is chosen so it would fail on the pre-fix behaviour (no
 * cross-rail dedupe, no media split, and "Ready to Play" admitting partial
 * downloads).
 *
 * Run: npx tsx src/lib/browse/rails-organization.test.ts
 */
import assert from "node:assert/strict";
import type { Rail, RailItem } from "./types";
import {
  dedupeAcrossRails,
  splitRailByMediaType,
  mediaGroupOf,
  railItemWorkKey,
  readyToPlayTorrentCanSurface,
} from "./rails";

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

function item(partial: Partial<RailItem> & { title: string }): RailItem {
  return {
    id: partial.id ?? partial.title,
    title: partial.title,
    subtitle: partial.subtitle ?? null,
    posterUrl: null,
    backdropUrl: null,
    availability: partial.availability ?? null,
    progressFraction: partial.progressFraction ?? null,
    resumePositionSec: null,
    infoHash: partial.infoHash ?? null,
    filePath: null,
    watchListItemId: null,
    mediaType: partial.mediaType ?? null,
    season: partial.season ?? null,
    episode: partial.episode ?? null,
  };
}

function rail(id: string, title: string, items: RailItem[]): Rail {
  return { id, title, items };
}

// ---------------------------------------------------------------------------
// readyToPlayTorrentCanSurface — nothing mid-download is "ready to play"
// ---------------------------------------------------------------------------

console.log("\n--- ready-to-play membership excludes mid-download ---");

const SURFACE_CASES: Array<{
  name: string;
  progress: number;
  status: string;
  expected: boolean;
}> = [
  { name: "complete + seeding → surfaces", progress: 1, status: "seeding", expected: true },
  { name: "complete + uploading → surfaces", progress: 1, status: "uploading", expected: true },
  { name: "half-downloaded → excluded", progress: 0.5, status: "downloading", expected: false },
  { name: "16% (streaming pieces) → excluded", progress: 0.16, status: "downloading", expected: false },
  { name: "99% but not done → excluded", progress: 0.99, status: "downloading", expected: false },
  { name: "0% → excluded", progress: 0, status: "metaDL", expected: false },
  { name: "complete but removed → excluded", progress: 1, status: "removed", expected: false },
  { name: "complete but errored → excluded", progress: 1, status: "error", expected: false },
];

for (const tc of SURFACE_CASES) {
  check(tc.name, () => {
    assert.equal(
      readyToPlayTorrentCanSurface({ progress: tc.progress, status: tc.status }),
      tc.expected,
    );
  });
}

// ---------------------------------------------------------------------------
// mediaGroupOf — open vocabulary → movie | series | unknown
// ---------------------------------------------------------------------------

console.log("\n--- media group classification ---");

const GROUP_CASES: Array<{ mt: string | null | undefined; group: string }> = [
  { mt: "movie", group: "movie" },
  { mt: "film", group: "movie" },
  { mt: "Movie", group: "movie" },
  { mt: "tv", group: "series" },
  { mt: "anime", group: "series" },
  { mt: "series", group: "series" },
  { mt: "show", group: "series" },
  { mt: null, group: "unknown" },
  { mt: undefined, group: "unknown" },
  { mt: "", group: "unknown" },
  { mt: "software", group: "unknown" },
];

for (const tc of GROUP_CASES) {
  check(`mediaGroupOf(${tc.mt}) === ${tc.group}`, () => {
    assert.equal(mediaGroupOf(tc.mt), tc.group);
  });
}

// ---------------------------------------------------------------------------
// splitRailByMediaType — separate movies from series, degrade gracefully
// ---------------------------------------------------------------------------

console.log("\n--- movie / series split ---");

check("mixed movies + series splits into two rails, each homogeneous", () => {
  const r = rail("recently-added", "Recently Added", [
    item({ title: "Dune Part Two", mediaType: "movie" }),
    item({ title: "The Bear", mediaType: "tv" }),
    item({ title: "Oppenheimer", mediaType: "movie" }),
    item({ title: "Severance", mediaType: "anime" }),
  ]);
  const out = splitRailByMediaType(r);
  assert.equal(out.length, 2, "expected two rails");
  const movies = out.find((x) => x.id === "recently-added-movies")!;
  const series = out.find((x) => x.id === "recently-added-series")!;
  assert.ok(movies && series, "both split rails present");
  assert.ok(movies.items.every((i) => mediaGroupOf(i.mediaType) === "movie"));
  assert.ok(series.items.every((i) => mediaGroupOf(i.mediaType) === "series"));
  assert.equal(movies.items.length, 2);
  assert.equal(series.items.length, 2);
});

check("all-movies rail is not split or renamed (graceful)", () => {
  const r = rail("ready-to-play", "Ready to Play", [
    item({ title: "Dune", mediaType: "movie" }),
    item({ title: "Tenet", mediaType: "film" }),
  ]);
  const out = splitRailByMediaType(r);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Ready to Play");
});

check("all-null mediaType rail stays a single rail (unknown not forced)", () => {
  const r = rail("recently-added", "Recently Added", [
    item({ title: "Mystery A", mediaType: null }),
    item({ title: "Mystery B", mediaType: null }),
  ]);
  const out = splitRailByMediaType(r);
  assert.equal(out.length, 1);
  assert.equal(out[0].items.length, 2);
});

check("mix with unknowns: movies, series, and a plain rail for the rest", () => {
  const r = rail("recently-added", "Recently Added", [
    item({ title: "Dune", mediaType: "movie" }),
    item({ title: "The Bear", mediaType: "tv" }),
    item({ title: "Some Toolkit", mediaType: "software" }),
  ]);
  const out = splitRailByMediaType(r);
  assert.equal(out.length, 3);
  const plain = out.find((x) => x.id === "recently-added")!;
  assert.equal(plain.items.length, 1);
  assert.equal(plain.items[0].title, "Some Toolkit");
});

// ---------------------------------------------------------------------------
// dedupeAcrossRails — one work, one rail, in priority order
// ---------------------------------------------------------------------------

console.log("\n--- cross-rail dedupe ---");

const ORDER = ["continue-watching", "ready-to-play", "recently-added"];

check("a title in all three rails survives only in the highest-priority one", () => {
  const rails: Rail[] = [
    rail("continue-watching", "Continue Watching", [item({ title: "The Bear" })]),
    rail("ready-to-play", "Ready to Play", [item({ title: "The Bear" })]),
    rail("recently-added", "Recently Added", [item({ title: "The Bear" })]),
  ];
  const out = dedupeAcrossRails(rails, ORDER);
  assert.equal(out.find((r) => r.id === "continue-watching")!.items.length, 1);
  assert.equal(out.find((r) => r.id === "ready-to-play")!.items.length, 0);
  assert.equal(out.find((r) => r.id === "recently-added")!.items.length, 0);
});

check("release-name spellings of one work collapse to one card", () => {
  const rails: Rail[] = [
    rail("ready-to-play", "Ready to Play", [
      item({ title: "Rick and Morty" }),
    ]),
    rail("recently-added", "Recently Added", [
      // Same work, a jumbled release-ish title — must still dedupe by identity.
      item({ title: "Rick.and.Morty" }),
    ]),
  ];
  const out = dedupeAcrossRails(rails, ORDER);
  assert.equal(out.find((r) => r.id === "ready-to-play")!.items.length, 1);
  assert.equal(out.find((r) => r.id === "recently-added")!.items.length, 0);
});

check("distinct works are all kept (no over-collapse)", () => {
  const rails: Rail[] = [
    rail("ready-to-play", "Ready to Play", [
      item({ title: "Dune", mediaType: "movie" }),
    ]),
    rail("recently-added", "Recently Added", [
      item({ title: "Dune Part Two", mediaType: "movie" }),
      item({ title: "Oppenheimer", mediaType: "movie" }),
    ]),
  ];
  const out = dedupeAcrossRails(rails, ORDER);
  assert.equal(out.find((r) => r.id === "ready-to-play")!.items.length, 1);
  assert.equal(out.find((r) => r.id === "recently-added")!.items.length, 2);
});

check("original rail order is preserved and out-of-scope rails pass through", () => {
  const rails: Rail[] = [
    rail("continue-watching", "Continue Watching", [item({ title: "The Bear" })]),
    rail("my-library", "My Library", [item({ title: "The Bear" })]),
    rail("recently-added", "Recently Added", [item({ title: "The Bear" })]),
  ];
  const out = dedupeAcrossRails(rails, ORDER);
  assert.deepEqual(out.map((r) => r.id), ["continue-watching", "my-library", "recently-added"]);
  // my-library is not in the dedupe scope, so it keeps its copy.
  assert.equal(out.find((r) => r.id === "my-library")!.items.length, 1);
  assert.equal(out.find((r) => r.id === "recently-added")!.items.length, 0);
});

check("within one rail duplicates also collapse", () => {
  const rails: Rail[] = [
    rail("recently-added", "Recently Added", [
      item({ title: "The Bear", id: "a" }),
      item({ title: "The Bear", id: "b" }),
    ]),
  ];
  const out = dedupeAcrossRails(rails, ORDER);
  assert.equal(out[0].items.length, 1);
});

// railItemWorkKey stability
check("railItemWorkKey is stable across release spellings of one work", () => {
  assert.equal(
    railItemWorkKey({ title: "Rick and Morty" }),
    railItemWorkKey({ title: "Rick.and.Morty" }),
  );
  assert.notEqual(
    railItemWorkKey({ title: "Dune" }),
    railItemWorkKey({ title: "Dune Part Two" }),
  );
});

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log(
  `\n${failures === 0 ? "rails-organization: all tests passed ✓" : `rails-organization: ${failures} FAILED`}`,
);
if (failures > 0) process.exit(1);
