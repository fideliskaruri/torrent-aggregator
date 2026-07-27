/**
 * Availability ↔ search-cache seam test.
 *
 * Run: npx tsx scripts/test-availability-seam.mts   (or `npm run test:seam`)
 *
 * WHY THIS EXISTS
 * ---------------
 * `resolveAvailabilityBatch` used to locate cached searches by rebuilding the
 * producer's `cacheKey` — a sha256 over the *entire* search option set. It
 * guessed `limit: "default"`, `filters: {}` and omitted `target` entirely, so
 * the hash could never collide with what `searchTorrents` actually wrote. The
 * lookup missed 100% of the time, which made `fetchable` and `unavailable`
 * unreachable states.
 *
 * It was invisible for two reasons, and both are the real lesson:
 *   1. A miss degrades to the *neutral* `{ state: null }` affordance, so the
 *      page rendered exactly as designed. Nothing looked broken.
 *   2. The existing unit tests call `resolveFromSearchCache(query, cached)`
 *      with a hand-built `cached` object, which bypasses the seam completely.
 *      They were green throughout.
 *
 * So this test deliberately writes through the **real producer**
 * (`setSearchCache`) using an option shape the consumer could not possibly
 * guess, and then reads through the **real consumer**
 * (`resolveAvailabilityBatch`). Nothing is hand-built in the middle. Revert the
 * fix and case 1 fails.
 *
 * Uses a random userId that owns no EngineTorrent rows, which forces every
 * query down the search-cache path rather than resolving locally.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { setSearchCache, cacheKeyFrom } from "../src/lib/torrents/search-cache";
import { resolveAvailability, resolveAvailabilityBatch } from "../src/lib/browse/availability";
import type { SearchResponse, TorrentResult } from "../src/lib/torrents/types";

const userId = `seam-test-${randomUUID()}`;
const writtenKeys: string[] = [];

function result(over: Partial<TorrentResult> & { title: string }): TorrentResult {
  return {
    id: randomUUID(),
    sizeBytes: 8_000_000_000,
    seeders: 50,
    leechers: 2,
    source: "apibay",
    sourceUrl: "https://example.invalid",
    tags: [],
    ...over,
  } as TorrentResult;
}

function response(query: string, results: TorrentResult[]): SearchResponse {
  return {
    query,
    results,
    groups: [],
    tookMs: 1,
    sources: [],
    totalCount: results.length,
    page: 1,
    pageSize: 50,
    totalPages: 1,
  } as SearchResponse;
}

/**
 * Write through the producer using an option set the consumer has no way to
 * reconstruct — this is the whole point of the test. If availability ever goes
 * back to guessing the key, these extra fields make the guess wrong again.
 */
async function writeAs(query: string, results: TorrentResult[]): Promise<void> {
  const key = cacheKeyFrom({
    q: query.toLowerCase(),
    category: "movies",
    limit: 15,
    sources: ["apibay"],
    filters: { hasMagnet: true, season: 1, episode: 1 },
    target: "2160p",
  });
  writtenKeys.push(key);
  await setSearchCache(key, response(query, results));
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log("availability ↔ search-cache seam\n");

  // --- Case 1: the seam itself -------------------------------------------
  // A search was cached for "Dune Part Two" with a healthy release. Browse must
  // be able to find it and say `fetchable`. This is the case that failed before.
  await writeAs("Dune Part Two", [
    result({ title: "Dune.Part.Two.2024.2160p.BluRay.x265", seeders: 400 }),
  ]);

  const [fetchable] = await resolveAvailabilityBatch(userId, [
    { title: "Dune Part Two", mediaType: "movie" },
  ]);
  check("a cached search is found through the batch resolver → fetchable", () => {
    assert.equal(
      fetchable.state,
      "fetchable",
      `expected 'fetchable', got ${JSON.stringify(fetchable)} — the consumer ` +
        `could not find a row the producer definitely wrote`,
    );
  });

  // The single-resolve path is a separate code path and must agree.
  const single = await resolveAvailability(`${userId}-single`, {
    title: "Dune Part Two",
    mediaType: "movie",
  });
  check("the single resolver agrees with the batch resolver", () => {
    assert.equal(single.state, "fetchable", `got ${JSON.stringify(single)}`);
  });

  // --- Case 2: unknown must not be reported as unavailable ----------------
  const [unknown] = await resolveAvailabilityBatch(userId, [
    { title: `Nothing Ever Searched ${randomUUID()}`, mediaType: "movie" },
  ]);
  check("a title with no cached search stays unknown, never 'unavailable'", () => {
    assert.equal(
      unknown.state,
      null,
      `claiming 'unavailable' without having looked is the exact failure the ` +
        `availability contract forbids; got ${JSON.stringify(unknown)}`,
    );
  });

  // --- Case 3: a real 'unavailable' claim ---------------------------------
  // We *did* search, and everything we found is a dead swarm. That is a claim
  // we are entitled to make.
  await writeAs("Obscure Test Film", [
    result({ title: "Obscure.Test.Film.2019.1080p.WEB", seeders: 0 }),
  ]);
  const [dead] = await resolveAvailabilityBatch(userId, [
    { title: "Obscure Test Film", mediaType: "movie" },
  ]);
  check("a cached search with only dead swarms → unavailable", () => {
    assert.equal(dead.state, "unavailable", `got ${JSON.stringify(dead)}`);
  });

  // --- Case 4: episode narrowing still applies ----------------------------
  // The cached search is broad (a whole-series query); the question is narrow.
  // Finding the series must not be mistaken for finding the episode.
  await writeAs("Dune Prophecy", [
    result({ title: "Dune.Prophecy.S01E01.2160p.MAX.WEB-DL", seeders: 120 }),
  ]);

  const [rightEp] = await resolveAvailabilityBatch(userId, [
    { title: "Dune Prophecy", season: 1, episode: 1, mediaType: "tv" },
  ]);
  check("a cached search satisfies the episode it actually contains", () => {
    assert.equal(rightEp.state, "fetchable", `got ${JSON.stringify(rightEp)}`);
  });

  const [wrongEp] = await resolveAvailabilityBatch(userId, [
    { title: "Dune Prophecy", season: 4, episode: 9, mediaType: "tv" },
  ]);
  check("an episode the cached search does not contain is not fetchable", () => {
    assert.notEqual(
      wrongEp.state,
      "fetchable",
      `S04E09 is not in the cached results, so we must not offer to fetch it; ` +
        `got ${JSON.stringify(wrongEp)}`,
    );
  });

  // --- Case 5: the producer records what the consumer looks up ------------
  // Guards the column itself: if a future change stops writing
  // `normalizedQuery`, every lookup silently degrades to `unknown` again.
  const rows = await prisma.searchCache.findMany({
    where: { cacheKey: { in: writtenKeys } },
    select: { normalizedQuery: true },
  });
  check("every row the producer wrote carries a normalizedQuery", () => {
    assert.equal(rows.length, writtenKeys.length, "not all rows were persisted");
    const missing = rows.filter((r) => !r.normalizedQuery).length;
    assert.equal(
      missing,
      0,
      `${missing} row(s) have a null normalizedQuery — the consumer indexes on ` +
        `this column, so those searches are invisible to browse`,
    );
  });
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(async () => {
    // Clean up only what this run created.
    await prisma.searchCache
      .deleteMany({ where: { cacheKey: { in: writtenKeys } } })
      .catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);

    if (failures) {
      console.error(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nALL GREEN — availability seam holds");
  });
