import assert from "node:assert/strict";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import {
  DEFAULT_PAGE_SIZE,
  buildSearchQuery,
  resultPageView,
} from "./pagination";

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

console.log("search pagination: reachable, ordered pages…");

/**
 * A deterministic stand-in for `/api/search`. It holds a fixed, already-ranked
 * pool and serves the same page/pageSize slice the real aggregator does, so a
 * test can drive the exact request/response loop the component performs without
 * touching a live indexer.
 */
const TOTAL = 305;
const pool: TorrentResult[] = Array.from({ length: TOTAL }, (_, i) => ({
  id: `t-${String(i).padStart(4, "0")}`,
  title: `Result ${i}`,
  source: "apibay",
  seeders: TOTAL - i,
  leechers: 0,
  sizeBytes: 1_000_000_000,
  magnet: `magnet:?xt=urn:btih:${i}`,
})) as unknown as TorrentResult[];

function fakeSearchApi(queryString: string): SearchResponse {
  const params = new URLSearchParams(queryString);
  const pageSize = Math.min(
    Math.max(parseInt(params.get("pageSize") ?? "20", 10) || 20, 1),
    200,
  );
  const totalPages = Math.ceil(pool.length / pageSize);
  const page = Math.min(
    Math.max(parseInt(params.get("page") ?? "1", 10) || 1, 1),
    totalPages,
  );
  const start = (page - 1) * pageSize;
  return {
    query: params.get("q") ?? "",
    results: pool.slice(start, start + pageSize),
    tookMs: 0,
    totalCount: pool.length,
    page,
    pageSize,
    totalPages,
    sources: [{ id: "apibay", count: pool.length }],
  };
}

check("default page size stays within the API's 200 cap", () => {
  assert.ok(DEFAULT_PAGE_SIZE <= 200, "must not request more than the API allows");
});

check("the search request always carries page and pageSize", () => {
  const qs = buildSearchQuery({ query: "dune", page: 2, pageSize: DEFAULT_PAGE_SIZE });
  const params = new URLSearchParams(qs);
  assert.equal(params.get("q"), "dune");
  assert.equal(params.get("page"), "2");
  assert.equal(params.get("pageSize"), String(DEFAULT_PAGE_SIZE));
});

check("page 1 shows the first pageSize results and a correct label", () => {
  const qs = buildSearchQuery({ query: "dune", page: 1, pageSize: DEFAULT_PAGE_SIZE });
  const res = fakeSearchApi(qs);
  assert.equal(res.results.length, DEFAULT_PAGE_SIZE, "page 1 is a full page");
  assert.equal(res.results[0].id, "t-0000");
  assert.equal(res.results[DEFAULT_PAGE_SIZE - 1].id, "t-0199");

  const view = resultPageView(res, 1, DEFAULT_PAGE_SIZE);
  assert.equal(view.rangeStart, 1);
  assert.equal(view.rangeEnd, 200);
  assert.equal(view.totalCount, 305);
  assert.equal(view.totalPages, 2);
  assert.equal(view.label, "1\u2013200 of 305");
});

check("advancing a page reveals the remaining, previously-unreachable results", () => {
  const p1 = fakeSearchApi(
    buildSearchQuery({ query: "dune", page: 1, pageSize: DEFAULT_PAGE_SIZE }),
  );
  const p2 = fakeSearchApi(
    buildSearchQuery({ query: "dune", page: 2, pageSize: DEFAULT_PAGE_SIZE }),
  );

  assert.equal(p2.results.length, 305 - DEFAULT_PAGE_SIZE, "page 2 holds the tail");
  assert.equal(p2.results[0].id, "t-0200", "page 2 starts where page 1 stopped");
  assert.equal(p2.results.at(-1)!.id, "t-0304");

  const p1ids = new Set(p1.results.map((r) => r.id));
  assert.ok(
    p2.results.every((r) => !p1ids.has(r.id)),
    "no page-1 result reappears on page 2",
  );

  const view = resultPageView(p2, 2, DEFAULT_PAGE_SIZE);
  assert.equal(view.rangeStart, 201);
  assert.equal(view.rangeEnd, 305);
  assert.equal(view.label, "201\u2013305 of 305");
});

check("every ranked result is reachable across the two pages, order preserved", () => {
  const seen: string[] = [];
  for (let page = 1; ; page++) {
    const res = fakeSearchApi(
      buildSearchQuery({ query: "dune", page, pageSize: DEFAULT_PAGE_SIZE }),
    );
    for (const r of res.results) seen.push(r.id);
    if (page >= res.totalPages) break;
  }
  assert.equal(seen.length, TOTAL, "all results were paged through");
  assert.deepEqual(
    seen,
    pool.map((r) => r.id),
    "the concatenated pages preserve the server's ranked order",
  );
});

check("an empty pool renders a 0-results label, not a stray range", () => {
  const view = resultPageView(
    {
      results: [],
      totalCount: 0,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      totalPages: 0,
    },
    1,
    DEFAULT_PAGE_SIZE,
  );
  assert.equal(view.rangeStart, 0);
  assert.equal(view.rangeEnd, 0);
  assert.equal(view.label, "0 results");
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}

console.log("\nAll search pagination tests passed.");
