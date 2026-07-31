/**
 * Which request the palette makes, and what it shows while it waits.
 *
 * The defect class these pin is a *combination* one. With a single kind of
 * search the states were nearly independent; with scopes there are two request
 * shapes and six display states, and the bugs live where they cross — a "no
 * results" panel shown while a request is still in flight, a film request sent
 * for a music query, or a rate-limit refusal reported as an empty corpus.
 *
 * The rules, in the order they must hold:
 *
 *   1. **A scope's request goes where that scope's data lives.** Films to TMDB,
 *      everything else to the aggregator with the right category. Getting this
 *      wrong means music search quietly returns films.
 *   2. **A refusal is never "nothing matched".** "No results" is a claim about
 *      the corpus and we have no right to make it when the request failed.
 *   3. **Results outrank loading.** A new keystroke must not blank a list that
 *      is still useful.
 *   4. **No state is ever blank.** Every branch renders something that says what
 *      is happening or what to type.
 *
 * Run: npx tsx src/components/search/search-overlay-state.test.ts
 */
import assert from "node:assert/strict";
import {
  MIN_QUERY_LENGTH,
  placeholderFor,
  searchDisplayFor,
  searchErrorMessage,
  searchRequestFor,
} from "./search-overlay-state";
import { SEARCH_SCOPES, type SearchScopeId } from "@/lib/torrents/search-scopes";

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

function main() {
  console.log("search-overlay-state.test.ts");

  // ── Rule 1: the request goes where the data is ───────────────────────────
  const routing: Array<{
    scope: SearchScopeId;
    expectPath: string;
    expectCategory: string | null;
    kind: "work" | "release";
  }> = [
    { scope: "titles", expectPath: "/api/search/titles", expectCategory: null, kind: "work" },
    { scope: "music", expectPath: "/api/search", expectCategory: "music", kind: "release" },
    { scope: "games", expectPath: "/api/search", expectCategory: "games", kind: "release" },
    { scope: "software", expectPath: "/api/search", expectCategory: "apps", kind: "release" },
    { scope: "books", expectPath: "/api/search", expectCategory: "books", kind: "release" },
    { scope: "anime", expectPath: "/api/search", expectCategory: "anime", kind: "release" },
    { scope: "everything", expectPath: "/api/search", expectCategory: "all", kind: "release" },
  ];
  for (const row of routing) {
    check(`${row.scope} searches ${row.expectPath} (${row.expectCategory ?? "tmdb"})`, () => {
      const req = searchRequestFor(row.scope, "daft punk");
      assert.ok(req, "a valid query must produce a request");
      const url = new URL(req.url, "http://x");
      assert.equal(url.pathname, row.expectPath);
      assert.equal(url.searchParams.get("category"), row.expectCategory);
      assert.equal(url.searchParams.get("q"), "daft punk");
      assert.equal(req.kind, row.kind);
    });
  }

  check("every scope in the vocabulary is routable", () => {
    // Adding a scope without teaching this module about it would silently send
    // its searches to films. Enumerated from the source of truth so a new scope
    // fails here rather than in the browser.
    for (const scope of SEARCH_SCOPES) {
      const req = searchRequestFor(scope.id, "something");
      assert.ok(req, `${scope.id} produced no request`);
      assert.equal(
        req.kind,
        scope.kind === "work" ? "work" : "release",
        `${scope.id} routed to the wrong renderer`,
      );
    }
  });

  // ── Spending the shared indexer budget ───────────────────────────────────
  const tooShort = ["", " ", "a", " a "];
  for (const q of tooShort) {
    check(`"${q}" sends no request — the indexer budget is shared`, () => {
      assert.equal(searchRequestFor("music", q), null);
    });
  }
  check(`${MIN_QUERY_LENGTH} characters is enough to search`, () => {
    assert.ok(searchRequestFor("music", "ab"));
  });
  check("surrounding whitespace is trimmed, not sent", () => {
    const req = searchRequestFor("music", "  daft punk  ");
    assert.equal(new URL(req!.url, "http://x").searchParams.get("q"), "daft punk");
  });

  check("a films search carries no category — it must never reach the indexers", () => {
    // The oldest rule on this surface, restated behaviourally now that the two
    // flows share one entry point. Typing a film name fires TMDB only; a
    // category on that request would mean the film path had started spending
    // the shared indexer budget on every keystroke.
    const req = searchRequestFor("titles", "dune");
    const url = new URL(req!.url, "http://x");
    assert.equal(url.pathname, "/api/search/titles");
    assert.equal(url.searchParams.get("category"), null);
    assert.equal(url.searchParams.has("pageSize"), false);
  });

  check("every non-film scope carries a category — none silently falls back", () => {
    // The mirror failure: a scope that reached the aggregator with no category
    // would return an unfiltered mix and look like the feature does not work.
    for (const scope of SEARCH_SCOPES.filter((s) => s.kind === "release")) {
      const req = searchRequestFor(scope.id, "something");
      const url = new URL(req!.url, "http://x");
      assert.equal(url.pathname, "/api/search", scope.id);
      assert.equal(url.searchParams.get("category"), scope.category, scope.id);
    }
  });

  // ── Rule 2 + 3 + 4: the display states ───────────────────────────────────
  const displays: Array<{
    name: string;
    input: Parameters<typeof searchDisplayFor>[0];
    expect: string;
  }> = [
    {
      name: "an untouched scope prompts instead of showing a void",
      input: { scopeId: "music", query: "", loading: false, error: null, resultCount: 0 },
      expect: "prompt",
    },
    {
      name: "one character is 'still typing', not 'nothing matched'",
      input: { scopeId: "music", query: "d", loading: false, error: null, resultCount: 0 },
      expect: "typing",
    },
    {
      name: "an in-flight search with nothing yet is loading",
      input: { scopeId: "music", query: "daft", loading: true, error: null, resultCount: 0 },
      expect: "loading",
    },
    {
      name: "results outrank loading — a keystroke never blanks a useful list",
      input: { scopeId: "music", query: "daft", loading: true, error: null, resultCount: 8 },
      expect: "results",
    },
    {
      name: "a completed search with nothing found is empty",
      input: { scopeId: "music", query: "zzzz", loading: false, error: null, resultCount: 0 },
      expect: "empty",
    },
    {
      name: "a refusal is an ERROR, never 'nothing matched'",
      input: {
        scopeId: "music",
        query: "daft",
        loading: false,
        error: "Searching too quickly",
        resultCount: 0,
      },
      expect: "error",
    },
    {
      name: "an error with results still shows the results",
      input: {
        scopeId: "music",
        query: "daft",
        loading: false,
        error: "stale failure",
        resultCount: 3,
      },
      expect: "results",
    },
  ];
  for (const row of displays) {
    check(row.name, () => {
      assert.equal(searchDisplayFor(row.input).state, row.expect);
    });
  }

  check("a results state names the renderer its scope needs", () => {
    const work = searchDisplayFor({
      scopeId: "titles",
      query: "dune",
      loading: false,
      error: null,
      resultCount: 5,
    });
    const release = searchDisplayFor({
      scopeId: "music",
      query: "dune",
      loading: false,
      error: null,
      resultCount: 5,
    });
    assert.equal(work.state === "results" && work.kind, "work");
    assert.equal(release.state === "results" && release.kind, "release");
  });

  check("every scope has a prompt that says something specific", () => {
    // "No blank states" as a rule over the whole vocabulary, not one screen.
    for (const scope of SEARCH_SCOPES) {
      const display = searchDisplayFor({
        scopeId: scope.id,
        query: "",
        loading: false,
        error: null,
        resultCount: 0,
      });
      assert.equal(display.state, "prompt");
      assert.ok(scope.blurb.trim().length > 10, `${scope.id} blurb too thin`);
      assert.ok(scope.placeholder.trim().length > 3, `${scope.id} placeholder too thin`);
      assert.doesNotMatch(
        scope.placeholder,
        /^search/i,
        `${scope.id}: "Search…" teaches nothing — give a real example`,
      );
    }
  });

  check("each scope's placeholder is its own", () => {
    const seen = new Set(SEARCH_SCOPES.map((s) => placeholderFor(s.id)));
    assert.equal(seen.size, SEARCH_SCOPES.length, "two scopes share a placeholder");
  });

  // ── Error copy: a refusal must be actionable ─────────────────────────────
  check("a 429 says it is temporary, not that the search failed", () => {
    const msg = searchErrorMessage(429, null);
    assert.match(msg, /again/i, "must tell the owner what to do");
    assert.doesNotMatch(msg, /failed|error/i, `sounds like a fault: ${msg}`);
  });
  check("a stated server reason beats generic copy", () => {
    assert.equal(searchErrorMessage(400, { error: "Query too long" }), "Query too long");
  });
  check("a 5xx blames the indexers, not the owner's spelling", () => {
    assert.match(searchErrorMessage(503, null), /did not answer|try again/i);
  });
  check("an unreadable failure still says something", () => {
    const msg = searchErrorMessage(418, null);
    assert.ok(msg.trim().length > 0);
    assert.doesNotMatch(msg, /undefined|null|\[object/i);
  });

  if (failures > 0) {
    console.error(`search-overlay-state.test.ts: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("search-overlay-state.test.ts: all assertions passed");
}

main();
