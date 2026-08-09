/**
 * `remembered-season.ts` — cookie parsing/bounds for durable manual season
 * memory. Table-driven per AGENTS.md.
 *
 * Run: npx tsx src/lib/title/remembered-season.test.ts
 */
import assert from "node:assert/strict";
import {
  MAX_COOKIE_VALUE_LENGTH,
  MAX_ENTRIES,
  isValidSeason,
  nextRememberedSeasonCookieValue,
  parseRememberedSeasonMap,
  readRememberedSeason,
} from "./remembered-season";

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

console.log("\nremembered-season");

// --- isValidSeason -----------------------------------------------------------

const VALID_SEASON_CASES: Array<{ name: string; value: unknown; expected: boolean }> = [
  { name: "1 is valid", value: 1, expected: true },
  { name: "9999 (ceiling) is valid", value: 9999, expected: true },
  { name: "0 is invalid (below minimum)", value: 0, expected: false },
  { name: "-1 is invalid", value: -1, expected: false },
  { name: "10000 is invalid (above ceiling)", value: 10000, expected: false },
  { name: "2.5 is invalid (not an integer)", value: 2.5, expected: false },
  { name: "NaN is invalid", value: Number.NaN, expected: false },
  { name: "'2' (string) is invalid", value: "2", expected: false },
  { name: "null is invalid", value: null, expected: false },
  { name: "undefined is invalid", value: undefined, expected: false },
];
for (const c of VALID_SEASON_CASES) {
  check(`isValidSeason: ${c.name}`, () => {
    assert.equal(isValidSeason(c.value), c.expected);
  });
}

// --- parseRememberedSeasonMap ------------------------------------------------

check("parseRememberedSeasonMap: null/undefined/empty parse to {}", () => {
  assert.deepEqual(parseRememberedSeasonMap(null), {});
  assert.deepEqual(parseRememberedSeasonMap(undefined), {});
  assert.deepEqual(parseRememberedSeasonMap(""), {});
});

check("parseRememberedSeasonMap: garbage (not JSON) parses to {}", () => {
  assert.deepEqual(parseRememberedSeasonMap("not-json{{{"), {});
});

check("parseRememberedSeasonMap: bad percent-encoding parses to {}", () => {
  assert.deepEqual(parseRememberedSeasonMap("%E0%A4%A"), {});
});

check("parseRememberedSeasonMap: a JSON array (wrong shape) parses to {}", () => {
  const raw = encodeURIComponent(JSON.stringify([1, 2, 3]));
  assert.deepEqual(parseRememberedSeasonMap(raw), {});
});

check("parseRememberedSeasonMap: a JSON primitive parses to {}", () => {
  assert.deepEqual(parseRememberedSeasonMap(encodeURIComponent("42")), {});
});

check("parseRememberedSeasonMap: valid map round-trips", () => {
  const raw = encodeURIComponent(
    JSON.stringify({ "rick-and-morty": 2, dune: 1 }),
  );
  assert.deepEqual(parseRememberedSeasonMap(raw), {
    "rick-and-morty": 2,
    dune: 1,
  });
});

check("parseRememberedSeasonMap: drops entries with invalid seasons, keeps the rest", () => {
  const raw = encodeURIComponent(
    JSON.stringify({
      good: 3,
      bad_float: 2.5,
      bad_string: "5",
      bad_negative: -1,
      bad_zero: 0,
      bad_huge: 999999,
    }),
  );
  assert.deepEqual(parseRememberedSeasonMap(raw), { good: 3 });
});

check("parseRememberedSeasonMap: workKeys are normalized (trim + lowercase)", () => {
  const raw = encodeURIComponent(JSON.stringify({ "  Rick-And-Morty  ": 2 }));
  assert.deepEqual(parseRememberedSeasonMap(raw), { "rick-and-morty": 2 });
});

check("parseRememberedSeasonMap: entries beyond MAX_ENTRIES are dropped", () => {
  const map: Record<string, number> = {};
  for (let i = 0; i < MAX_ENTRIES + 20; i++) map[`show-${i}`] = 1;
  const raw = encodeURIComponent(JSON.stringify(map));
  const parsed = parseRememberedSeasonMap(raw);
  assert.ok(Object.keys(parsed).length <= MAX_ENTRIES);
});

// --- readRememberedSeason -----------------------------------------------------

check("readRememberedSeason: returns the stored season for a known workKey", () => {
  const raw = encodeURIComponent(JSON.stringify({ "rick-and-morty": 2 }));
  assert.equal(readRememberedSeason(raw, "rick-and-morty"), 2);
});

check("readRememberedSeason: returns null for an unknown workKey", () => {
  const raw = encodeURIComponent(JSON.stringify({ "rick-and-morty": 2 }));
  assert.equal(readRememberedSeason(raw, "dune-2021"), null);
});

check("readRememberedSeason: workKey lookup is normalized", () => {
  const raw = encodeURIComponent(JSON.stringify({ "rick-and-morty": 2 }));
  assert.equal(readRememberedSeason(raw, "  Rick-And-Morty "), 2);
});

check("readRememberedSeason: null cookie returns null", () => {
  assert.equal(readRememberedSeason(null, "rick-and-morty"), null);
});

// --- nextRememberedSeasonCookieValue -----------------------------------------

check("nextRememberedSeasonCookieValue: remembers a season for a fresh cookie", () => {
  const next = nextRememberedSeasonCookieValue(null, "rick-and-morty", 2);
  assert.equal(readRememberedSeason(next, "rick-and-morty"), 2);
});

check("nextRememberedSeasonCookieValue: overwrites a previous season for the same title", () => {
  const first = nextRememberedSeasonCookieValue(null, "rick-and-morty", 2);
  const second = nextRememberedSeasonCookieValue(first, "rick-and-morty", 9);
  assert.equal(readRememberedSeason(second, "rick-and-morty"), 9);
});

check("nextRememberedSeasonCookieValue: preserves other titles already remembered", () => {
  const first = nextRememberedSeasonCookieValue(null, "dune-2021", 1);
  const second = nextRememberedSeasonCookieValue(first, "rick-and-morty", 2);
  assert.equal(readRememberedSeason(second, "dune-2021"), 1);
  assert.equal(readRememberedSeason(second, "rick-and-morty"), 2);
});

check("nextRememberedSeasonCookieValue: invalid season writes nothing (returns null)", () => {
  assert.equal(nextRememberedSeasonCookieValue(null, "rick-and-morty", 0), null);
  assert.equal(nextRememberedSeasonCookieValue(null, "rick-and-morty", -1), null);
  assert.equal(nextRememberedSeasonCookieValue(null, "rick-and-morty", 2.5), null);
  assert.equal(nextRememberedSeasonCookieValue(null, "rick-and-morty", 100000), null);
});

check("nextRememberedSeasonCookieValue: empty workKey writes nothing", () => {
  assert.equal(nextRememberedSeasonCookieValue(null, "   ", 2), null);
});

check("nextRememberedSeasonCookieValue: bounds total entries to MAX_ENTRIES", () => {
  let raw: string | null = null;
  for (let i = 0; i < MAX_ENTRIES + 25; i++) {
    raw = nextRememberedSeasonCookieValue(raw, `show-${i}`, 1);
  }
  const parsed = parseRememberedSeasonMap(raw);
  assert.ok(
    Object.keys(parsed).length <= MAX_ENTRIES,
    `expected at most ${MAX_ENTRIES} entries, got ${Object.keys(parsed).length}`,
  );
  // The most-recently-set title must survive the eviction.
  assert.equal(readRememberedSeason(raw, `show-${MAX_ENTRIES + 24}`), 1);
  // The earliest-set titles must have been evicted first.
  assert.equal(readRememberedSeason(raw, "show-0"), null);
});

check("nextRememberedSeasonCookieValue: serialized value never exceeds MAX_COOKIE_VALUE_LENGTH", () => {
  let raw: string | null = null;
  for (let i = 0; i < MAX_ENTRIES + 25; i++) {
    raw = nextRememberedSeasonCookieValue(raw, `a-very-long-show-title-key-${i}`, 12);
  }
  assert.ok(raw != null);
  assert.ok((raw as string).length <= MAX_COOKIE_VALUE_LENGTH);
});

check("nextRememberedSeasonCookieValue: re-remembering a title moves it to the back of eviction order", () => {
  let raw: string | null = null;
  // Fill to the cap.
  for (let i = 0; i < MAX_ENTRIES; i++) {
    raw = nextRememberedSeasonCookieValue(raw, `show-${i}`, 1);
  }
  // Touch show-0 again so it should no longer be the next eviction victim.
  raw = nextRememberedSeasonCookieValue(raw, "show-0", 5);
  // Adding one more entry evicts the oldest untouched title (show-1), not show-0.
  raw = nextRememberedSeasonCookieValue(raw, "show-new", 1);
  assert.equal(readRememberedSeason(raw, "show-0"), 5);
  assert.equal(readRememberedSeason(raw, "show-1"), null);
});

console.log(
  failures === 0
    ? "\nremembered-season: all ok"
    : `\nremembered-season: ${failures} FAIL`,
);
process.exitCode = failures === 0 ? 0 : 1;
