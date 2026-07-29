/**
 * Shared grab pipeline tests.
 *
 * Exercises the pipeline contract through its typed hooks, covering:
 * - viable release found and grabbed (cursor advances)
 * - no results at all (miss recorded)
 * - 0-seeder releases inside the 6h window (deferred, NOT a miss)
 * - past the 6h seederWaitSince window (escape hatch fires)
 * - only 720p when target is 1080p (invariant 1: must still grab)
 * - season pack vs individual episodes
 * - duplicate/already-grabbed release (no double send)
 * - client send failure (cursor must NOT advance)
 * - anime naming with [SubsPlease] prefixes and absolute numbering
 *
 * Run: npx tsx src/lib/grab/pipeline.test.ts
 */
import assert from "node:assert/strict";
import { runGrabPipeline, normalizeInfoHash, GRAB_DEDUP_WINDOW_MS } from "./pipeline";
import type {
  GrabPipelineOptions,
  ViabilityDecision,
} from "./types";
import type { TorrentResult, SearchResponse } from "@/lib/torrents/types";
import type { ClientConnectionConfig } from "@/lib/clients/types";

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

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function fakeResult(overrides: Partial<TorrentResult> = {}): TorrentResult {
  return {
    id: "test-1",
    title: "Family Guy S09E01 1080p WEB-DL",
    magnet: "magnet:?xt=urn:btih:abc123&dn=FamilyGuy",
    infoHash: "abc123",
    sizeBytes: 500_000_000,
    seeders: 50,
    leechers: 10,
    source: "torrentscsv",
    sourceUrl: "https://example.com",
    tags: ["1080p", "WEB-DL"],
    ...overrides,
  };
}

function fakeSearchResponse(
  results: TorrentResult[],
): SearchResponse {
  return {
    query: "test",
    results,
    tookMs: 100,
    totalCount: results.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    sources: [{ id: "torrentscsv", count: results.length }],
  };
}

function fakeConfig(overrides: Partial<ClientConnectionConfig> = {}): ClientConnectionConfig {
  return {
    clientType: "builtin",
    savePath: "/downloads",
    ...overrides,
  } as ClientConnectionConfig;
}

// Minimal mock Prisma that records calls and keeps enough in-memory state for
// the idempotency guard to be exercised for real. A mock whose `findFirst`
// returns a truthy `{}` would report *every* grab as a duplicate, so the
// store below actually filters on the guard's where-clause.
type MockCall = { model: string; op: string; data?: Record<string, unknown> };
type MockRow = Record<string, unknown> & { id: string; createdAt: Date };

type FindArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  orderBy?: unknown;
  select?: unknown;
};

function matchesWhere(row: MockRow, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (want && typeof want === "object" && !(want instanceof Date)) {
      const range = want as { gte?: Date; lt?: Date; not?: unknown };
      if (range.gte instanceof Date && !((have as Date) >= range.gte)) return false;
      if (range.lt instanceof Date && !((have as Date) < range.lt)) return false;
      if ("not" in range && have === range.not) return false;
      return true;
    }
    return have === want;
  });
}

function mockPrisma(seed: { grabJob?: Partial<MockRow>[] } = {}) {
  const calls: MockCall[] = [];
  const store: Record<string, MockRow[]> = { grabJob: [], downloadHistory: [] };
  let seq = 0;

  // An interactive transaction holds the database's write lock, so two of
  // them do not interleave. Modelling that is the whole point of the
  // concurrency test: without it the mock would let both racers write and
  // would "prove" a race the database does not actually permit.
  let lock: Promise<unknown> = Promise.resolve();

  for (const row of seed.grabJob ?? []) {
    store.grabJob.push({
      id: `seed-${(seq += 1)}`,
      createdAt: new Date(),
      ...row,
    } as MockRow);
  }

  const handler = {
    get(_target: Record<string, unknown>, model: string) {
      if (model === "$transaction") {
        // Interactive transaction: call the callback with the same mock proxy
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
            return async (args: FindArgs) => {
              calls.push({ model, op, data: args?.data as Record<string, unknown> });
              if (!store[model]) store[model] = [];
              const rows = store[model];

              if (op === "create") {
                const row = {
                  id: `${model}-${(seq += 1)}`,
                  createdAt: new Date(),
                  ...(args?.data ?? {}),
                } as MockRow;
                rows.push(row);
                return row;
              }
              if (op === "findFirst" || op === "findUnique") {
                const hits = rows
                  .filter((r) => matchesWhere(r, args?.where))
                  .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
                return hits[0] ?? null;
              }
              if (op === "findMany") {
                return rows.filter((r) => matchesWhere(r, args?.where));
              }
              if (op === "update") {
                const row = rows.find((r) => matchesWhere(r, args?.where));
                if (row) Object.assign(row, args?.data ?? {});
                return row ?? {};
              }
              return {};
            };
          },
        },
      );
    },
  };
  const proxy = new Proxy({}, handler);
  return { proxy, calls, store };
}

function mockPrismaWithTransactionalRollback() {
  const calls: MockCall[] = [];

  const modelProxy = (sink: MockCall[]) =>
    new Proxy(
      {},
      {
        get(_target: Record<string, unknown>, model: string) {
          return new Proxy(
            {},
            {
              get(_t2: Record<string, unknown>, op: string) {
                return async (args: FindArgs) => {
                  sink.push({ model, op, data: args?.data as Record<string, unknown> });

                  // These rollback tests are about the transaction boundary,
                  // not the idempotency branch. A Prisma read with no matching
                  // row returns null/[]; returning a generic object here makes
                  // the guard believe every hash is already active and skips
                  // the hook whose failure is supposed to abort the commit.
                  if (op === "findFirst" || op === "findUnique") return null;
                  if (op === "findMany") return [];
                  if (op === "create") {
                    return {
                      id: `${model}-${sink.length}`,
                      createdAt: new Date(),
                      ...(args?.data ?? {}),
                    };
                  }
                  return {};
                };
              },
            },
          );
        },
      },
    );

  const rootHandler = {
    get(_target: Record<string, unknown>, model: string) {
      if (model === "$transaction") {
        return async (fn: (tx: unknown) => Promise<void>) => {
          const txCalls: MockCall[] = [];
          await fn(modelProxy(txCalls));
          calls.push(...txCalls);
        };
      }
      return (modelProxy(calls) as Record<string, unknown>)[model];
    },
  };

  const proxy = new Proxy({}, rootHandler);
  return { proxy, calls };
}

function baseOpts(overrides: Partial<GrabPipelineOptions> = {}): GrabPipelineOptions {
  const { proxy } = mockPrisma();
  return {
    userId: "user-1",
    purpose: "keep",
    search: {
      query: "Family Guy S09E01",
      category: "tv",
      limit: 15,
      enrich: false,
      background: true,
      skipCache: true,
      filters: { hasMagnet: true },
    },
    config: fakeConfig(),
    fallbackTitle: "Family Guy",
    grabJobKind: "library",
    externalId: "item-1",
    selectCandidate: (results) => results.find((r) => r.magnet) ?? null,
    resolveTarget: () => ({ category: "TV", savePath: "/downloads/TV/Family Guy/Season 09" }),
    _searchFn: async () => fakeSearchResponse([fakeResult()]),
    _sendFn: async () => ({ ok: true, message: "Added" }),
    _prisma: proxy as unknown as GrabPipelineOptions["_prisma"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log("grab/pipeline — shared pipeline contract");

  // ── 1. Viable release found and grabbed ─────────────────────────────────

  const grabCases = [
    {
      name: "grabs Family Guy S09E01 (standard TV)",
      result: fakeResult({ title: "Family Guy S09E01 1080p WEB-DL", seeders: 50 }),
    },
    {
      name: "grabs The Simpsons S35E10 (long-running TV)",
      result: fakeResult({ title: "The Simpsons S35E10 720p HDTV", seeders: 120 }),
    },
    {
      name: "grabs Breaking Bad S05E16 (drama)",
      result: fakeResult({ title: "Breaking Bad S05E16 1080p BluRay", seeders: 300 }),
    },
    {
      name: "grabs [SubsPlease] Frieren - 28 (anime absolute ep)",
      result: fakeResult({
        title: "[SubsPlease] Sousou no Frieren - 28 (1080p) [A1B2C3D4].mkv",
        source: "nyaa",
        seeders: 200,
      }),
    },
    {
      name: "grabs [Erai-raws] Solo Leveling S02E03 (anime Sxx naming)",
      result: fakeResult({
        title: "[Erai-raws] Solo Leveling - S02E03 [1080p][Multiple Subtitle]",
        source: "nyaa",
        seeders: 80,
      }),
    },
    {
      name: "grabs site-prefix junk title (www.SceneTime.com)",
      result: fakeResult({
        title: "www.SceneTime.com - The Bear S03E02 1080p HEVC",
        seeders: 15,
      }),
    },
  ];

  for (const tc of grabCases) {
    await checkAsync(tc.name, async () => {
      let successCalled = false;
      const r = await runGrabPipeline(
        baseOpts({
          _searchFn: async () => fakeSearchResponse([tc.result]),
          onSuccess: async () => { successCalled = true; },
        }),
      );
      assert.equal(r.status, "sent");
      assert.equal(r.offline, false);
      assert.ok(successCalled, "onSuccess must be called");
    });
  }

  // ── 2. No results at all (miss recorded) ────────────────────────────────

  await checkAsync("no results → skip + onNoCandidate('no_results')", async () => {
    let noReason: string | undefined;
    const r = await runGrabPipeline(
      baseOpts({
        _searchFn: async () => fakeSearchResponse([]),
        onNoCandidate: async (reason) => { noReason = reason; },
      }),
    );
    assert.equal(r.status, "skipped");
    assert.equal(noReason, "no_results");
  });

  // ── 3. 0-seeder inside 6h window (deferred, NOT a miss) ────────────────

  await checkAsync("0-seeder within grace window → deferred, not a miss", async () => {
    let noReason: string | undefined;
    const zeroSeeder = fakeResult({ seeders: 0 });
    const r = await runGrabPipeline(
      baseOpts({
        _searchFn: async () => fakeSearchResponse([zeroSeeder]),
        checkViability: async (): Promise<ViabilityDecision> => ({
          proceed: false,
          deferred: true,
          message: "Waiting for seeders (0 of 3)",
        }),
        onNoCandidate: async (reason) => { noReason = reason; },
      }),
    );
    assert.equal(r.status, "skipped");
    assert.equal(noReason, "deferred", "must be 'deferred', never 'no_results'");
  });

  // ── 4. 0-seeder past 6h window (escape hatch fires) ────────────────────

  await checkAsync("0-seeder past 6h grace → escape hatch grabs anyway", async () => {
    let successCalled = false;
    const thinRelease = fakeResult({ seeders: 1 });
    const r = await runGrabPipeline(
      baseOpts({
        _searchFn: async () => fakeSearchResponse([thinRelease]),
        // Viability says proceed: escape hatch elapsed
        checkViability: async (): Promise<ViabilityDecision> => ({
          proceed: true,
        }),
        onSuccess: async () => { successCalled = true; },
      }),
    );
    assert.equal(r.status, "sent");
    assert.ok(successCalled);
  });

  // ── 5. Only 720p when target is 1080p — MUST still grab (invariant 1) ──

  const resolutionCases = [
    { name: "720p release when 1080p target", title: "Breaking Bad S01E01 720p HDTV", seeders: 40 },
    { name: "480p release when 1080p target", title: "The Simpsons S10E05 480p WEBRip", seeders: 20 },
    { name: "unknown resolution anime release", title: "[Erai-raws] Frieren - 05 [Multiple Subtitle].mkv", seeders: 100 },
  ];

  for (const tc of resolutionCases) {
    await checkAsync(`invariant 1: ${tc.name} is never rejected`, async () => {
      const result = fakeResult({ title: tc.title, seeders: tc.seeders });
      const r = await runGrabPipeline(
        baseOpts({
          _searchFn: async () => fakeSearchResponse([result]),
          // No viability gate or filters that would reject on resolution.
          // The pipeline itself never rejects on resolution — that is invariant 1.
        }),
      );
      assert.equal(r.status, "sent", `${tc.title} must not be rejected`);
    });
  }

  // ── 6. Season pack vs individual episodes ───────────────────────────────

  await checkAsync("season pack is selectable by caller hook", async () => {
    const pack = fakeResult({
      title: "Breaking Bad Season 5 Complete 1080p BluRay",
      seeders: 200,
      episode: {
        season: 5,
        label: "S05",
        isBatch: false,
        isSeasonPack: true,
      },
    });
    const individual = fakeResult({
      title: "Breaking Bad S05E01 1080p BluRay",
      seeders: 50,
      episode: {
        season: 5,
        episode: 1,
        label: "S05E01",
        isBatch: false,
        isSeasonPack: false,
      },
    });

    // Caller prefers season packs
    const r1 = await runGrabPipeline(
      baseOpts({
        _searchFn: async () => fakeSearchResponse([pack, individual]),
        selectCandidate: (results) =>
          results.find((r) => r.episode?.isSeasonPack && r.magnet) ?? null,
      }),
    );
    assert.equal(r1.status, "sent");
    assert.equal(r1.candidate?.title, pack.title);

    // Caller prefers individual episodes
    const r2 = await runGrabPipeline(
      baseOpts({
        _searchFn: async () => fakeSearchResponse([pack, individual]),
        selectCandidate: (results) =>
          results.find((r) => !r.episode?.isSeasonPack && r.magnet) ?? null,
      }),
    );
    assert.equal(r2.status, "sent");
    assert.equal(r2.candidate?.title, individual.title);
  });

  // multi-season pack
  await checkAsync("multi-season pack (S01-S05) is selectable", async () => {
    const multiPack = fakeResult({
      title: "One Piece S01-S05 Complete 1080p WEB-DL",
      seeders: 10,
      episode: {
        season: 1,
        label: "S01-S05",
        isBatch: false,
        isSeasonPack: true,
        isMultiSeason: true,
      },
    });
    const r = await runGrabPipeline(
      baseOpts({
        _searchFn: async () => fakeSearchResponse([multiPack]),
        selectCandidate: (results) => results.find((r) => r.magnet) ?? null,
      }),
    );
    assert.equal(r.status, "sent");
    assert.equal(r.candidate?.episode?.isMultiSeason, true);
  });

  // ── 7. Duplicate/already-grabbed release (no double send) ───────────────

  await checkAsync("duplicate detected → skip, send never called", async () => {
    let sendCalled = false;
    const r = await runGrabPipeline(
      baseOpts({
        checkDuplicate: async () => "Already sent this release",
        _sendFn: async () => {
          sendCalled = true;
          return { ok: true, message: "Added" };
        },
        onNoCandidate: async () => {},
      }),
    );
    assert.equal(r.status, "skipped");
    assert.equal(sendCalled, false, "send must NOT be called for a duplicate");
  });

  // ── 8. Client send failure (cursor must NOT advance) ────────────────────

  const failureCases = [
    { name: "builtin engine error", error: new Error("Torrent already exists"), clientType: "builtin" as const },
    { name: "qBittorrent ECONNREFUSED", error: new Error("fetch failed (ECONNREFUSED)"), clientType: "qbittorrent" as const },
    { name: "Transmission timeout", error: new Error("connect timeout to 192.168.1.100:9091"), clientType: "transmission" as const },
  ];

  for (const tc of failureCases) {
    await checkAsync(`client failure (${tc.name}) → onSuccess NOT called`, async () => {
      let successCalled = false;
      let failureCalled = false;
      const r = await runGrabPipeline(
        baseOpts({
          config: fakeConfig({ clientType: tc.clientType }),
          _sendFn: async () => { throw tc.error; },
          onSuccess: async () => { successCalled = true; },
          onFailure: async () => { failureCalled = true; },
        }),
      );
      assert.equal(r.status, "failed");
      assert.equal(successCalled, false, "onSuccess must NOT be called on failure");
      assert.ok(failureCalled, "onFailure must be called");
    });
  }

  // Specific: cursor must not advance on failure
  await checkAsync("send failure → cursor is not advanced (no onSuccess)", async () => {
    let cursorAdvanced = false;
    const r = await runGrabPipeline(
      baseOpts({
        _sendFn: async () => ({ ok: false, message: "Torrent rejected" }),
        onSuccess: async () => { cursorAdvanced = true; },
        onFailure: async () => {},
      }),
    );
    assert.equal(r.status, "failed");
    assert.equal(cursorAdvanced, false, "cursor must NOT advance on send failure");
  });

  // ── 9. Anime naming with [SubsPlease] prefix and absolute numbering ────

  const animeCases = [
    {
      name: "[SubsPlease] Sousou no Frieren - 28",
      title: "[SubsPlease] Sousou no Frieren - 28 (1080p) [A1B2C3D4].mkv",
    },
    {
      name: "[SubsPlease] One Piece - 1105",
      title: "[SubsPlease] One Piece - 1105 (1080p) [DEADBEEF].mkv",
    },
    {
      name: "[Erai-raws] Solo Leveling S02E03 (Sxx naming)",
      title: "[Erai-raws] Solo Leveling - S02E03 [1080p][Multiple Subtitle]",
    },
    {
      name: "[Yameii] Frieren (dub, bracketed fansub group)",
      title: "[Yameii] Frieren - Beyond Journey's End - S01E09 [English Dub] [CR WEB-DL 1080p]",
    },
  ];

  for (const tc of animeCases) {
    await checkAsync(`anime naming: ${tc.name} is grabbable`, async () => {
      const result = fakeResult({
        title: tc.title,
        source: "nyaa",
        seeders: 100,
      });
      const r = await runGrabPipeline(
        baseOpts({
          _searchFn: async () => fakeSearchResponse([result]),
          selectCandidate: (results) => results.find((r) => r.magnet) ?? null,
        }),
      );
      assert.equal(r.status, "sent");
    });
  }

  // ── 10. Storage budget rejection ────────────────────────────────────────

  await checkAsync("storage budget exceeded → failed status", async () => {
    const r = await runGrabPipeline(
      baseOpts({
        checkStorageBudget: async () => ({
          ok: false as const,
          message: "Storage budget exceeded (100GB / 100GB used)",
        }),
      }),
    );
    assert.equal(r.status, "failed");
    assert.ok(r.message.includes("Storage budget"));
  });

  // ── 11. GrabJob + DownloadHistory written atomically ────────────────────

  await checkAsync("send success writes GrabJob + DownloadHistory in transaction", async () => {
    const { proxy, calls } = mockPrisma();
    await runGrabPipeline(
      baseOpts({
        _prisma: proxy as unknown as GrabPipelineOptions["_prisma"],
      }),
    );
    const grabJobs = calls.filter((c) => c.model === "grabJob" && c.op === "create");
    const histories = calls.filter((c) => c.model === "downloadHistory" && c.op === "create");
    assert.ok(grabJobs.length >= 1, "must write at least one GrabJob");
    assert.ok(histories.length >= 1, "must write at least one DownloadHistory");
  });

  await checkAsync("send failure still writes GrabJob + DownloadHistory", async () => {
    const { proxy, calls } = mockPrisma();
    await runGrabPipeline(
      baseOpts({
        _prisma: proxy as unknown as GrabPipelineOptions["_prisma"],
        _sendFn: async () => ({ ok: false, message: "Rejected" }),
      }),
    );
    const grabJobs = calls.filter((c) => c.model === "grabJob" && c.op === "create");
    const histories = calls.filter((c) => c.model === "downloadHistory" && c.op === "create");
    assert.ok(grabJobs.length >= 1, "must write GrabJob even on failure");
    assert.ok(histories.length >= 1, "must write DownloadHistory even on failure");
  });

  // ── 12. Offline detection for external clients ──────────────────────────

  await checkAsync("ECONNREFUSED on qBittorrent sets offline flag", async () => {
    const r = await runGrabPipeline(
      baseOpts({
        config: fakeConfig({ clientType: "qbittorrent" }),
        _sendFn: async () => { throw new Error("fetch failed (ECONNREFUSED)"); },
      }),
    );
    assert.equal(r.offline, true);
  });

  await checkAsync("builtin engine error does NOT set offline flag", async () => {
    const r = await runGrabPipeline(
      baseOpts({
        config: fakeConfig({ clientType: "builtin" }),
        _sendFn: async () => { throw new Error("Torrent already exists"); },
      }),
    );
    assert.equal(r.offline, false, "builtin never goes offline via host:port");
  });

  // ── 13. Pipeline result exposes candidate and target ────────────────────

  await checkAsync("successful grab exposes candidate and target", async () => {
    const result = fakeResult({ title: "The Simpsons S35E10 1080p" });
    const r = await runGrabPipeline(
      baseOpts({
        _searchFn: async () => fakeSearchResponse([result]),
        resolveTarget: () => ({ category: "TV", savePath: "/downloads/TV/The Simpsons/Season 35" }),
      }),
    );
    assert.equal(r.candidate?.title, "The Simpsons S35E10 1080p");
    assert.equal(r.target?.savePath, "/downloads/TV/The Simpsons/Season 35");
    assert.equal(r.target?.category, "TV");
  });

  // ── 14. Not-viable (non-deferred) goes through onNoCandidate ────────────

  await checkAsync("not-viable (non-deferred) → 'not_viable' reason", async () => {
    let noReason: string | undefined;
    const r = await runGrabPipeline(
      baseOpts({
        checkViability: async (): Promise<ViabilityDecision> => ({
          proceed: false,
          deferred: false,
          message: "Swarm is dead",
        }),
        onNoCandidate: async (reason) => { noReason = reason; },
      }),
    );
    assert.equal(r.status, "skipped");
    assert.equal(noReason, "not_viable");
  });

  // ── 15. noMatchMessage specificity ────────────────────────────────────

  await checkAsync("noMatchMessage customises the skip message", async () => {
    const r = await runGrabPipeline(
      baseOpts({
        _searchFn: async () => fakeSearchResponse([fakeResult({ magnet: undefined })]),
        selectCandidate: () => null,
        noMatchMessage: (count) =>
          count
            ? `No anime releases in ${count} results`
            : "No matching anime torrents",
      }),
    );
    assert.equal(r.status, "skipped");
    assert.equal(r.message, "No anime releases in 1 results");
  });

  await checkAsync("noMatchMessage with 0 results uses the zero-count branch", async () => {
    const r = await runGrabPipeline(
      baseOpts({
        _searchFn: async () => fakeSearchResponse([]),
        selectCandidate: () => null,
        noMatchMessage: (count) =>
          count
            ? `On-demand: no matching S01E05 release in ${count} results`
            : "No seeded torrent for S01E05",
      }),
    );
    assert.equal(r.status, "skipped");
    assert.equal(r.message, "No seeded torrent for S01E05");
  });

  // ── 16. Atomicity: transaction rollback ─────────────────────────────────
  //
  // If onSuccess throws inside the transaction, ALL writes (GrabJob,
  // DownloadHistory, AND the caller's cursor advance) must roll back
  // together — leaving state exactly as before the attempt.

  await checkAsync("onSuccess throw rolls back GrabJob + DownloadHistory + cursor", async () => {
    const { proxy, calls } = mockPrismaWithTransactionalRollback();

    try {
      await runGrabPipeline(
        baseOpts({
          _prisma: proxy as unknown as GrabPipelineOptions["_prisma"],
          onSuccess: async () => {
            throw new Error("Simulated cursor-advance failure");
          },
        }),
      );
      // The pipeline should propagate the transaction error
      assert.fail("pipeline should have thrown");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("Simulated cursor-advance failure"),
        `expected simulated error, got: ${err.message}`,
      );
    }

    // No GrabJob or DownloadHistory should have been committed
    const committed = calls.filter(
      (c) => (c.model === "grabJob" || c.model === "downloadHistory") && c.op === "create",
    );
    assert.equal(committed.length, 0, "rolled-back transaction must not commit GrabJob or DownloadHistory");
  });

  await checkAsync("onFailure throw also rolls back GrabJob + DownloadHistory", async () => {
    const { proxy, calls } = mockPrismaWithTransactionalRollback();

    try {
      await runGrabPipeline(
        baseOpts({
          _prisma: proxy as unknown as GrabPipelineOptions["_prisma"],
          _sendFn: async () => ({ ok: false, message: "Client rejected" }),
          onFailure: async () => {
            throw new Error("Simulated onFailure DB error");
          },
        }),
      );
      assert.fail("pipeline should have thrown");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("Simulated onFailure DB error"));
    }

    const committed = calls.filter(
      (c) => (c.model === "grabJob" || c.model === "downloadHistory") && c.op === "create",
    );
    assert.equal(committed.length, 0, "rolled-back transaction must not commit anything");
  });

  // ── 17. Duplicate-at-cursor: cursor advance on success-by-other-means ──
  //
  // When checkDuplicate detects the cursor episode is already held, the
  // onNoCandidate hook must receive the candidate so the caller can advance.

  await checkAsync("duplicate passes candidate to onNoCandidate", async () => {
    let receivedCandidate: TorrentResult | null = null;
    let receivedReason: string | undefined;
    const held = fakeResult({ title: "Family Guy S09E01 1080p WEB-DL" });
    await runGrabPipeline(
      baseOpts({
        _searchFn: async () => fakeSearchResponse([held]),
        checkDuplicate: async () => "Already in the client",
        onNoCandidate: async (reason, _msg, candidate) => {
          receivedReason = reason;
          receivedCandidate = candidate;
        },
      }),
    );
    assert.equal(receivedReason, "duplicate");
    assert.ok(receivedCandidate, "candidate must be passed to onNoCandidate for duplicates");
    assert.equal((receivedCandidate as TorrentResult).title, held.title);
  });

  // Simulate the automation pattern: cursor at S01E05, duplicate detected,
  // hook advances cursor like a successful grab.
  await checkAsync("duplicate at cursor episode → caller hook can advance cursor", async () => {
    const cursorSeason = 1;
    const cursorEpisode = 5;
    let advancedTo: { season: number; episode: number } | null = null;

    await runGrabPipeline(
      baseOpts({
        _searchFn: async () =>
          fakeSearchResponse([
            fakeResult({ title: "Breaking Bad S01E05 1080p BluRay", seeders: 50 }),
          ]),
        checkDuplicate: async () => "Already in the client",
        onNoCandidate: async (reason, _msg, candidate) => {
          if (reason === "duplicate" && candidate) {
            // Simulate the automation hook: parse episode, compare to cursor
            const ep = candidate.episode ?? { season: undefined, episode: undefined };
            // In real code, parseEpisode(candidate.title) is used. Here we
            // cheat with a direct match to keep the test self-contained.
            if (
              candidate.title.includes(`S${String(cursorSeason).padStart(2, "0")}E${String(cursorEpisode).padStart(2, "0")}`)
            ) {
              advancedTo = { season: cursorSeason, episode: cursorEpisode + 1 };
            }
          }
        },
      }),
    );
    assert.ok(advancedTo, "cursor must advance when duplicate matches cursor episode");
    assert.equal((advancedTo as { season: number; episode: number }).season, 1);
    assert.equal((advancedTo as { season: number; episode: number }).episode, 6);
  });

  await checkAsync("duplicate NOT at cursor episode → cursor unchanged", async () => {
    const cursorSeason = 1;
    const cursorEpisode = 5;
    let advancedTo: { season: number; episode: number } | null = null;

    await runGrabPipeline(
      baseOpts({
        _searchFn: async () =>
          fakeSearchResponse([
            // Episode 3, not the cursor episode 5
            fakeResult({ title: "Breaking Bad S01E03 720p HDTV", seeders: 20 }),
          ]),
        checkDuplicate: async () => "Already in the client",
        onNoCandidate: async (reason, _msg, candidate) => {
          if (reason === "duplicate" && candidate) {
            if (
              candidate.title.includes(`S${String(cursorSeason).padStart(2, "0")}E${String(cursorEpisode).padStart(2, "0")}`)
            ) {
              advancedTo = { season: cursorSeason, episode: cursorEpisode + 1 };
            }
          }
        },
      }),
    );
    assert.equal(advancedTo, null, "cursor must NOT advance when duplicate is off-cursor");
  });

  await checkAsync("duplicate with no hunt cursor → no advance, no crash", async () => {
    let hookCalled = false;
    let advanceCalled = false;

    await runGrabPipeline(
      baseOpts({
        _searchFn: async () =>
          fakeSearchResponse([fakeResult({ title: "The Simpsons S35E10 1080p" })]),
        checkDuplicate: async () => "Already in the client",
        onNoCandidate: async (reason, _msg, candidate) => {
          hookCalled = true;
          // With no cursor, the hook has nothing to advance — just returns.
          // Simulating: if (!huntCursor) return;
          const huntCursor = null;
          if (reason === "duplicate" && candidate && huntCursor) {
            advanceCalled = true;
          }
        },
      }),
    );
    assert.ok(hookCalled, "onNoCandidate must be called");
    assert.equal(advanceCalled, false, "no cursor means no advance");
  });

  // The invariant test: it must be impossible for the cursor to advance
  // past an episode that was neither sent nor already held.
  await checkAsync("cursor cannot advance past an episode not sent and not held", async () => {
    // Scenario: episode exists in search but is NOT a duplicate and send
    // fails. The cursor must NOT advance.
    let successCalled = false;
    let noCandidateReason: string | undefined;
    const r = await runGrabPipeline(
      baseOpts({
        _sendFn: async () => ({ ok: false, message: "Client rejected torrent" }),
        onSuccess: async () => { successCalled = true; },
        onFailure: async () => {},
        onNoCandidate: async (reason) => { noCandidateReason = reason; },
      }),
    );
    assert.equal(r.status, "failed");
    assert.equal(successCalled, false, "onSuccess must not fire on send failure");
    assert.equal(noCandidateReason, undefined, "onNoCandidate must not fire — a candidate existed");
  });

  // Regression: two consecutive passes where the episode is already held.
  // The cursor must be further along after the second than before the first.
  await checkAsync("two consecutive duplicate passes advance cursor (regression)", async () => {
    let cursor = { season: 2, episode: 3 };

    for (let pass = 0; pass < 2; pass++) {
      const epLabel = `S${String(cursor.season).padStart(2, "0")}E${String(cursor.episode).padStart(2, "0")}`;
      await runGrabPipeline(
        baseOpts({
          _searchFn: async () =>
            fakeSearchResponse([
              fakeResult({
                title: `Simpsons ${epLabel} 1080p WEB-DL`,
                seeders: 100,
              }),
            ]),
          checkDuplicate: async () => "Already in the client",
          onNoCandidate: async (reason, _msg, candidate) => {
            if (reason === "duplicate" && candidate) {
              // Simulate cursor-match check and advance
              if (candidate.title.includes(epLabel)) {
                cursor = { season: cursor.season, episode: cursor.episode + 1 };
              }
            }
          },
        }),
      );
    }

    // Started at S02E03, two advances → S02E05
    assert.equal(cursor.season, 2);
    assert.equal(cursor.episode, 5, "cursor must advance past both held episodes");
  });

  // ── 17. Idempotency guard on (userId, infoHash) ─────────────────────────
  //
  // Regression: Rick and Morty S01E01 appeared twice on the home board —
  // same infoHash, same user, six seconds apart, two GrabJob rows and two
  // DownloadHistory rows. The pipeline had no idempotency guard.
  //
  // The rule class is NOT "block Rick and Morty": it is "a second grab of a
  // hash already grabbed inside the window creates no second pair, for any
  // release, any indexer casing, any caller".

  const dupeCases = [
    { name: "Rick and Morty S01E01", hash: "461e249b2597", second: "461e249b2597" },
    { name: "mixed case from a second indexer", hash: "ABC123DEF456", second: "abc123def456" },
    { name: "whitespace-padded hash", hash: "abc123def456", second: "  ABC123DEF456 " },
    { name: "anime absolute-numbered release", hash: "A1B2C3D4E5F6", second: "a1b2c3d4e5f6" },
    { name: "season pack", hash: "0f0f0f0f0f0f", second: "0F0F0F0F0F0F" },
  ];

  for (const tc of dupeCases) {
    await checkAsync(`duplicate grab is blocked: ${tc.name}`, async () => {
      const { proxy, calls } = mockPrisma();
      const shared = { _prisma: proxy as unknown as GrabPipelineOptions["_prisma"] };

      const first = await runGrabPipeline(
        baseOpts({
          ...shared,
          _searchFn: async () =>
            fakeSearchResponse([fakeResult({ title: tc.name, infoHash: tc.hash })]),
          _sendFn: async () => ({ ok: true, message: "Download started (0% · 2 peers)" }),
        }),
      );
      const second = await runGrabPipeline(
        baseOpts({
          ...shared,
          _searchFn: async () =>
            fakeSearchResponse([fakeResult({ title: tc.name, infoHash: tc.second })]),
          _sendFn: async () => ({ ok: true, message: "Downloading (0% · 5 peers)" }),
        }),
      );

      assert.equal(first.status, "sent");
      assert.equal(second.status, "already_active", "second grab must not be a send");

      const jobs = calls.filter((c) => c.model === "grabJob" && c.op === "create");
      const history = calls.filter((c) => c.model === "downloadHistory" && c.op === "create");
      assert.equal(jobs.length, 1, "exactly one GrabJob row for one release");
      assert.equal(history.length, 1, "exactly one DownloadHistory row for one release");
    });
  }

  await checkAsync("the surviving row keeps the MORE ADVANCED message", async () => {
    const { proxy, store } = mockPrisma();
    const shared = { _prisma: proxy as unknown as GrabPipelineOptions["_prisma"] };
    const search = async () =>
      fakeSearchResponse([fakeResult({ infoHash: "461e249b2597" })]);

    await runGrabPipeline(
      baseOpts({
        ...shared,
        _searchFn: search,
        _sendFn: async () => ({ ok: true, message: "Download started (0% · 2 peers)" }),
      }),
    );
    await runGrabPipeline(
      baseOpts({
        ...shared,
        _searchFn: search,
        _sendFn: async () => ({ ok: true, message: "Downloading in built-in engine (0% · 5 peers)" }),
      }),
    );

    assert.equal(store.grabJob.length, 1);
    assert.equal(
      store.grabJob[0].message,
      "Downloading in built-in engine (0% · 5 peers)",
      "the newer client status must win",
    );
    assert.equal(store.downloadHistory.length, 1, "history must not be duplicated");
    assert.ok(
      String(store.downloadHistory[0].message).includes("5 peers"),
      "the history row the board renders must be refreshed too",
    );
  });

  await checkAsync("a failed re-send never overwrites a healthy record", async () => {
    const { proxy, store } = mockPrisma();
    const shared = { _prisma: proxy as unknown as GrabPipelineOptions["_prisma"] };
    const search = async () =>
      fakeSearchResponse([fakeResult({ infoHash: "461e249b2597" })]);

    await runGrabPipeline(
      baseOpts({ ...shared, _searchFn: search, _sendFn: async () => ({ ok: true, message: "Downloading (30%)" }) }),
    );
    const r = await runGrabPipeline(
      baseOpts({ ...shared, _searchFn: search, _sendFn: async () => ({ ok: false, message: "Client rejected torrent" }) }),
    );

    assert.equal(r.status, "already_active");
    assert.equal(store.grabJob.length, 1);
    assert.equal(
      store.grabJob[0].message,
      "Downloading (30%)",
      "a failed retry must not turn a live download into a phantom failure",
    );
  });

  // NULL infoHash: "unknown", not "the same". Magnet-only releases and the
  // seeded fixtures all share a NULL and must never collapse into one row.
  await checkAsync("rows with NULL infoHash are never treated as duplicates", async () => {
    const { proxy, calls } = mockPrisma();
    const shared = { _prisma: proxy as unknown as GrabPipelineOptions["_prisma"] };

    const titles = ["Dune Part Two 2160p", "The Bear S03E02 1080p", "Frieren - 28"];
    const statuses: string[] = [];
    for (const title of titles) {
      const r = await runGrabPipeline(
        baseOpts({
          ...shared,
          _searchFn: async () =>
            fakeSearchResponse([fakeResult({ title, infoHash: undefined })]),
        }),
      );
      statuses.push(r.status);
    }

    assert.deepEqual(statuses, ["sent", "sent", "sent"], "no NULL-hash row may be swallowed");
    const jobs = calls.filter((c) => c.model === "grabJob" && c.op === "create");
    assert.equal(jobs.length, 3, "three distinct hashless releases → three rows");
  });

  await checkAsync("an empty-string infoHash is treated as NULL, not as a shared key", async () => {
    const { proxy, calls } = mockPrisma();
    const shared = { _prisma: proxy as unknown as GrabPipelineOptions["_prisma"] };
    for (const title of ["Movie A", "Movie B"]) {
      const r = await runGrabPipeline(
        baseOpts({
          ...shared,
          _searchFn: async () => fakeSearchResponse([fakeResult({ title, infoHash: "   " })]),
        }),
      );
      assert.equal(r.status, "sent");
    }
    assert.equal(
      calls.filter((c) => c.model === "grabJob" && c.op === "create").length,
      2,
    );
  });

  // Re-grabbing later is legitimate: delete a download, re-fetch; or grab the
  // same release again months on. The guard is scoped to a window, not to all
  // history, so an old grab must never block a new one.
  await checkAsync("re-grab after the dedup window is allowed", async () => {
    const stale = new Date(Date.now() - GRAB_DEDUP_WINDOW_MS - 60_000);
    const { proxy, calls } = mockPrisma({
      grabJob: [
        {
          userId: "user-1",
          infoHash: "461e249b2597",
          status: "sent",
          message: "Download started",
          createdAt: stale,
        },
      ],
    });

    const r = await runGrabPipeline(
      baseOpts({
        _prisma: proxy as unknown as GrabPipelineOptions["_prisma"],
        _searchFn: async () => fakeSearchResponse([fakeResult({ infoHash: "461e249b2597" })]),
      }),
    );

    assert.equal(r.status, "sent", "a grab older than the window must not block a re-grab");
    assert.equal(
      calls.filter((c) => c.model === "grabJob" && c.op === "create").length,
      1,
    );
  });

  await checkAsync("a prior FAILED grab inside the window does not block a retry", async () => {
    const { proxy } = mockPrisma({
      grabJob: [
        {
          userId: "user-1",
          infoHash: "461e249b2597",
          status: "failed",
          message: "Client offline",
          createdAt: new Date(),
        },
      ],
    });
    const r = await runGrabPipeline(
      baseOpts({
        _prisma: proxy as unknown as GrabPipelineOptions["_prisma"],
        _searchFn: async () => fakeSearchResponse([fakeResult({ infoHash: "461e249b2597" })]),
      }),
    );
    assert.equal(r.status, "sent", "only a *successful* grab may block a retry");
  });

  await checkAsync("another user's grab of the same hash is not a duplicate", async () => {
    const { proxy, calls } = mockPrisma({
      grabJob: [
        {
          userId: "someone-else",
          infoHash: "461e249b2597",
          status: "sent",
          message: "Downloading",
          createdAt: new Date(),
        },
      ],
    });
    const r = await runGrabPipeline(
      baseOpts({
        _prisma: proxy as unknown as GrabPipelineOptions["_prisma"],
        _searchFn: async () => fakeSearchResponse([fakeResult({ infoHash: "461e249b2597" })]),
      }),
    );
    assert.equal(r.status, "sent", "the guard is scoped per user");
    assert.equal(
      calls.filter((c) => c.model === "grabJob" && c.op === "create").length,
      1,
    );
  });

  await checkAsync("concurrent grabs of one hash produce exactly one row", async () => {
    const { proxy, calls } = mockPrisma();
    const shared = { _prisma: proxy as unknown as GrabPipelineOptions["_prisma"] };
    const opts = () =>
      baseOpts({
        ...shared,
        _searchFn: async () => fakeSearchResponse([fakeResult({ infoHash: "461e249b2597" })]),
        _sendFn: async () => {
          // Both requests are in-flight across the same await point — this is
          // the six-seconds-apart double grab, compressed.
          await new Promise((r) => setTimeout(r, 5));
          return { ok: true, message: "Download started" };
        },
      });

    const results = await Promise.all([
      runGrabPipeline(opts()),
      runGrabPipeline(opts()),
      runGrabPipeline(opts()),
    ]);

    const sent = results.filter((r) => r.status === "sent");
    const active = results.filter((r) => r.status === "already_active");
    assert.equal(sent.length, 1, "exactly one request may claim the send");
    assert.equal(active.length, 2, "the losers must report already_active, not silence");
    assert.equal(
      calls.filter((c) => c.model === "grabJob" && c.op === "create").length,
      1,
      "one GrabJob row",
    );
    assert.equal(
      calls.filter((c) => c.model === "downloadHistory" && c.op === "create").length,
      1,
      "one DownloadHistory row — this is the board duplicate",
    );
  });

  await checkAsync("a blocked duplicate does not re-run the caller's onSuccess hook", async () => {
    const { proxy } = mockPrisma();
    const shared = { _prisma: proxy as unknown as GrabPipelineOptions["_prisma"] };
    const search = async () => fakeSearchResponse([fakeResult({ infoHash: "461e249b2597" })]);
    let successCalls = 0;

    await runGrabPipeline(
      baseOpts({ ...shared, _searchFn: search, onSuccess: async () => { successCalls += 1; } }),
    );
    await runGrabPipeline(
      baseOpts({ ...shared, _searchFn: search, onSuccess: async () => { successCalls += 1; } }),
    );

    assert.equal(
      successCalls,
      1,
      "a duplicate must not advance the cursor or bump matchCount a second time",
    );
  });

  check("normalizeInfoHash collapses indexer casing and padding", () => {
    const cases: [string | null | undefined, string | null][] = [
      ["ABC123", "abc123"],
      ["  abc123  ", "abc123"],
      ["AbC123\n", "abc123"],
      ["", null],
      ["   ", null],
      [null, null],
      [undefined, null],
    ];
    for (const [input, want] of cases) {
      assert.equal(normalizeInfoHash(input), want, `normalizeInfoHash(${JSON.stringify(input)})`);
    }
  });

  // ── Done ────────────────────────────────────────────────────────────────

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
