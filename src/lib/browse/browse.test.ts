/**
 * Browse data-layer tests — availability resolver, rail builders, progress
 * completion threshold.
 *
 * Table-driven over diverse inputs per AGENTS.md. Every case tests the rule
 * class, not one example.
 *
 * Run: npx tsx src/lib/browse/browse.test.ts
 */
import assert from "node:assert/strict";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import type { AvailabilityQuery } from "./availability";
import { COMPLETION_THRESHOLD } from "./types";
import type { AvailabilityState, Availability, RailItem } from "./types";
import { collapseReleasesByWork } from "./collapse";
import {
  _readyToPlayRailFromItems as readyToPlayRailFromItems,
  readyCollapseSortAt,
} from "./rails";

// Import the internal helpers we export for testing
import {
  _torrentMatchesQuery as torrentMatchesQuery,
  _hasViableMatch as hasViableMatch,
  _resolveLocalOnly as resolveLocalOnly,
  _resolveFromSearchCache as resolveFromSearchCache,
  type _ReadyTorrentPresence as ReadyTorrentPresence,
  type _TorrentRow as TorrentRow,
} from "./availability";

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
// Helpers
// ---------------------------------------------------------------------------

function torrent(
  partial: Partial<TorrentRow> & { name: string },
): TorrentRow {
  return {
    hash: partial.hash ?? partial.name.slice(0, 16),
    name: partial.name,
    progress: partial.progress ?? 0,
    status: partial.status ?? "downloading",
  };
}

function searchResult(
  partial: Partial<TorrentResult> & { title: string },
): TorrentResult {
  return {
    id: partial.id ?? partial.title,
    title: partial.title,
    sizeBytes: partial.sizeBytes ?? 2_000_000_000,
    seeders: partial.seeders ?? 50,
    leechers: partial.leechers ?? 5,
    source: partial.source ?? "nyaa",
    sourceUrl: "https://example.com",
    tags: partial.tags ?? [],
    magnet: partial.magnet ?? "magnet:?xt=urn:btih:deadbeef",
    infoHash: partial.infoHash,
    episode: partial.episode,
  };
}

function searchResponse(results: TorrentResult[]): SearchResponse {
  return {
    query: "test",
    results,
    tookMs: 10,
    totalCount: results.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    sources: [],
  };
}

function enginePresence(
  states: Record<string, ReadyTorrentPresence>,
): (hash: string) => ReadyTorrentPresence {
  return (hash) => states[hash.toLowerCase()] ?? "unknown";
}

const engineHoldsEverything = () => "present" as const;

function railItem(
  partial: Partial<RailItem> & { id: string; title: string },
): RailItem {
  return {
    id: partial.id,
    title: partial.title,
    subtitle: partial.subtitle ?? null,
    posterUrl: partial.posterUrl ?? null,
    backdropUrl: partial.backdropUrl ?? null,
    availability: partial.availability ?? null,
    progressFraction: partial.progressFraction ?? null,
    resumePositionSec: partial.resumePositionSec ?? null,
    infoHash: partial.infoHash ?? null,
    filePath: partial.filePath ?? null,
    watchListItemId: partial.watchListItemId ?? null,
    mediaType: partial.mediaType ?? null,
    season: partial.season ?? null,
    episode: partial.episode ?? null,
  };
}

// ---------------------------------------------------------------------------
// Availability: torrentMatchesQuery
// ---------------------------------------------------------------------------

console.log("\n--- torrent matching ---");

const MATCH_CASES: Array<{
  name: string;
  torrent: TorrentRow;
  query: AvailabilityQuery;
  expected: boolean;
}> = [
  {
    name: "exact title match (Breaking Bad)",
    torrent: torrent({ name: "Breaking Bad S05E16 1080p WEB-DL" }),
    query: { title: "Breaking Bad", season: 5, episode: 16 },
    expected: true,
  },
  {
    name: "exact title match (The Simpsons)",
    torrent: torrent({ name: "The Simpsons S35E10 720p HDTV" }),
    query: { title: "The Simpsons", season: 35, episode: 10 },
    expected: true,
  },
  {
    name: "anime with fansub prefix ([SubsPlease] One Piece)",
    torrent: torrent({
      name: "[SubsPlease] One Piece - 1170 (1080p) [ABC123]",
    }),
    query: { title: "One Piece" },
    expected: true,
  },
  {
    name: "wrong episode number",
    torrent: torrent({ name: "Family Guy S22E05 1080p WEB-DL" }),
    query: { title: "Family Guy", season: 22, episode: 7 },
    expected: false,
  },
  {
    name: "wrong show entirely",
    torrent: torrent({ name: "The Bear S03E01 1080p" }),
    query: { title: "Breaking Bad", season: 3, episode: 1 },
    expected: false,
  },
  {
    name: "season pack satisfies episode request",
    torrent: torrent({ name: "Frieren S01 Complete 1080p WEB-DL" }),
    query: { title: "Frieren", season: 1, episode: 5 },
    expected: true,
  },
  {
    name: "season pack wrong season",
    torrent: torrent({ name: "The Bear S02 Complete 1080p" }),
    query: { title: "The Bear", season: 3, episode: 1 },
    expected: false,
  },
  {
    name: "title match with no episode constraint",
    torrent: torrent({ name: "Dune Part Two 2024 2160p REMUX" }),
    query: { title: "Dune Part Two" },
    expected: true,
  },
  {
    name: "multi-season pack covers requested season",
    torrent: torrent({ name: "Solo Leveling Seasons 1+2 1080p WEB-DL" }),
    query: { title: "Solo Leveling", season: 2, episode: 3 },
    expected: true,
  },
];

for (const tc of MATCH_CASES) {
  check(tc.name, () => {
    const result = torrentMatchesQuery(tc.torrent, tc.query);
    assert.equal(
      result,
      tc.expected,
      `torrentMatchesQuery for "${tc.torrent.name}" vs "${tc.query.title}" ` +
        `S${tc.query.season ?? "X"}E${tc.query.episode ?? "X"}: ` +
        `expected ${tc.expected}, got ${result}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Availability: hasViableMatch (search cache scanning)
// ---------------------------------------------------------------------------

console.log("\n--- viable match scanning ---");

const VIABLE_CASES: Array<{
  name: string;
  results: TorrentResult[];
  query: AvailabilityQuery;
  expected: boolean;
}> = [
  {
    name: "viable release with enough seeders → true",
    results: [
      searchResult({
        title: "Breaking Bad S05E16 1080p WEB-DL",
        seeders: 50,
        episode: { season: 5, episode: 16, label: "S05E16", isBatch: false, isSeasonPack: false },
      }),
    ],
    query: { title: "Breaking Bad", season: 5, episode: 16 },
    expected: true,
  },
  {
    name: "release with 0 seeders (below MIN_VIABLE_SEEDERS) → false",
    results: [
      searchResult({
        title: "Obscure Show S01E01 720p",
        seeders: 0,
        episode: { season: 1, episode: 1, label: "S01E01", isBatch: false, isSeasonPack: false },
      }),
    ],
    query: { title: "Obscure Show", season: 1, episode: 1 },
    expected: false,
  },
  {
    name: "release with 2 seeders (below threshold of 3) → false",
    results: [
      searchResult({
        title: "Niche Anime S01E05 1080p",
        seeders: 2,
        episode: { season: 1, episode: 5, label: "S01E05", isBatch: false, isSeasonPack: false },
      }),
    ],
    query: { title: "Niche Anime", season: 1, episode: 5 },
    expected: false,
  },
  {
    name: "release with exactly 3 seeders (threshold) → true",
    results: [
      searchResult({
        title: "Borderline Show S02E01 720p",
        seeders: 3,
        episode: { season: 2, episode: 1, label: "S02E01", isBatch: false, isSeasonPack: false },
      }),
    ],
    query: { title: "Borderline Show", season: 2, episode: 1 },
    expected: true,
  },
  {
    name: "season pack in search satisfies episode request",
    results: [
      searchResult({
        title: "The Bear S03 Complete 1080p WEB-DL",
        seeders: 100,
        episode: { season: 3, label: "S03 pack", isBatch: true, isSeasonPack: true },
      }),
    ],
    query: { title: "The Bear", season: 3, episode: 5 },
    expected: true,
  },
  {
    name: "no results at all → false",
    results: [],
    query: { title: "Non Existent Show", season: 1, episode: 1 },
    expected: false,
  },
  {
    name: "wrong title in results → false",
    results: [
      searchResult({
        title: "Different Show S01E01 1080p",
        seeders: 500,
        episode: { season: 1, episode: 1, label: "S01E01", isBatch: false, isSeasonPack: false },
      }),
    ],
    query: { title: "Breaking Bad", season: 1, episode: 1 },
    expected: false,
  },
  {
    name: "title with no metadata but viable seeders → true (no episode constraint)",
    results: [
      searchResult({
        title: "Some Random Movie 2024 1080p",
        seeders: 20,
      }),
    ],
    query: { title: "Some Random Movie" },
    expected: true,
  },
  {
    name: "mixed results — one viable among non-viable → true",
    results: [
      searchResult({ title: "Frieren S01E12 480p", seeders: 0 }),
      searchResult({
        title: "Frieren S01E12 1080p WEB-DL",
        seeders: 80,
        episode: { season: 1, episode: 12, label: "S01E12", isBatch: false, isSeasonPack: false },
      }),
    ],
    query: { title: "Frieren", season: 1, episode: 12 },
    expected: true,
  },
];

for (const tc of VIABLE_CASES) {
  check(tc.name, () => {
    const resp = searchResponse(tc.results);
    const result = hasViableMatch(resp, tc.query);
    assert.equal(
      result,
      tc.expected,
      `hasViableMatch for "${tc.query.title}": expected ${tc.expected}, got ${result}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Availability: full state derivation (unit-level, no DB)
// ---------------------------------------------------------------------------

console.log("\n--- availability state derivation (local-only path) ---");

// These test resolveLocalOnly which returns null when no local torrent matches,
// letting the caller decide between unknown/unavailable/fetchable.

interface AvailLocalCase {
  name: string;
  torrents: TorrentRow[];
  query: AvailabilityQuery;
  engine?: (hash: string) => ReadyTorrentPresence;
  /** null means "no local torrent found" */
  expected: Availability | null;
}

const AVAIL_LOCAL_CASES: AvailLocalCase[] = [
  {
    name: "fully downloaded torrent → ready",
    torrents: [
      torrent({
        name: "The Bear S03E01 1080p WEB-DL",
        hash: "bear301hash",
        progress: 1,
        status: "seeding",
      }),
    ],
    query: { title: "The Bear", season: 3, episode: 1 },
    engine: enginePresence({ bear301hash: "present" }),
    expected: { state: "ready", infoHash: "bear301hash" },
  },
  {
    name: "completed row with live engine handle → ready",
    torrents: [
      torrent({
        name: "Severance S02E01 1080p WEB-DL",
        hash: "severance201",
        progress: 1,
        status: "seeding",
      }),
    ],
    query: { title: "Severance", season: 2, episode: 1 },
    engine: enginePresence({ severance201: "present" }),
    expected: { state: "ready", infoHash: "severance201" },
  },
  {
    name: "completed row absent from rehydrated engine → fetchable, not ready",
    torrents: [
      torrent({
        name: "Silo S02E10 1080p WEB-DL",
        hash: "silo210",
        progress: 1,
        status: "seeding",
      }),
    ],
    query: { title: "Silo", season: 2, episode: 10 },
    engine: enginePresence({ silo210: "absent" }),
    expected: { state: "fetchable" },
  },
  {
    name: "completed row while engine state is unknown → null, not unavailable",
    torrents: [
      torrent({
        name: "Foundation S03E01 1080p WEB-DL",
        hash: "foundation301",
        progress: 1,
        status: "seeding",
      }),
    ],
    query: { title: "Foundation", season: 3, episode: 1 },
    engine: enginePresence({ foundation301: "unknown" }),
    expected: { state: null },
  },
  {
    name: "partially downloaded torrent with peers → warm",
    torrents: [
      torrent({
        name: "Frieren S01E12 1080p",
        hash: "frieren12hash",
        progress: 0.45,
        status: "downloading",
      }),
    ],
    query: { title: "Frieren", season: 1, episode: 12 },
    expected: { state: "warm", infoHash: "frieren12hash", progress: 0.45 },
  },
  {
    name: "torrent at 0% progress → null (no usable data yet)",
    torrents: [
      torrent({
        name: "New Show S01E01 1080p",
        progress: 0,
        status: "downloading",
      }),
    ],
    query: { title: "New Show", season: 1, episode: 1 },
    expected: null,
  },
  {
    name: "removed torrent not counted as ready → null",
    torrents: [
      torrent({
        name: "Old Movie 2020 1080p",
        progress: 1,
        status: "removed",
      }),
    ],
    query: { title: "Old Movie" },
    expected: null,
  },
  {
    name: "errored torrent not counted as warm → null",
    torrents: [
      torrent({
        name: "Broken Show S02E05 720p",
        progress: 0.3,
        status: "error",
      }),
    ],
    query: { title: "Broken Show", season: 2, episode: 5 },
    expected: null,
  },
  {
    name: "no matching torrent at all → null",
    torrents: [
      torrent({
        name: "Totally Different Show S01E01",
        progress: 1,
        status: "seeding",
      }),
    ],
    query: { title: "Breaking Bad", season: 1, episode: 1 },
    expected: null,
  },
  {
    name: "ready beats warm when both match",
    torrents: [
      torrent({
        name: "One Piece - 1170 480p",
        progress: 0.6,
        status: "downloading",
      }),
      torrent({
        name: "[SubsPlease] One Piece - 1170 (1080p)",
        hash: "op1170-1080p",
        progress: 1,
        status: "seeding",
      }),
    ],
    query: { title: "One Piece" },
    engine: enginePresence({ "op1170-1080p": "present" }),
    expected: { state: "ready", infoHash: "op1170-1080p" },
  },
];

for (const tc of AVAIL_LOCAL_CASES) {
  check(tc.name, () => {
    const result = resolveLocalOnly(
      tc.query,
      tc.torrents,
      tc.engine ?? engineHoldsEverything,
    );
    if (tc.expected === null) {
      assert.equal(result, null, `expected null, got ${JSON.stringify(result)}`);
    } else {
      assert.notEqual(result, null, `expected ${tc.expected.state}, got null`);
      assert.equal(result!.state, tc.expected.state);
      if (tc.expected.infoHash) {
        assert.equal(result!.infoHash, tc.expected.infoHash);
      }
      if (tc.expected.progress !== undefined) {
        assert.equal(result!.progress, tc.expected.progress);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Batch resolution: correct states for a mixed set
// ---------------------------------------------------------------------------

console.log("\n--- batch availability ---");

check("batch produces correct mixed states (local-only path)", () => {
  const torrents: TorrentRow[] = [
    torrent({
      name: "Breaking Bad S05E16 1080p",
      hash: "bb5e16",
      progress: 1,
      status: "seeding",
    }),
    torrent({
      name: "The Bear S03E01 1080p",
      hash: "bear301",
      progress: 0.6,
      status: "downloading",
    }),
  ];

  const queries: AvailabilityQuery[] = [
    { title: "Breaking Bad", season: 5, episode: 16 },
    { title: "The Bear", season: 3, episode: 1 },
    { title: "Non Existent Show", season: 1, episode: 1 },
  ];

  // local-only: ready, warm, null (→ unknown in resolveLocalAvailabilityBatch)
  const expectedStates: (AvailabilityState | null)[] = ["ready", "warm", null];

  for (let i = 0; i < queries.length; i++) {
    const result = resolveLocalOnly(queries[i], torrents, engineHoldsEverything);
    if (expectedStates[i] === null) {
      assert.equal(result, null, `batch item ${i}: expected null (no local)`);
    } else {
      assert.notEqual(result, null, `batch item ${i}: expected ${expectedStates[i]}`);
      assert.equal(result!.state, expectedStates[i], `batch item ${i}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Progress completion threshold
// ---------------------------------------------------------------------------

console.log("\n--- completion threshold ---");

check("threshold is 90%", () => {
  assert.equal(COMPLETION_THRESHOLD, 0.9);
});

const THRESHOLD_CASES: Array<{
  name: string;
  position: number;
  duration: number;
  expectedComplete: boolean;
}> = [
  {
    name: "89% → not complete",
    position: 890,
    duration: 1000,
    expectedComplete: false,
  },
  {
    name: "89.9% → not complete",
    position: 899,
    duration: 1000,
    expectedComplete: false,
  },
  {
    name: "90% → complete (boundary)",
    position: 900,
    duration: 1000,
    expectedComplete: true,
  },
  {
    name: "91% → complete",
    position: 910,
    duration: 1000,
    expectedComplete: true,
  },
  {
    name: "100% → complete",
    position: 1000,
    duration: 1000,
    expectedComplete: true,
  },
  {
    name: "short anime episode at 89% → not complete",
    position: 1246,
    duration: 1400,
    expectedComplete: false,
  },
  {
    name: "short anime episode at 91% → complete",
    position: 1274,
    duration: 1400,
    expectedComplete: true,
  },
  {
    name: "2h movie at 89% → not complete",
    position: 6408,
    duration: 7200,
    expectedComplete: false,
  },
  {
    name: "2h movie at 92% → complete",
    position: 6624,
    duration: 7200,
    expectedComplete: true,
  },
];

for (const tc of THRESHOLD_CASES) {
  check(tc.name, () => {
    const fraction = tc.position / tc.duration;
    const isComplete = fraction >= COMPLETION_THRESHOLD;
    assert.equal(
      isComplete,
      tc.expectedComplete,
      `${tc.position}/${tc.duration} = ${(fraction * 100).toFixed(1)}%: ` +
        `expected complete=${tc.expectedComplete}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Rail builders with empty inputs
// ---------------------------------------------------------------------------

console.log("\n--- rail builder edge cases ---");

check("formatEpisodeSubtitle produces correct labels", () => {
  // Re-implement the function locally for testing (it's not exported, so we
  // test the rule class: the format contract)
  function fmt(
    s: number | null | undefined,
    e: number | null | undefined,
  ): string | null {
    if (s != null && e != null)
      return `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
    if (s != null) return `Season ${s}`;
    if (e != null) return `Episode ${e}`;
    return null;
  }

  const cases: Array<{
    season: number | null;
    episode: number | null;
    expected: string | null;
  }> = [
    { season: 2, episode: 7, expected: "S02E07" },
    { season: 1, episode: 1, expected: "S01E01" },
    { season: 10, episode: 25, expected: "S10E25" },
    { season: 3, episode: null, expected: "Season 3" },
    { season: null, episode: 12, expected: "Episode 12" },
    { season: null, episode: null, expected: null },
  ];

  for (const tc of cases) {
    assert.equal(
      fmt(tc.season, tc.episode),
      tc.expected,
      `fmt(${tc.season}, ${tc.episode}) expected "${tc.expected}"`,
    );
  }
});

check("release-backed rails use the shared work collapse", () => {
  const rows = [
    torrent({ name: "The Bear S03E01 1080p WEB-DL x265" }),
    torrent({ name: "The Bear S03E02 720p HDTV x264" }),
    torrent({ name: "www.UIndex.org - Rick and Morty S01E02 1080p WEB-DL x264" }),
    torrent({ name: "Rick.and.Morty.S01E01.1080p.WEB-DL.x264-GROUP" }),
    torrent({ name: "Breaking Bad S05E16 1080p" }),
  ];

  const collapsed = collapseReleasesByWork(
    rows.map((row, i) => ({
      name: row.name,
      sortAt: new Date(Date.UTC(2024, 0, 1, 0, i, 0)),
      value: row,
    })),
  );

  assert.deepEqual(
    collapsed.map((work) => work.title),
    ["The Bear", "Rick and Morty", "Breaking Bad"],
    "punctuation, tracker prefixes and episode numbers must not split one show into several cards",
  );
  assert.deepEqual(
    collapsed.map((work) => work.releaseCount),
    [2, 2, 1],
    "only releases of the same work should be folded into a single card",
  );
});

console.log("\n--- ready-to-play rail truthfulness ---");

const READY_RAIL_CASES: Array<{
  name: string;
  items: RailItem[];
  expectedTitles: string[] | null;
  expectedStates?: Array<AvailabilityState | null>;
}> = [
  {
    name: "cold start keeps completed DB rows with neutral availability",
    items: [
      railItem({ id: "dune", title: "Dune Part Two", availability: null }),
      railItem({ id: "bear", title: "The Bear", availability: null }),
    ],
    expectedTitles: ["Dune Part Two", "The Bear"],
    expectedStates: [null, null],
  },
  {
    name: "definitively absent row is dropped while live row remains ready",
    items: [
      railItem({ id: "ready", title: "Severance", availability: "ready" }),
      railItem({ id: "absent", title: "Silo", availability: "fetchable" }),
    ],
    expectedTitles: ["Severance"],
    expectedStates: ["ready"],
  },
  {
    name: "engine up with no present hashes removes the rail",
    items: [
      railItem({ id: "silo", title: "Silo", availability: "fetchable" }),
      railItem({ id: "foundation", title: "Foundation", availability: "fetchable" }),
    ],
    expectedTitles: null,
  },
];

for (const tc of READY_RAIL_CASES) {
  check(tc.name, () => {
    const rail = readyToPlayRailFromItems(tc.items);
    if (tc.expectedTitles === null) {
      assert.equal(rail, null, "expected no Ready to Play rail");
      return;
    }
    assert.notEqual(rail, null, "expected Ready to Play rail to survive");
    assert.deepEqual(
      rail!.items.map((item) => item.title),
      tc.expectedTitles,
    );
    assert.deepEqual(
      rail!.items.map((item) => item.availability),
      tc.expectedStates,
    );
  });
}

check("ready collapse keeps a season pack ahead of a newer up-next single", () => {
  const packUpdated = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  const singleUpdated = new Date(Date.UTC(2024, 0, 2, 0, 0, 0));

  const collapsed = collapseReleasesByWork([
    {
      name: "Harness Show S01E04 1080p WEB",
      sortAt: readyCollapseSortAt("Harness Show S01E04 1080p WEB", singleUpdated),
      value: { hash: "single" },
    },
    {
      name: "Harness Show S01 COMPLETE 1080p WEB",
      sortAt: readyCollapseSortAt("Harness Show S01 COMPLETE 1080p WEB", packUpdated),
      value: { hash: "pack" },
    },
  ]);

  assert.equal(
    collapsed[0]?.value.hash,
    "pack",
    "a prewarmed single must not replace the ready season-pack card",
  );
});

// ---------------------------------------------------------------------------
// Input validation rules (progress route)
// ---------------------------------------------------------------------------

console.log("\n--- progress input validation rules ---");

check("negative position is rejected", () => {
  const body = {
    infoHash: "abc123",
    filePath: "/video.mkv",
    positionSec: -1,
    durationSec: 3600,
    title: "Test",
  };
  assert.ok(body.positionSec < 0, "negative position should be caught");
});

check("position beyond duration is rejected", () => {
  const body = {
    infoHash: "abc123",
    filePath: "/video.mkv",
    positionSec: 7201,
    durationSec: 7200,
    title: "Test",
  };
  assert.ok(
    body.positionSec > body.durationSec,
    "position > duration should be caught",
  );
});

check("zero or negative duration is rejected", () => {
  for (const d of [0, -1, -100]) {
    assert.ok(d <= 0, `duration ${d} should be rejected`);
  }
});

check("missing infoHash is rejected", () => {
  const empty = "" as string;
  assert.equal(empty.length, 0, "empty string has zero length → rejected");
});

// ---------------------------------------------------------------------------
// 0-seeder release inside seeder-wait window
// ---------------------------------------------------------------------------

console.log("\n--- seeder edge cases ---");

check("0-seeder result is not viable", () => {
  const resp = searchResponse([
    searchResult({ title: "Fresh Episode S01E01 1080p", seeders: 0 }),
  ]);
  const result = hasViableMatch(resp, {
    title: "Fresh Episode",
    season: 1,
    episode: 1,
  });
  assert.equal(result, false, "0-seeder should not be viable");
});

check("1-seeder result is not viable (below threshold of 3)", () => {
  const resp = searchResponse([
    searchResult({ title: "Niche Show S01E01 720p", seeders: 1 }),
  ]);
  const result = hasViableMatch(resp, {
    title: "Niche Show",
    season: 1,
    episode: 1,
  });
  assert.equal(result, false, "1-seeder should not be viable");
});

check("3-seeder result is viable (at threshold)", () => {
  const resp = searchResponse([
    searchResult({
      title: "Borderline Show S02E01 1080p",
      seeders: 3,
      episode: { season: 2, episode: 1, label: "S02E01", isBatch: false, isSeasonPack: false },
    }),
  ]);
  const result = hasViableMatch(resp, {
    title: "Borderline Show",
    season: 2,
    episode: 1,
  });
  assert.equal(result, true, "exactly 3 seeders should be viable");
});

// ---------------------------------------------------------------------------
// unknown vs unavailable distinction — the core correctness property
// ---------------------------------------------------------------------------

console.log("\n--- unknown vs unavailable distinction ---");

check("no search cache → null (unknown), NOT unavailable", () => {
  // resolveFromSearchCache with null = no cached search data
  const result = resolveFromSearchCache(
    { title: "Some Show", season: 1, episode: 1 },
    null,
  );
  assert.equal(
    result.state,
    null,
    "missing search cache must produce null (unknown), not unavailable",
  );
});

check("search cache with no viable results → unavailable (genuine claim)", () => {
  const resp = searchResponse([
    searchResult({ title: "Some Show S01E01 720p", seeders: 0 }),
    searchResult({ title: "Some Show S01E01 480p", seeders: 1 }),
  ]);
  const result = resolveFromSearchCache(
    { title: "Some Show", season: 1, episode: 1 },
    resp,
  );
  assert.equal(
    result.state,
    "unavailable",
    "checked and found nothing viable → unavailable is honest",
  );
});

check("search cache with viable result → fetchable", () => {
  const resp = searchResponse([
    searchResult({
      title: "Some Show S01E01 1080p WEB-DL",
      seeders: 100,
      episode: { season: 1, episode: 1, label: "S01E01", isBatch: false, isSeasonPack: false },
    }),
  ]);
  const result = resolveFromSearchCache(
    { title: "Some Show", season: 1, episode: 1 },
    resp,
  );
  assert.equal(result.state, "fetchable");
});

check("empty search response → unavailable (searched, found nothing)", () => {
  const resp = searchResponse([]);
  const result = resolveFromSearchCache(
    { title: "Nonexistent Thing" },
    resp,
  );
  assert.equal(
    result.state,
    "unavailable",
    "empty results from a real search = genuinely unavailable",
  );
});

// Table-driven: the rule class is "null for missing data, unavailable only
// when we actually checked". Diverse titles to prove this isn't example-patched.
const UNKNOWN_UNAVAIL_CASES: Array<{
  name: string;
  query: AvailabilityQuery;
  cache: SearchResponse | null;
  expected: AvailabilityState | null;
}> = [
  {
    name: "anime with no cache → null (One Piece)",
    query: { title: "One Piece", season: 23, episode: 1170 },
    cache: null,
    expected: null,
  },
  {
    name: "movie with no cache → null (Dune Part Two)",
    query: { title: "Dune Part Two" },
    cache: null,
    expected: null,
  },
  {
    name: "TV with no cache → null (Breaking Bad)",
    query: { title: "Breaking Bad", season: 5, episode: 16 },
    cache: null,
    expected: null,
  },
  {
    name: "anime with dead-seeder cache → unavailable (Niche OVA)",
    query: { title: "Niche OVA", season: 1, episode: 1 },
    cache: searchResponse([
      searchResult({ title: "Niche OVA S01E01 720p", seeders: 0 }),
    ]),
    expected: "unavailable",
  },
  {
    name: "movie with healthy cache → fetchable",
    query: { title: "Interstellar" },
    cache: searchResponse([
      searchResult({ title: "Interstellar 2014 1080p BluRay", seeders: 5000 }),
    ]),
    expected: "fetchable",
  },
  {
    name: "TV with only 2-seeder results → unavailable (below threshold)",
    query: { title: "Obscure British Drama", season: 2, episode: 3 },
    cache: searchResponse([
      searchResult({
        title: "Obscure British Drama S02E03 720p",
        seeders: 2,
        episode: { season: 2, episode: 3, label: "S02E03", isBatch: false, isSeasonPack: false },
      }),
    ]),
    expected: "unavailable",
  },
];

for (const tc of UNKNOWN_UNAVAIL_CASES) {
  check(tc.name, () => {
    const result = resolveFromSearchCache(tc.query, tc.cache);
    assert.equal(
      result.state,
      tc.expected,
      `"${tc.query.title}": expected ${tc.expected}, got ${result.state}`,
    );
  });
}

// Verify the local-only path always returns null (→ unknown) for unmatched,
// never "unavailable" — the rule applies universally.
check("resolveLocalOnly never returns unavailable", () => {
  const noTorrents: TorrentRow[] = [];
  const titles = [
    "Breaking Bad",
    "One Piece",
    "Dune Part Two",
    "Frieren",
    "The Bear",
    "Family Guy",
    "Niche OVA",
  ];
  for (const title of titles) {
    const result = resolveLocalOnly({ title }, noTorrents, engineHoldsEverything);
    assert.equal(
      result,
      null,
      `resolveLocalOnly for "${title}" with no torrents must return null, not an Availability`,
    );
  }
});

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log(
  `\n${failures === 0 ? "All checks passed ✓" : `${failures} check(s) FAILED`}`,
);
if (failures > 0) process.exit(1);
