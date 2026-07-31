import assert from "node:assert/strict";
import {
  SEARCH_SCOPES,
  SECTION_SCOPES,
  type SearchScope,
} from "@/lib/torrents/search-scopes";
import { PRIMARY_NAV, SEARCH_HREF } from "@/lib/navigation";
import {
  DEFAULT_SECTION_SCOPE,
  EVERYTHING_HREF,
  MIN_SECTION_QUERY,
  SECTION_PAGE_SIZE,
  clampPage,
  downloadDestination,
  exampleQueries,
  hasMorePages,
  isSearchable,
  joinDownloadPath,
  loadedLabel,
  networkErrorFrom,
  parseSectionParams,
  retryLabel,
  searchErrorFrom,
  sectionHref,
  sectionView,
  type SectionError,
  type SectionViewKind,
} from "./everything-state";

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

console.log("everything section: scope routing, states, paging…");

// ---------------------------------------------------------------------------
// 1. The tab set is data, not a hardcoded list
// ---------------------------------------------------------------------------

check("the section renders every release scope, and only those", () => {
  const expected = SEARCH_SCOPES.filter((s) => s.kind === "release").map(
    (s) => s.id,
  );
  assert.deepEqual(
    SECTION_SCOPES.map((s) => s.id),
    expected,
    "SECTION_SCOPES must stay the release-kind scopes — a new one appears here " +
      "with no edit to the page",
  );
  assert.ok(SECTION_SCOPES.length >= 2, "a one-tab section is not a section");
});

check("every section scope can actually be searched and filed", () => {
  for (const scope of SECTION_SCOPES) {
    assert.equal(
      scope.kind,
      "release",
      `${scope.id}: only release-kind scopes belong in this section`,
    );
    assert.ok(
      scope.category,
      `${scope.id}: needs an aggregator category or the search cannot be scoped`,
    );
    assert.ok(scope.label.trim(), `${scope.id}: needs a tab label`);
    assert.ok(scope.blurb.trim(), `${scope.id}: the resting state renders a blurb`);
    assert.ok(
      scope.placeholder.trim(),
      `${scope.id}: the input renders a real example, never "Search…"`,
    );
  }
});

check("no film-shaped scope leaks into the section", () => {
  assert.ok(
    !SECTION_SCOPES.some((s) => s.id === "titles"),
    "Films & TV belongs to Browse; poster cards must not regress into rows",
  );
});

// ---------------------------------------------------------------------------
// 2. URL round-trip — the deep-link contract
// ---------------------------------------------------------------------------

const QUERIES = [
  "",
  "stardew",
  "Daft Punk Discovery",
  "c++ 2024",
  "a & b",
  "フリーレン",
  "  padded  ",
];

check("every scope × query round-trips through the URL", () => {
  for (const scope of SECTION_SCOPES) {
    for (const q of QUERIES) {
      const href = sectionHref(scope.id, q);
      assert.ok(
        href.startsWith(`${EVERYTHING_HREF}?`),
        `${scope.id}/${q}: href must address the section route`,
      );
      const parsed = parseSectionParams(href.slice(href.indexOf("?")));
      assert.equal(parsed.scope.id, scope.id, `${scope.id}/${q}: scope survived`);
      assert.equal(parsed.query, q.trim(), `${scope.id}/${q}: query survived`);
      assert.equal(parsed.notice, null, `${scope.id}/${q}: a valid link is quiet`);
    }
  }
});

check("the documented deep link restores exactly that state", () => {
  const parsed = parseSectionParams("?scope=games&q=stardew");
  assert.equal(parsed.scope.id, "games");
  assert.equal(parsed.scope.downloadCategory, "Games");
  assert.equal(parsed.query, "stardew");
  assert.equal(sectionHref("games", "stardew"), "/everything?scope=games&q=stardew");
});

check("an empty query is left out of the URL entirely", () => {
  for (const scope of SECTION_SCOPES) {
    const href = sectionHref(scope.id, "   ");
    assert.ok(!href.includes("q="), `${scope.id}: no empty q= in a resting link`);
  }
});

check("scope is always written, even for the default", () => {
  const href = sectionHref(DEFAULT_SECTION_SCOPE.id, "x");
  assert.ok(
    href.includes(`scope=${DEFAULT_SECTION_SCOPE.id}`),
    "a shared link must say which shelf it is",
  );
});

// ---------------------------------------------------------------------------
// 3. Untrusted scope input — the rule class, not one bad string
// ---------------------------------------------------------------------------

const BAD_SCOPES: Array<[string, string]> = [
  ["podcasts", "a plausible kind we do not have"],
  ["", "empty"],
  ["   ", "whitespace"],
  ["MUSIC ", "case and padding are normalised by parseScopeId"],
  ["../../etc", "path traversal"],
  ["<script>", "markup"],
  ["music,games", "a list"],
  ["0", "a number"],
];

check("an unknown scope falls back and says so", () => {
  for (const [value, why] of BAD_SCOPES) {
    const parsed = parseSectionParams(`?scope=${encodeURIComponent(value)}`);
    if (value.trim().toLowerCase() === "music") {
      assert.equal(parsed.scope.id, "music", `${why}: normalised, not rejected`);
      assert.equal(parsed.notice, null, `${why}: a real scope is quiet`);
      continue;
    }
    assert.equal(
      parsed.scope.id,
      DEFAULT_SECTION_SCOPE.id,
      `${why}: must fall back to the default scope`,
    );
    assert.equal(
      parsed.notice,
      value.trim() === "" ? null : "unknown-scope",
      `${why}: an unusable scope is reported, an absent one is not`,
    );
  }
});

check("a real scope that lives on Browse is distinguished from a typo", () => {
  const parsed = parseSectionParams("?scope=titles&q=dune");
  assert.equal(parsed.notice, "films", "titles exists — it just is not here");
  assert.equal(parsed.scope.id, DEFAULT_SECTION_SCOPE.id);
  assert.equal(parsed.query, "dune", "the query survives the wrong scope");
});

check("a missing scope is the default with no complaint", () => {
  for (const search of ["", "?", "?q=blender", "?other=1"]) {
    const parsed = parseSectionParams(search);
    assert.equal(parsed.scope.id, DEFAULT_SECTION_SCOPE.id, search);
    assert.equal(parsed.notice, null, `${search}: nothing was wrong`);
  }
});

check("URLSearchParams and raw strings parse identically", () => {
  const a = parseSectionParams("?scope=books&q=mistborn");
  const b = parseSectionParams(new URLSearchParams("scope=books&q=mistborn"));
  const c = parseSectionParams("scope=books&q=mistborn");
  assert.equal(a.scope.id, b.scope.id);
  assert.equal(b.scope.id, c.scope.id);
  assert.equal(a.query, c.query);
});

// ---------------------------------------------------------------------------
// 4. Which state renders
// ---------------------------------------------------------------------------

const throttled: SectionError = {
  kind: "throttled",
  message: "busy",
  retryAfterSeconds: 30,
};
const failed: SectionError = {
  kind: "failed",
  message: "boom",
  retryAfterSeconds: null,
};

const VIEW_CASES: Array<{
  name: string;
  input: Parameters<typeof sectionView>[0];
  expect: SectionViewKind;
}> = [
  {
    name: "no query at all → the resting brief",
    input: { query: "", loading: false, resultCount: 0, error: null },
    expect: "brief",
  },
  {
    name: "one character is not yet a query",
    input: { query: "s", loading: true, resultCount: 0, error: null },
    expect: "brief",
  },
  {
    name: "whitespace is not a query",
    input: { query: "   ", loading: false, resultCount: 0, error: null },
    expect: "brief",
  },
  {
    name: "typing a real query shows loading, never 'nothing matched'",
    input: { query: "stardew", loading: true, resultCount: 0, error: null },
    expect: "loading",
  },
  {
    name: "results present",
    input: { query: "stardew", loading: false, resultCount: 12, error: null },
    expect: "results",
  },
  {
    name: "loading page 2 keeps the rows on screen",
    input: { query: "stardew", loading: true, resultCount: 40, error: null },
    expect: "results",
  },
  {
    name: "a failed second page does not discard the first",
    input: { query: "stardew", loading: false, resultCount: 40, error: failed },
    expect: "results",
  },
  {
    name: "a rate limit on page 2 also keeps the rows",
    input: { query: "stardew", loading: false, resultCount: 40, error: throttled },
    expect: "results",
  },
  {
    name: "rate limited with nothing to show",
    input: { query: "stardew", loading: false, resultCount: 0, error: throttled },
    expect: "throttled",
  },
  {
    name: "a genuine failure with nothing to show",
    input: { query: "stardew", loading: false, resultCount: 0, error: failed },
    expect: "error",
  },
  {
    name: "answered, and the answer was nothing",
    input: { query: "asdkjhasd", loading: false, resultCount: 0, error: null },
    expect: "empty",
  },
  {
    name: "an error never outranks the brief — the query is not askable yet",
    input: { query: "", loading: false, resultCount: 0, error: failed },
    expect: "brief",
  },
];

check("every state is selected by rule, not by accident", () => {
  for (const c of VIEW_CASES) {
    assert.equal(sectionView(c.input), c.expect, c.name);
  }
});

check("all six states are reachable", () => {
  const seen = new Set(VIEW_CASES.map((c) => c.expect));
  for (const kind of [
    "brief",
    "loading",
    "results",
    "empty",
    "error",
    "throttled",
  ] as SectionViewKind[]) {
    assert.ok(seen.has(kind), `${kind} is never produced — it would be dead UI`);
  }
});

check("isSearchable agrees with the brief state", () => {
  for (const [q, expected] of [
    ["", false],
    ["a", false],
    [" a ", false],
    ["ab", true],
    ["  ab  ", true],
    ["stardew valley", true],
  ] as Array<[string, boolean]>) {
    assert.equal(isSearchable(q), expected, JSON.stringify(q));
    assert.equal(
      sectionView({ query: q, loading: false, resultCount: 0, error: null }) ===
        "brief",
      !expected,
      `${JSON.stringify(q)}: brief and isSearchable must never disagree`,
    );
  }
  assert.equal(MIN_SECTION_QUERY, 2, "matches the search overlay's threshold");
});

// ---------------------------------------------------------------------------
// 5. Errors — a rate limit is a wait, not a failure
// ---------------------------------------------------------------------------

check("429 is reported as a wait, with the server's own delay", () => {
  const e = searchErrorFrom(429, {
    error: "Indexers busy",
    message: "Too many searches",
    retryAfterSeconds: 24,
  });
  assert.equal(e.kind, "throttled");
  assert.equal(e.retryAfterSeconds, 24);
  assert.match(e.message, /24 seconds/, "the wait must be stated, not implied");
});

check("429 without a delay never invents one", () => {
  for (const body of [
    { error: "Indexers busy" },
    { error: "Indexers busy", retryAfterSeconds: 0 },
    { error: "Indexers busy", retryAfterSeconds: -5 },
    { error: "Indexers busy", retryAfterSeconds: "soon" },
    null,
  ]) {
    const e = searchErrorFrom(429, body);
    assert.equal(e.kind, "throttled", JSON.stringify(body));
    assert.equal(e.retryAfterSeconds, null, JSON.stringify(body));
    assert.match(e.message, /moment/, JSON.stringify(body));
    assert.doesNotMatch(e.message, /\d/, "no fabricated number");
  }
});

check("a fractional delay rounds up — never advise retrying too early", () => {
  assert.equal(searchErrorFrom(429, { retryAfterSeconds: 1.2 }).retryAfterSeconds, 2);
});

check("other failures carry the server's message and offer no wait", () => {
  const cases: Array<[number, Record<string, unknown> | null, RegExp]> = [
    [500, { error: "Search failed", message: "socket hang up" }, /socket hang up/],
    [500, { error: "Search failed" }, /Search failed/],
    [400, { error: "Query too long" }, /Query too long/],
    [502, null, /HTTP 502/],
    [503, {}, /HTTP 503/],
  ];
  for (const [status, body, pattern] of cases) {
    const e = searchErrorFrom(status, body);
    assert.equal(e.kind, "failed", String(status));
    assert.equal(e.retryAfterSeconds, null, String(status));
    assert.match(e.message, pattern, String(status));
  }
});

check("a thrown fetch error is a failure with the cause attached", () => {
  const e = networkErrorFrom(new Error("Failed to fetch"));
  assert.equal(e.kind, "failed");
  assert.match(e.message, /Failed to fetch/);
  assert.equal(networkErrorFrom(null).kind, "failed");
  assert.ok(networkErrorFrom(null).message.trim().length > 0, "never blank");
});

check("the retry countdown reads down to zero and then invites a retry", () => {
  assert.equal(retryLabel(30), "Try again in 30s");
  assert.equal(retryLabel(1), "Try again in 1s");
  assert.equal(retryLabel(0.4), "Try again in 1s");
  assert.equal(retryLabel(0), "Try again");
  assert.equal(retryLabel(-3), "Try again");
  assert.equal(retryLabel(NaN), "Try again");
});

// ---------------------------------------------------------------------------
// 6. Paging
// ---------------------------------------------------------------------------

const CLAMP_CASES: Array<[number, number, number, string]> = [
  [1, 14, 1, "the first page of many"],
  [14, 14, 14, "the last page"],
  [15, 14, 14, "past the end clamps to the last page"],
  [999, 14, 14, "a hand-edited page number"],
  [0, 14, 1, "zero is not a page"],
  [-3, 14, 1, "negative is not a page"],
  [1.9, 14, 1, "fractions floor"],
  [NaN, 14, 1, "NaN falls back to the first page"],
  [3, 0, 1, "no pages at all still yields a requestable page 1"],
  [3, NaN, 1, "an unknown total is treated as one page"],
  [2, 1, 1, "a shrunken result set pulls the page back"],
];

check("a page request is always one the server can serve", () => {
  for (const [page, totalPages, expected, why] of CLAMP_CASES) {
    assert.equal(clampPage(page, totalPages), expected, why);
  }
});

const MORE_CASES: Array<[number, number, boolean, string]> = [
  [1, 14, true, "more to come"],
  [13, 14, true, "one more"],
  [14, 14, false, "the end"],
  [15, 14, false, "past the end"],
  [1, 1, false, "a single page"],
  [1, 0, false, "no results"],
  [1, NaN, false, "unknown total offers nothing"],
  [NaN, 5, false, "unknown page offers nothing"],
];

check("'load more' only appears when another page exists", () => {
  for (const [page, totalPages, expected, why] of MORE_CASES) {
    assert.equal(hasMorePages(page, totalPages), expected, why);
  }
});

check("the loaded count never overstates what is on screen", () => {
  assert.equal(loadedLabel(0, 0), "No results");
  assert.equal(loadedLabel(40, 70), "40 of 70 results");
  assert.equal(loadedLabel(70, 70), "70 results");
  assert.equal(loadedLabel(999, 70), "70 results", "cannot show more than exist");
  assert.equal(loadedLabel(1, 1), "1 result", "singular");
  assert.equal(loadedLabel(-5, 12), "0 of 12 results");
});

check("paging every page reaches every result exactly once", () => {
  // Mirrors the live shape probed from /api/search?q=stardew&category=games.
  const total = 70;
  const pages = Math.ceil(total / SECTION_PAGE_SIZE);
  const seen: number[] = [];
  let page = 1;
  for (let guard = 0; guard < 50; guard += 1) {
    const requested = clampPage(page, pages);
    const start = (requested - 1) * SECTION_PAGE_SIZE;
    for (let i = start; i < Math.min(start + SECTION_PAGE_SIZE, total); i += 1) {
      seen.push(i);
    }
    if (!hasMorePages(requested, pages)) break;
    page = requested + 1;
  }
  assert.equal(seen.length, total, "every ranked result was reachable");
  assert.equal(new Set(seen).size, total, "no result was served twice");
  assert.ok(SECTION_PAGE_SIZE <= 200, "within the API's pageSize cap");
});

// ---------------------------------------------------------------------------
// 7. Where the bytes land
// ---------------------------------------------------------------------------

const scopeById = (id: string): SearchScope => {
  const hit = SECTION_SCOPES.find((s) => s.id === id);
  assert.ok(hit, `${id} must be a section scope`);
  return hit;
};

check("a configured base folder names the exact destination per scope", () => {
  const settings = { baseDownloadPath: "D:\\Media", savePath: "", pathRules: {} };
  const expected: Array<[string, string]> = [
    ["music", "D:\\Media\\Music"],
    ["games", "D:\\Media\\Games"],
    ["software", "D:\\Media\\Software"],
    ["books", "D:\\Media\\Books"],
    ["anime", "D:\\Media\\Anime"],
  ];
  for (const [id, path] of expected) {
    const dest = downloadDestination(scopeById(id), settings);
    assert.equal(dest.path, path, id);
    assert.ok(dest.configured, id);
    assert.equal(dest.perResult, false, id);
  }
});

check("posix and windows bases keep their own separator", () => {
  assert.equal(joinDownloadPath("/srv/media", "Music"), "/srv/media/Music");
  assert.equal(joinDownloadPath("/srv/media/", "Music"), "/srv/media/Music");
  assert.equal(joinDownloadPath("D:\\Media\\", "Music"), "D:\\Media\\Music");
  assert.equal(joinDownloadPath("", "Music"), "", "no base, no promise");
  assert.equal(joinDownloadPath("D:\\Media", ""), "D:\\Media");
});

check("a per-category path rule wins, exactly as it does on the server", () => {
  const dest = downloadDestination(scopeById("games"), {
    baseDownloadPath: "D:\\Media",
    pathRules: { Games: "E:\\Games library" },
  });
  assert.equal(dest.path, "E:\\Games library");
  assert.ok(dest.configured);
});

check("the mixed scope admits the folder depends on each result", () => {
  const dest = downloadDestination(scopeById("everything"), {
    baseDownloadPath: "D:\\Media",
  });
  assert.equal(dest.perResult, true, "a single folder here would be a guess");
  assert.equal(dest.category, null);
  assert.equal(dest.path, "D:\\Media", "the root is still knowable");
});

check("an unconfigured folder is admitted, not faked", () => {
  for (const settings of [null, {}, { baseDownloadPath: "  ", savePath: "" }]) {
    const dest = downloadDestination(scopeById("music"), settings);
    assert.equal(dest.configured, false, JSON.stringify(settings));
    assert.equal(dest.path, "Music", "only the category folder is known");
  }
});

check("a flat savePath is used when no base folder is set", () => {
  const dest = downloadDestination(scopeById("books"), {
    baseDownloadPath: "",
    savePath: "/downloads",
  });
  assert.equal(dest.path, "/downloads");
  assert.ok(dest.configured);
});

// ---------------------------------------------------------------------------
// 8. The resting state offers real queries
// ---------------------------------------------------------------------------

check("examples come from the scope, and are usable as typed", () => {
  for (const scope of SECTION_SCOPES) {
    const examples = exampleQueries(scope);
    assert.ok(
      examples.length === 0 || examples.length >= 2,
      `${scope.id}: one example is a placeholder, not a suggestion set`,
    );
    for (const example of examples) {
      assert.ok(example.trim().length > 0, `${scope.id}: no blank chips`);
      assert.doesNotMatch(
        example,
        /[\u2026]|\.\.\.$/,
        `${scope.id}: "${example}" still carries an ellipsis`,
      );
      assert.ok(
        isSearchable(example),
        `${scope.id}: "${example}" must be long enough to actually search`,
      );
    }
  }
});

check("the vague catch-all scope offers no fake examples", () => {
  assert.deepEqual(
    exampleQueries(scopeById("everything")),
    [],
    '"Anything at all" is not a suggestion',
  );
});

check("the scopes that name real things do offer them", () => {
  assert.deepEqual(exampleQueries(scopeById("games")), [
    "Stardew Valley",
    "Elden Ring",
  ]);
  assert.deepEqual(exampleQueries(scopeById("software")), [
    "Blender",
    "Photoshop",
    "Office",
  ]);
});

// ---------------------------------------------------------------------------
// 9. The way in — the nav entry this whole section exists to provide
// ---------------------------------------------------------------------------

check("Everything is a primary destination, right after Search", () => {
  const hrefs = PRIMARY_NAV.map((i) => i.href);
  assert.ok(
    hrefs.includes(EVERYTHING_HREF),
    "the section is unreachable without a nav entry — the original complaint",
  );
  assert.equal(
    hrefs.indexOf(EVERYTHING_HREF),
    hrefs.indexOf(SEARCH_HREF) + 1,
    "it sits beside the other way of finding things",
  );
  assert.equal(
    PRIMARY_NAV.find((i) => i.href === EVERYTHING_HREF)?.label,
    "Everything",
  );
});

check("the mobile tab bar still fits every primary label", () => {
  /**
   * The bar is one equal column per primary entry plus More. At 390px that is
   * 390 / (n + 1) per column, and the labels render at 10px — roughly 0.55em
   * per character for this typeface. A label wider than its column truncates
   * to "Everythi…", which is exactly the kind of half-word the owner would
   * have to guess at.
   */
  const columns = PRIMARY_NAV.length + 1;
  const columnPx = 390 / columns;
  for (const item of PRIMARY_NAV) {
    const approxPx = item.label.length * 10 * 0.55;
    assert.ok(
      approxPx <= columnPx - 4,
      `${item.label}: ~${approxPx.toFixed(0)}px does not fit a ${columnPx.toFixed(
        0,
      )}px tab at 390px`,
    );
  }
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}

console.log("\nAll everything-section tests passed.");
