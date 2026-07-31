/**
 * Theatrical-window gate — rule class tests.
 *
 * A film is only offerable when it has had a home release (Digital/Physical/TV).
 * A film that is theatrically showing but has no past home release is gated.
 *
 * Test contract (per AGENTS.md "encode the rule class, not the example"):
 *  - theatrical-only in the past       → gated
 *  - digital in the past               → NOT gated
 *  - physical in the past              → NOT gated
 *  - TV release in the past            → NOT gated
 *  - premiere-only in the past         → gated (premiere ≠ home release)
 *  - digital in the future             → gated (not yet home-released)
 *  - theatrical + future digital       → gated, but nextHomeReleaseAt is set
 *  - no release_dates data / unknown   → NOT gated (absence of evidence)
 *  - endpoint failed (checked = false) → NOT gated
 *  - series                            → NEVER gated by this rule
 *
 * Run: npx tsx src/lib/browse/theatrical-window.test.ts
 *   or: node scripts/run-unit-tests.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyHomeReleaseDates } from "@/app/api/title/tmdb-extras";
import type { CatalogRow } from "@/lib/catalog/store";
import { toRailItem } from "@/lib/browse/discovery";
import {
  classifyHomeReleaseEvidence,
  type TmdbCountryRelease,
} from "@/lib/browse/home-release";
import {
  browseReleaseGate,
  theatricalWindowStatus,
} from "@/lib/browse/release-status";

// ---------------------------------------------------------------------------
// Helpers — build raw TMDB release_dates entries
// ---------------------------------------------------------------------------

type Entry = { release_date?: string | null; type?: number | null };

function country(entries: Entry[]) {
  return { iso_3166_1: "US", release_dates: entries };
}

// TMDB release types:
// 1 = Premiere, 2 = Theatrical (limited), 3 = Theatrical
// 4 = Digital, 5 = Physical, 6 = TV

const TODAY = "2026-07-30";
const PAST = "2026-07-15"; // 15 days ago
const FUTURE = "2026-09-01"; // 2 months ahead

// ---------------------------------------------------------------------------
// classifyHomeReleaseDates — classification rule class
// ---------------------------------------------------------------------------

test("theatrical-only in the past → releasedAt null (no home release)", () => {
  const results = [
    country([
      { release_date: "2026-07-15T00:00:00.000Z", type: 1 }, // Premiere
      { release_date: "2026-07-15T00:00:00.000Z", type: 2 }, // Limited theatrical
      { release_date: "2026-07-15T00:00:00.000Z", type: 3 }, // Theatrical
    ]),
  ];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.equal(c.releasedAt, null, "theatrical dates must not count as home release");
  assert.equal(c.nextHomeReleaseAt, null);
});

test("premiere-only in the past → releasedAt null", () => {
  const results = [country([{ release_date: PAST, type: 1 }])];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.equal(c.releasedAt, null, "premiere (type 1) is not a home release");
});

test("digital in the past → releasedAt set (NOT gated)", () => {
  const results = [
    country([
      { release_date: PAST, type: 3 }, // Theatrical (past)
      { release_date: PAST, type: 4 }, // Digital (past) — home release
    ]),
  ];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.ok(c.releasedAt !== null, "digital release in the past must be captured");
  assert.equal(c.releasedAt, PAST);
});

test("physical-only in the past → releasedAt set (NOT gated)", () => {
  const results = [country([{ release_date: PAST, type: 5 }])];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.equal(c.releasedAt, PAST, "physical release (type 5) counts as home release");
});

test("TV-only in the past → releasedAt set (NOT gated)", () => {
  const results = [country([{ release_date: PAST, type: 6 }])];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.equal(c.releasedAt, PAST, "TV release (type 6) counts as home release");
});

test("digital in the future → releasedAt null, nextHomeReleaseAt set (gated)", () => {
  const results = [
    country([
      { release_date: PAST, type: 3 },    // Theatrical (past)
      { release_date: FUTURE, type: 4 },  // Digital (future)
    ]),
  ];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.equal(c.releasedAt, null, "future digital must not count as released");
  assert.equal(c.nextHomeReleaseAt, FUTURE);
});

test("empty results → all null (unknown, NOT gated)", () => {
  const c = classifyHomeReleaseDates([], TODAY);
  assert.equal(c.releasedAt, null);
  assert.equal(c.nextHomeReleaseAt, null);
});

test("entries with null/missing dates are skipped gracefully", () => {
  const results = [
    country([
      { release_date: null, type: 4 },
      { release_date: "", type: 4 },
      { release_date: undefined, type: 5 },
    ]),
  ];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.equal(c.releasedAt, null, "null/empty dates must not produce a false gate");
});

test("multiple countries — earliest past home release wins", () => {
  const OLDER = "2026-06-01";
  const results = [
    country([{ release_date: PAST, type: 4 }]),      // US digital
    country([{ release_date: OLDER, type: 5 }]),     // DE physical (earlier)
  ];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.equal(c.releasedAt, OLDER, "earliest past date should win across countries");
});

test("mixed past and future home releases — past wins (NOT gated)", () => {
  const results = [
    country([
      { release_date: PAST, type: 4 },   // Digital (past)
      { release_date: FUTURE, type: 5 }, // Physical (future)
    ]),
  ];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.ok(c.releasedAt !== null, "past home release must clear the gate");
  assert.equal(c.nextHomeReleaseAt, FUTURE);
});

test("today-dated entry is counted as past (inclusive boundary)", () => {
  const results = [country([{ release_date: TODAY, type: 4 }])];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.equal(c.releasedAt, TODAY, "a release on today's date is considered released");
});

test("TMDB ISO-8601 timestamp format is parsed correctly", () => {
  const ts = `${PAST}T00:00:00.000Z`;
  const results = [country([{ release_date: ts, type: 4 }])];
  const c = classifyHomeReleaseDates(results, TODAY);
  assert.equal(c.releasedAt, PAST, "timestamp format must extract the date correctly");
});

// ---------------------------------------------------------------------------
// theatricalWindowStatus — label and gate logic
// ---------------------------------------------------------------------------

test("not in theatrical window → no gate, no label", () => {
  const s = theatricalWindowStatus(false, null);
  assert.equal(s.inTheatricalWindow, false);
  assert.equal(s.theatricalLabel, null);
});

test("in theatrical window, no future date → 'In cinemas'", () => {
  const s = theatricalWindowStatus(true, null);
  assert.equal(s.inTheatricalWindow, true);
  assert.equal(s.theatricalLabel, "In cinemas");
});

test("in theatrical window, future date known → 'Digital {Month} {Year}'", () => {
  const cases: Array<[string, string]> = [
    ["2026-08-01", "Digital Aug 2026"],
    ["2026-12-25", "Digital Dec 2026"],
    ["2027-01-10", "Digital Jan 2027"],
    ["2026-09-15", "Digital Sep 2026"],
  ];
  for (const [date, expected] of cases) {
    const s = theatricalWindowStatus(true, date);
    assert.equal(s.theatricalLabel, expected, `date ${date} → ${expected}`);
  }
});

test("series — inTheatricalWindow always false (rule never applies to series)", () => {
  // The route never sets inTheatricalWindow for a series. Simulate that
  // by testing that false input always produces a not-gated status.
  const s = theatricalWindowStatus(false, null);
  assert.equal(s.inTheatricalWindow, false, "series must never be gated by theatrical window");
  assert.equal(s.theatricalLabel, null);
});

// ---------------------------------------------------------------------------
// Combined gate: the rule class over diverse film scenarios
// ---------------------------------------------------------------------------

test("rule class: diverse film scenarios table", () => {
  // Each scenario: [description, inTheatricalWindow, nextHomeReleaseAt, expectedGated, expectedLabel]
  const cases: Array<[string, boolean, string | null, boolean, string | null]> = [
    ["theatrical-only (past premiere, no home release)", true, null, true, "In cinemas"],
    ["home-released (digital in the past)", false, null, false, null],
    ["theatrical + future digital", true, "2026-09-01", true, "Digital Sep 2026"],
    ["unknown (endpoint failed, checked=false)", false, null, false, null],
    ["future digital-only", true, "2026-08-15", true, "Digital Aug 2026"],
    ["series (never gated)", false, null, false, null],
    ["premiere-only", true, null, true, "In cinemas"],
    ["physical in past", false, null, false, null],
  ];

  for (const [desc, inTheatricalWindow, nextHomeReleaseAt, expectedGated, expectedLabel] of cases) {
    const s = theatricalWindowStatus(inTheatricalWindow, nextHomeReleaseAt);
    assert.equal(
      s.inTheatricalWindow,
      expectedGated,
      `"${desc}": inTheatricalWindow should be ${expectedGated}`,
    );
    assert.equal(
      s.theatricalLabel,
      expectedLabel,
      `"${desc}": theatricalLabel should be "${expectedLabel}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Discovery rail integration — persisted evidence to card gate
// ---------------------------------------------------------------------------

function catalogRow(
  mediaType: string,
  releaseDate: string | null,
): CatalogRow {
  return {
    id: `${mediaType}-${releaseDate ?? "unknown"}`,
    workKey: `${mediaType}:test`,
    title: "Test title",
    year: 2020,
    mediaType,
    releaseDate: releaseDate
      ? new Date(`${releaseDate}T00:00:00.000Z`)
      : null,
    posterUrl: null,
    backdropUrl: null,
    overview: null,
    rating: null,
    source: "trending",
    rank: 0,
    seedTitle: null,
    seeders: 0,
    bestRelease: null,
    refreshedAt: new Date("2026-07-30T00:00:00.000Z"),
  };
}

test("discovery rails gate only confirmed theatrical-only movies", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const cases: Array<{
    name: string;
    mediaType: string;
    primaryDate: string | null;
    results: TmdbCountryRelease[] | null;
    expectedGate: boolean;
    expectedLabel: string | null;
  }> = [
    {
      name: "theatrical-only film",
      mediaType: "movie",
      primaryDate: "2026-07-15",
      results: [country([{ release_date: PAST, type: 3 }])],
      expectedGate: true,
      expectedLabel: "In cinemas",
    },
    {
      name: "digitally released film",
      mediaType: "movie",
      primaryDate: "2026-07-15",
      results: [
        country([
          { release_date: PAST, type: 3 },
          { release_date: PAST, type: 4 },
        ]),
      ],
      expectedGate: false,
      expectedLabel: null,
    },
    {
      name: "unknown provider data",
      mediaType: "movie",
      primaryDate: "2026-07-15",
      results: null,
      expectedGate: false,
      expectedLabel: null,
    },
    {
      name: "empty provider response is still unknown",
      mediaType: "movie",
      primaryDate: "2026-07-15",
      results: [],
      expectedGate: false,
      expectedLabel: null,
    },
    {
      name: "future theatrical evidence does not prove a cinema premiere",
      mediaType: "movie",
      primaryDate: "2026-01-01",
      results: [country([{ release_date: FUTURE, type: 3 }])],
      expectedGate: false,
      expectedLabel: null,
    },
    {
      name: "unknown primary date",
      mediaType: "movie",
      primaryDate: null,
      results: [country([{ release_date: PAST, type: 3 }])],
      expectedGate: false,
      expectedLabel: null,
    },
    {
      name: "series with theatrical-shaped evidence",
      mediaType: "tv",
      primaryDate: "2026-07-15",
      results: [country([{ release_date: PAST, type: 3 }])],
      expectedGate: false,
      expectedLabel: null,
    },
    {
      name: "theatrical film with a future digital date",
      mediaType: "movie",
      primaryDate: "2026-07-15",
      results: [
        country([
          { release_date: PAST, type: 3 },
          { release_date: FUTURE, type: 4 },
        ]),
      ],
      expectedGate: true,
      expectedLabel: "Digital Sep 2026",
    },
  ];

  for (const tc of cases) {
    const signal = classifyHomeReleaseEvidence(tc.results, now);
    const item = toRailItem(
      catalogRow(tc.mediaType, tc.primaryDate),
      signal,
      now,
    );
    const gate = browseReleaseGate(item, now);
    assert.equal(
      item.inTheatricalWindow,
      tc.expectedGate,
      `${tc.name}: rail payload gate`,
    );
    assert.equal(gate.gated, tc.expectedGate, `${tc.name}: Browse UI gate`);
    assert.equal(gate.label, tc.expectedLabel, `${tc.name}: Browse label`);
    assert.equal(
      item.availability,
      null,
      `${tc.name}: theatrical evidence must not become torrent availability`,
    );
  }
});
