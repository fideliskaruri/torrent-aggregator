/**
 * Background pre-ranking tests.
 *
 * WHAT THESE ARE GUARDING
 * -----------------------
 * 1. **The search-cache seam.** A previous bug rebuilt another module's opaque
 *    `cacheKey` from guessed values, so every lookup missed — silently, because
 *    a miss degrades to a neutral shrug. `getPreRanked` therefore looks a
 *    cached search up by `normalizedQuery`, and case "finds a cached search"
 *    writes through the **real producer** (`setSearchCache`) with an option set
 *    the consumer could not possibly guess. If anyone reintroduces key
 *    reconstruction, that case fails.
 *
 * 2. **The fast path is real.** The last case seeds the real `SearchCache` with
 *    the real key and then calls the **real `searchTorrents`** with the option
 *    set `prewarmSearchOptions` produces. It asserts `cached: true` — i.e. the
 *    grab that follows a pre-rank reaches no indexer at all. That is what
 *    "instant Download" actually means, and it is asserted on the cache flag, not
 *    on a stopwatch.
 *
 * 3. **Determined vs undetermined.** `candidate: null` (we looked, nothing was
 *    usable) must stay distinguishable from `null` (we never looked). Same
 *    distinction as `availability: null` vs `"unavailable"`.
 *
 * Run: npx tsx src/lib/prewarm/prerank.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { SearchThrottledError } from "@/lib/torrents/aggregator";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { cacheKeyFrom, setSearchCache } from "@/lib/torrents/search-cache";
import { getTargetResolution } from "@/lib/torrents/target-resolution";
import { episodeSearchQuery } from "@/lib/library/cursor";
import { normalizeTitle } from "@/lib/utils";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import {
  clearPreRankMemo,
  getPreRanked,
  preRank,
  preRankQuery,
  prewarmSearchOptions,
  releaseInfoHash,
  searchPayloadFor,
  selectBestRelease,
} from "./prerank";
import type { PreRankTarget } from "./types";

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

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

// A show name nothing else in the database can collide with. Letters only, so
// `normalizeTitle` leaves it intact.
const SHOW = `Zzqx Prewarm ${randomUUID().replace(/[^a-z]/g, "").slice(0, 8) || "showname"}`;
const writtenKeys: string[] = [];

function result(over: Partial<TorrentResult> & { title: string }): TorrentResult {
  // 40-hex, because that is what a real btih is and what `normalizeInfoHash`
  // accepts. A shorter fake would be silently unusable and every selection
  // assertion below would pass for the wrong reason.
  const hash = over.infoHash ?? createHash("sha1").update(randomUUID()).digest("hex");
  return {
    id: randomUUID(),
    magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(over.title)}`,
    infoHash: hash,
    sizeBytes: 1_400_000_000,
    seeders: 40,
    leechers: 3,
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
    pageSize: 20,
    totalPages: 1,
  } as SearchResponse;
}

async function main(): Promise<void> {
  console.log("prewarm pre-ranking\n");

  try {
    // ── Query + options are one shared, stable shape ────────────────────
    check("a series target searches with the library's own episode query", () => {
      assert.equal(
        preRankQuery({ title: SHOW, mediaType: "tv", season: 2, episode: 7 }),
        episodeSearchQuery(SHOW, 2, 7),
      );
    });

    check("a film target searches for the bare title", () => {
      assert.equal(preRankQuery({ title: "Dune Part Two", mediaType: "movie" }), "Dune Part Two");
    });

    check("prewarmSearchOptions is deterministic", () => {
      const t: PreRankTarget = { title: SHOW, mediaType: "tv", season: 1, episode: 2 };
      assert.deepEqual(prewarmSearchOptions(t), prewarmSearchOptions(t));
      assert.equal(
        JSON.stringify(searchPayloadFor(prewarmSearchOptions(t))),
        JSON.stringify(searchPayloadFor(prewarmSearchOptions(t))),
        "the payload must serialise identically or the cache key cannot match",
      );
    });

    check("speculation uses the background indexer budget, not the user's", () => {
      const o = prewarmSearchOptions({ title: SHOW, mediaType: "tv", season: 1, episode: 2 });
      assert.equal(o.background, true, "a human at the search box must not be throttled by us");
      assert.equal(o.skipCache, false, "speculation must be allowed to hit the cache");
      assert.equal(o.enrich, false, "no metadata fan-out for work nobody asked for");
    });

    // ── Selection reuses the ranker's order and filters nothing else ────
    const target: PreRankTarget = { title: SHOW, mediaType: "tv", season: 1, episode: 4 };

    check("the first usable release in rank order wins", () => {
      const a = result({ title: `${SHOW} S01E04 1080p WEB-DL` });
      const b = result({ title: `${SHOW} S01E04 2160p WEB-DL` });
      assert.equal(selectBestRelease([a, b], target)?.id, a.id, "must not re-sort");
      assert.equal(selectBestRelease([b, a], target)?.id, b.id, "must not re-sort");
    });

    check("a release with no magnet or no seeders is not usable", () => {
      const dead = result({ title: `${SHOW} S01E04 1080p`, seeders: 0 });
      const noMagnet = result({ title: `${SHOW} S01E04 720p`, magnet: undefined, infoHash: undefined });
      const good = result({ title: `${SHOW} S01E04 480p` });
      assert.equal(selectBestRelease([dead, noMagnet, good], target)?.id, good.id);
      assert.equal(selectBestRelease([dead, noMagnet], target), null);
    });

    check("the wrong episode is never accepted", () => {
      const wrong = result({ title: `${SHOW} S01E05 1080p WEB-DL` });
      assert.equal(selectBestRelease([wrong], target), null);
    });

    check("a season pack is not accepted in place of one episode", () => {
      const pack = result({ title: `${SHOW} S01 COMPLETE 1080p WEB-DL` });
      assert.equal(
        selectBestRelease([pack], target),
        null,
        "the pre-warm budget is sized for one episode, not forty",
      );
    });

    check("a release we could never label is not a release we speculate on", () => {
      const unlabelable = result({
        title: `${SHOW} S01E04 1080p`,
        magnet: "magnet:?dn=no-hash-here",
        infoHash: undefined,
      });
      assert.equal(releaseInfoHash(unlabelable), null);
      assert.equal(
        selectBestRelease([unlabelable], target),
        null,
        "without a hash the EngineTorrent row could never be marked prewarm",
      );
    });

    check("a film target takes the top-ranked usable release", () => {
      const film: PreRankTarget = { title: "Dune Part Two", mediaType: "movie" };
      const top = result({ title: "Dune.Part.Two.2024.2160p" });
      assert.equal(selectBestRelease([top], film)?.id, top.id);
    });

    // ── THE SEAM: write through the real producer, read through us ──────
    // The option set below is deliberately one `getPreRanked` cannot guess —
    // different limit, different sources, an extra `target`. If lookup ever
    // goes back to reconstructing `cacheKey`, this is the case that breaks.
    const query = episodeSearchQuery(SHOW, 1, 4);
    const planted = result({ title: `${SHOW} S01E04 1080p WEB-DL`, seeders: 321 });
    const unguessableKey = cacheKeyFrom({
      q: query.toLowerCase(),
      category: "anime",
      limit: 77,
      sources: ["nyaa", "yts"],
      filters: { hasMagnet: true, minSeeders: 9, resolution: "2160p" },
      target: 4321,
    });
    writtenKeys.push(unguessableKey);
    await setSearchCache(
      unguessableKey,
      response(query, [result({ title: `${SHOW} S01E04 720p`, seeders: 2 }), planted]),
    );

    clearPreRankMemo();

    await checkAsync(
      "a search cached by someone else is found without reconstructing its key",
      async () => {
        const choice = await getPreRanked(target, { db: prisma });
        assert.ok(
          choice,
          "found nothing — the normalizedQuery lookup is the only supported seam",
        );
        assert.equal(choice.normalizedQuery, normalizeTitle(SHOW));
        assert.equal(choice.source, "search-cache");
        assert.ok(choice.candidate, "a pool with a usable release must yield a candidate");
        assert.equal(choice.candidate.title, `${SHOW} S01E04 720p`, "rank order preserved");
        assert.equal(choice.resultCount, 2);
      },
    );

    await checkAsync("a second read is served from the in-process memo", async () => {
      const choice = await getPreRanked(target, { db: prisma });
      assert.ok(choice);
      assert.equal(choice.source, "memo");
    });

    await checkAsync("a known cached answer means preRank never searches", async () => {
      const choice = await preRank(target, {
        db: prisma,
        _searchFn: () => {
          throw new Error("preRank searched when it already had an answer");
        },
      });
      assert.ok(choice);
      assert.equal(choice.candidate?.title, `${SHOW} S01E04 720p`);
    });

    // ── Determined vs undetermined ─────────────────────────────────────
    clearPreRankMemo();
    const emptyShow = `Zzqx Empty ${randomUUID().replace(/[^a-z]/g, "").slice(0, 8) || "nothing"}`;
    const emptyTarget: PreRankTarget = {
      title: emptyShow,
      mediaType: "tv",
      season: 3,
      episode: 9,
    };
    const emptyQuery = episodeSearchQuery(emptyShow, 3, 9);
    const emptyKey = cacheKeyFrom({ q: emptyQuery.toLowerCase(), probe: randomUUID() });
    writtenKeys.push(emptyKey);
    await setSearchCache(emptyKey, response(emptyQuery, []));

    await checkAsync(
      "'we looked and found nothing' is not the same as 'we never looked'",
      async () => {
        const determined = await getPreRanked(emptyTarget, { db: prisma });
        assert.ok(determined, "an empty cached pool is still an answer");
        assert.equal(determined.candidate, null);
        assert.equal(determined.resultCount, 0);

        const unknown = await getPreRanked(
          { title: `Zzqx Never Searched ${randomUUID()}`, mediaType: "tv", season: 1, episode: 1 },
          { db: prisma },
        );
        assert.equal(unknown, null, "an unsearched title must return null, not an empty answer");
      },
    );

    // ── Failure is quiet ───────────────────────────────────────────────
    clearPreRankMemo();
    await checkAsync("being throttled yields null, never an error", async () => {
      const choice = await preRank(
        { title: `Zzqx Throttled ${randomUUID()}`, mediaType: "tv", season: 1, episode: 1 },
        {
          db: prisma,
          _searchFn: () => Promise.reject(new SearchThrottledError(42)),
        },
      );
      assert.equal(choice, null);
    });

    await checkAsync("a search that blows up yields null, never an error", async () => {
      const choice = await preRank(
        { title: `Zzqx Broken ${randomUUID()}`, mediaType: "tv", season: 1, episode: 1 },
        { db: prisma, _searchFn: () => Promise.reject(new Error("indexer on fire")) },
      );
      assert.equal(choice, null);
    });

    // ── THE FAST PATH, through the real aggregator ─────────────────────
    // Seed the real cache under the key the *producer* would write, then run
    // the real `searchTorrents` with the option set a pre-warm grab uses. A
    // `cached: true` here means a grab after a pre-rank reaches no indexer.
    const fastShow = `Zzqx Fastpath ${randomUUID().replace(/[^a-z]/g, "").slice(0, 8) || "fastpath"}`;
    const fastTarget: PreRankTarget = {
      title: fastShow,
      mediaType: "tv",
      season: 4,
      episode: 11,
    };
    const fastOptions = prewarmSearchOptions(fastTarget);
    const fastPayload = searchPayloadFor(fastOptions);
    const fastKey = cacheKeyFrom({
      q: fastPayload.query.toLowerCase(),
      category: fastPayload.category ?? "all",
      limit: fastPayload.limit ?? "default",
      sources: fastPayload.sources?.slice().sort() ?? "default",
      filters: fastPayload.filters ?? {},
      target: await getTargetResolution(),
    });
    writtenKeys.push(fastKey);
    const fastRelease = result({ title: `${fastShow} S04E11 1080p WEB-DL`, seeders: 210 });
    await setSearchCache(fastKey, response(fastPayload.query, [fastRelease]));

    await checkAsync(
      "the real aggregator serves a pre-warm's own option set from cache",
      async () => {
        const res = await searchTorrents(fastPayload);
        assert.equal(
          res.cached,
          true,
          "the grab paid for a fresh indexer fan-out — the fast path is not fast",
        );
        assert.equal(res.results.length, 1);
        assert.equal(
          selectBestRelease(res.results, fastTarget)?.title,
          fastRelease.title,
          "the grab must select exactly what pre-ranking chose",
        );
      },
    );
  } finally {
    if (writtenKeys.length) {
      await prisma.searchCache.deleteMany({ where: { cacheKey: { in: writtenKeys } } });
    }
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? "\nPASS — pre-ranking reuses the real cache seam"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

void main();
