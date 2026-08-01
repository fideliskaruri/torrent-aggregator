/**
 * On-demand fallback-ladder tests (the "Try again fails every time" defect).
 *
 * The reported bug: pressing "Try again" for Family Guy S01E02 ran ONE search
 * shape ("Family Guy S01E02", minSeeders:1) and gave up on an empty result set.
 * A perfectly seedable SEASON PACK that contains E02 was never surfaced, because
 * an episode-shaped query hides packs (EZTV drops them; free-text indexers never
 * substring-match a pack title). These tests exercise `grabSingleEpisode`
 * through its injected search/send/prisma seams — no real DB, no real network.
 *
 * The load-bearing test is `pack rescues E02`: a result set with a pack but no
 * single E02 must now produce a successful grab. It is RED with only the first
 * rung and GREEN with the full ladder.
 *
 * Run: npx tsx src/lib/library/ondemand-ladder.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { grabSingleEpisode } from "./ondemand";
import type { TorrentResult, SearchResponse } from "@/lib/torrents/types";
import type {
  AddTorrentResult,
  ClientConnectionConfig,
} from "@/lib/clients/types";

/** The exact status the acceptance probe recorded on the pre-fix build. */
const RED_STATUS = "No seeded torrent for S01E02";

let failures = 0;
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

type GrabOpts = Parameters<typeof grabSingleEpisode>[0];
type SearchFn = NonNullable<GrabOpts["_searchFn"]>;
type SendFn = NonNullable<GrabOpts["_sendFn"]>;

// getFreeSpace() mkdir's this and getDirectorySizeBytesAsync() walks it (empty →
// 0 bytes), so the storage budget passes cheaply without touching real media.
const SCRATCH = path.join(
  process.cwd(),
  "node_modules",
  ".cache",
  "ondemand-ladder-scratch",
);

// ── Fixtures ────────────────────────────────────────────────────────────────

function hex40(seed: string): string {
  let s = "";
  for (let i = 0; i < 40; i += 1) {
    s += "0123456789abcdef"[(seed.charCodeAt(i % seed.length) + i * 7) % 16];
  }
  return s;
}

/** A seeded single episode of Family Guy S01E02. */
function single(n = 1, seeders = 30): TorrentResult {
  return {
    id: `single-${n}`,
    title: `Family Guy S01E02 I Never Met the Dead Man v${n} 1080p WEB-DL`,
    magnet: `magnet:?xt=urn:btih:${hex40(`single-${n}`)}&dn=fg`,
    infoHash: hex40(`single-${n}`),
    sizeBytes: 500_000_000,
    seeders,
    leechers: 2,
    source: "torrentscsv",
    sourceUrl: "https://example.com",
    tags: ["1080p", "WEB-DL"],
  };
}

/** A seeded Season 1 pack that COVERS E02 (what the season query surfaces). */
function pack(): TorrentResult {
  return {
    id: "pack-1",
    title: "Family Guy Season 1 COMPLETE 1080p WEB-DL",
    magnet: `magnet:?xt=urn:btih:${hex40("pack-1")}&dn=fgpack`,
    infoHash: hex40("pack-1"),
    sizeBytes: 3_000_000_000,
    seeders: 40,
    leechers: 5,
    source: "torrentscsv",
    sourceUrl: "https://example.com",
    tags: ["1080p", "WEB-DL"],
  };
}

function resp(results: TorrentResult[]): SearchResponse {
  return {
    query: "test",
    results,
    groups: [],
    tookMs: 1,
    sources: [],
    totalCount: results.length,
    page: 1,
    pageSize: Math.max(1, results.length),
    totalPages: results.length ? 1 : 0,
  };
}

function fakeConfig(): ClientConnectionConfig {
  // Non-builtin on purpose: applySendRetention() early-returns for non-builtin
  // clients, so a successful grab never reaches into real Prisma.
  return {
    clientType: "qbittorrent",
    savePath: SCRATCH,
    baseDownloadPath: SCRATCH,
    maxStorageBytes: 100 * 1024 * 1024 * 1024,
  } as ClientConnectionConfig;
}

/** An episode-shaped query — "...S01E02" or "...1x02" — the kind that hides packs. */
function isEpisodeQuery(q: string): boolean {
  return /\bS\d{1,2}E\d{1,3}\b/i.test(q) || /\b\d{1,2}x\d{1,3}\b/i.test(q);
}

// ── Instrumented search seam ──────────────────────────────────────────────────

type SearchCall = { query: string; minSeeders: number | undefined };

function makeSearchFn(route: (query: string) => TorrentResult[]): {
  fn: SearchFn;
  calls: SearchCall[];
} {
  const calls: SearchCall[] = [];
  const fn = (async (options: {
    query: string;
    filters?: { minSeeders?: number };
  }) => {
    calls.push({ query: options.query, minSeeders: options.filters?.minSeeders });
    return resp(route(options.query));
  }) as unknown as SearchFn;
  return { fn, calls };
}

function okSend(): SendFn {
  return (async () =>
    ({ ok: true, message: "Added to qBittorrent" }) as AddTorrentResult) as SendFn;
}

function failSend(message: string): SendFn {
  return (async () => ({ ok: false, message }) as AddTorrentResult) as SendFn;
}

// ── Minimal mock Prisma (records calls + keeps enough state for the tx path) ──

type MockCall = { model: string; op: string; data?: Record<string, unknown> };

function mockPrisma() {
  const calls: MockCall[] = [];
  const store: Record<string, Array<Record<string, unknown>>> = {
    grabJob: [],
    downloadHistory: [],
  };
  let seq = 0;
  let lock: Promise<unknown> = Promise.resolve();

  const handler = {
    get(_t: Record<string, unknown>, model: string): unknown {
      if (model === "$transaction") {
        return async (fn: (tx: unknown) => Promise<void>) => {
          const run = lock.then(() => fn(new Proxy({}, handler)));
          lock = run.catch(() => undefined);
          return run;
        };
      }
      return new Proxy(
        {},
        {
          get(_t2: Record<string, unknown>, op: string) {
            return async (args: { where?: Record<string, unknown>; data?: Record<string, unknown> }) => {
              calls.push({ model, op, data: args?.data });
              if (!store[model]) store[model] = [];
              const rows = store[model];
              if (op === "create") {
                const row = { id: `${model}-${(seq += 1)}`, createdAt: new Date(), ...(args?.data ?? {}) };
                rows.push(row);
                return row;
              }
              if (op === "findFirst" || op === "findUnique") return null;
              if (op === "findMany") return [];
              if (op === "update") return {};
              return {};
            };
          },
        },
      );
    },
  };
  return { proxy: new Proxy({}, handler) as unknown as GrabOpts["_prisma"], calls };
}

function countCreate(calls: MockCall[], model: string, status?: string): number {
  return calls.filter(
    (c) => c.model === model && c.op === "create" && (status ? c.data?.status === status : true),
  ).length;
}

// ── Runner ────────────────────────────────────────────────────────────────

/** Drive the ladder over `rungCount` rungs (2nd arg lets the RED run use only 1). */
async function grab(
  searchFn: SearchFn,
  sendFn: SendFn,
  prisma: GrabOpts["_prisma"],
) {
  return grabSingleEpisode({
    userId: "user-1",
    showTitle: "Family Guy",
    mediaType: "tv",
    season: 1,
    episode: 2,
    _config: fakeConfig(),
    _searchFn: searchFn,
    _sendFn: sendFn,
    _prisma: prisma,
  });
}

async function main() {
  console.log("library/ondemand — on-demand fallback ladder");
  fs.mkdirSync(SCRATCH, { recursive: true });

  try {
    // 1. Episode keep intent never turns into an implicit season download.
    await checkAsync("a season pack never substitutes for an episode keep", async () => {
      const search = makeSearchFn((q) => (isEpisodeQuery(q) ? [] : [pack()]));
      const { proxy, calls } = mockPrisma();
      const res = await grab(search.fn, okSend(), proxy);

      assert.equal(res.ok, false);
      assert.equal(res.noReleaseFound?.reason, "no_release");
      assert.equal(countCreate(calls, "grabJob", "sent"), 0);
      assert.equal(countCreate(calls, "downloadHistory"), 0);
      assert.equal(countCreate(calls, "grabJob", "skipped"), 1);
      assert.notEqual(res.message, RED_STATUS, "must not repeat the byte-identical RED message");
    });

    // 2. Stop at the first working rung — no wasted searches.
    await checkAsync("stops at rung 1 when an exact E02 is seeded", async () => {
      const search = makeSearchFn((q) => (isEpisodeQuery(q) ? [single(1, 80)] : []));
      const { proxy, calls } = mockPrisma();
      const res = await grab(search.fn, okSend(), proxy);

      assert.equal(res.ok, true);
      assert.equal(search.calls.length, 1, "only rung 1 should have been searched");
      assert.doesNotMatch(res.message, /season pack|low-seed/, "rung 1 needs no honesty suffix");
      assert.equal(countCreate(calls, "grabJob", "sent"), 1);
    });

    // 3. Every unique viable exact episode is attempted once; pool size is not
    //    an attempt cap.
    await checkAsync("all unique exact candidates are attempted until exhaustion", async () => {
      const many = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => single(n, 40 + n));
      const search = makeSearchFn((q) => (isEpisodeQuery(q) ? many : []));
      const { proxy, calls } = mockPrisma();
      const res = await grab(search.fn, failSend("qBittorrent rejected the add"), proxy);

      assert.equal(res.ok, false);
      assert.equal(res.noReleaseFound?.reason, "send_failed");
      assert.equal(countCreate(calls, "grabJob", "failed"), 8, "all 8 unique candidates attempted");
      assert.ok(search.calls.length >= 2, "at least two rungs searched before cap");
      assert.equal(countCreate(calls, "grabJob", "skipped"), 0, "attempts happened → no synth skip row");
    });

    // 4. GrabJob-noise (no-release case): a totally empty ladder must write
    //    EXACTLY ONE synthesized skip row — not one per rung — and be honest.
    await checkAsync("exhausted ladder writes exactly one honest skip row", async () => {
      const search = makeSearchFn(() => []); // nothing, anywhere
      const { proxy, calls } = mockPrisma();
      const res = await grab(search.fn, okSend(), proxy);

      assert.equal(res.ok, false);
      assert.equal(res.noReleaseFound?.reason, "no_release");
      assert.equal(res.noReleaseFound?.triedSeasonPacks, false);
      assert.ok(
        (res.noReleaseFound?.searches ?? 0) >= 4,
        "ladder exhausts multiple distinct searches",
      );
      assert.equal(res.noReleaseFound?.manualSearchQuery, "Family Guy S01E02");
      assert.doesNotMatch(res.message, /season packs/i);
      assert.doesNotMatch(res.message, /Search manually/i, "no useless manual-search CTA");
      // Even exhausted, the outcome is *materially different* from the RED: a
      // message that names what was tried, never the flat byte-identical string.
      assert.notEqual(res.message, RED_STATUS, "exhausted message must differ from the RED");
      assert.equal(countCreate(calls, "grabJob", "skipped"), 1, "one skip row total");
      assert.equal(countCreate(calls, "downloadHistory"), 0, "no history writes");
      assert.equal(countCreate(calls, "grabJob", "sent"), 0);
      assert.equal(countCreate(calls, "grabJob", "failed"), 0);
    });

    // 5b. Anime: formal catalog title finds nothing; short alias + absolute ep does.
    await checkAsync("anime alias ladder finds absolute-numbered release", async () => {
      const animeSingle = (): TorrentResult => ({
        id: "rezero-01",
        title: "[SubsPlease] Re Zero - 01 (1080p) [ABCDEF01]",
        magnet: `magnet:?xt=urn:btih:${hex40("rezero-01")}&dn=rz`,
        infoHash: hex40("rezero-01"),
        sizeBytes: 400_000_000,
        seeders: 80,
        leechers: 3,
        source: "nyaa",
        sourceUrl: "https://example.com",
        tags: ["1080p"],
      });
      const search = makeSearchFn((q) => {
        // Formal TMDB string → empty (the live bug).
        if (/Starting Life in Another World/i.test(q)) return [];
        // Short alias absolute or S01E01 → hit.
        if (/re\s*zero/i.test(q) && (/-?\s*01/i.test(q) || /S01E01/i.test(q))) {
          return [animeSingle()];
        }
        return [];
      });
      const { proxy, calls } = mockPrisma();
      const res = await grabSingleEpisode({
        userId: "user-1",
        showTitle: "Re:ZERO -Starting Life in Another World-",
        mediaType: "tv", // TMDB mislabels anime as tv — ladder must still try anime
        season: 1,
        episode: 1,
        _config: fakeConfig(),
        _searchFn: search.fn,
        _sendFn: okSend(),
        _prisma: proxy,
      });
      assert.equal(res.ok, true, `expected success, got: ${res.message}`);
      assert.match(res.title ?? "", /Re Zero - 01/i);
      assert.equal(countCreate(calls, "grabJob", "sent"), 1);
      assert.ok(search.calls.length >= 2, "must try more than the formal title alone");
    });

    // 5c. The strict version of 5b: the ONLY seeded release is dash-numbered.
    // Every SxxEyy / 1x01 / pack shape returns nothing, so the grab succeeds
    // only if an absolute rung is actually REACHED inside the search budget.
    // RED before the rungs were reordered: the alias×category cross-product
    // spent all 8 searches on SxxEyy shapes and never asked for "Show - 01".
    await checkAsync("absolute-only anime is reached within the search budget", async () => {
      const dashOnly = (): TorrentResult => ({
        id: "abs-01",
        title: "[SubsPlease] Re Zero - 01 (1080p) [ABCDEF01]",
        magnet: `magnet:?xt=urn:btih:${hex40("abs-01")}&dn=rz`,
        infoHash: hex40("abs-01"),
        sizeBytes: 400_000_000,
        seeders: 80,
        leechers: 3,
        source: "nyaa",
        sourceUrl: "https://example.com",
        tags: ["1080p"],
      });
      // Dash form only: "Show - 01". Anything carrying SxxEyy is not it.
      const isAbsoluteQuery = (q: string) =>
        /\s-\s*0?1\s*$/.test(q) && !/s\d{1,2}e\d{1,2}/i.test(q);
      const search = makeSearchFn((q) => (isAbsoluteQuery(q) ? [dashOnly()] : []));
      const { proxy, calls } = mockPrisma();
      const res = await grabSingleEpisode({
        userId: "user-1",
        showTitle: "Re:ZERO -Starting Life in Another World-",
        mediaType: "tv",
        season: 1,
        episode: 1,
        _config: fakeConfig(),
        _searchFn: search.fn,
        _sendFn: okSend(),
        _prisma: proxy,
      });
      assert.equal(
        res.ok,
        true,
        `absolute rung never reached; queries tried: ${search.calls.map((c) => c.query).join(" | ")}`,
      );
      assert.match(res.title ?? "", /Re Zero - 01/i);
      assert.equal(countCreate(calls, "grabJob", "sent"), 1);
    });

    // 5d. The fast path for ordinary TV must not pay for the anime rescues:
    // a formal-title episode query still resolves on the very first search.
    await checkAsync("ordinary TV still resolves on the first search", async () => {
      const search = makeSearchFn((q) =>
        /^Family Guy S01E02$/i.test(q.trim()) ? [single(1, 90)] : [],
      );
      const { proxy } = mockPrisma();
      const res = await grab(search.fn, okSend(), proxy);
      assert.equal(res.ok, true, `expected success, got: ${res.message}`);
      assert.equal(search.calls.length, 1, "no extra rungs once rung 1 succeeds");
    });

    await checkAsync("preferred resolution ranks exact affinity then deterministic fallback", async () => {
      const at = (resolution: number, n: number) => ({
        ...single(n, 40),
        title: `Family Guy S01E02 I Never Met the Dead Man ${resolution}p WEB-DL`,
        tags: [`${resolution}p`, "WEB-DL"],
      });

      const exactSearch = makeSearchFn((q) =>
        isEpisodeQuery(q) ? [at(2160, 1), at(1080, 2), at(720, 3)] : [],
      );
      const exactDb = mockPrisma();
      const exact = await grabSingleEpisode({
        userId: "user-1",
        showTitle: "Family Guy",
        mediaType: "tv",
        season: 1,
        episode: 2,
        preferredResolution: 720,
        _config: fakeConfig(),
        _searchFn: exactSearch.fn,
        _sendFn: okSend(),
        _prisma: exactDb.proxy,
      });
      assert.match(exact.title ?? "", /720p/, "exact 720p affinity must win");

      const fallbackSearch = makeSearchFn((q) =>
        isEpisodeQuery(q) ? [at(2160, 4), at(720, 5)] : [],
      );
      const fallbackDb = mockPrisma();
      const fallback = await grabSingleEpisode({
        userId: "user-1",
        showTitle: "Family Guy",
        mediaType: "tv",
        season: 1,
        episode: 2,
        preferredResolution: 1080,
        _config: fakeConfig(),
        _searchFn: fallbackSearch.fn,
        _sendFn: okSend(),
        _prisma: fallbackDb.proxy,
      });
      assert.match(fallback.title ?? "", /720p/, "720p must beat oversized 2160p fallback");
    });

    // 5. Offline is environmental — stop immediately, don't burn more rungs.
    await checkAsync("stops immediately when the client is offline", async () => {
      const search = makeSearchFn((q) => (isEpisodeQuery(q) ? [single(1, 90)] : []));
      const { proxy, calls } = mockPrisma();
      const res = await grab(search.fn, failSend("connect ECONNREFUSED 127.0.0.1:8080"), proxy);

      assert.equal(res.ok, false);
      assert.equal(res.noReleaseFound?.reason, "client_offline");
      assert.equal(search.calls.length, 1, "no further rungs after an offline client");
      assert.equal(countCreate(calls, "grabJob", "failed"), 1, "one attempt, then stop");
    });
  } finally {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("  all passed");
}

main().then(
  () => undefined,
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
