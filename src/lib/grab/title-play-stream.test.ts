/**
 * Anti-regression: a Play from a title page is an EPHEMERAL STREAM, never a
 * download.
 *
 * The bug this guards against: pressing "Play" on a title page ran the grab
 * pipeline with no stated intent, the engine fell back to its `origin = "user"`
 * schema default, and `applySendRetention` then read that self-inflicted default
 * as "the user chose to keep this". Every Play became a permanent, whole-file
 * download that showed up in the downloads list. Five such rows is what the user
 * actually hit.
 *
 * This test drives the REAL `runGrabPipeline` with `purpose: "stream"` (exactly
 * what the title-page Play path now threads), through a `_sendFn` that emulates
 * the built-in engine FAITHFULLY — it births `EngineTorrent.origin` from the
 * stated purpose via the same `resolveEffectiveAdd` the engine uses. It then runs
 * the REAL `applySendRetention` as the engine's send path does, and asserts:
 *
 *   1. the row is born `origin = "stream"` (NOT the user default) — the bug;
 *   2. the engine was told to DESELECT (fetch only what is played), not
 *      whole-file select;
 *   3. the DownloadHistory row is tagged `retention = "stream"`; and
 *   4. it is therefore hidden from the downloads / Recently Added / Activity
 *      views (which filter `retention: { not: "stream" }`), while the row still
 *      exists — proving the filter hides it rather than the write never happening.
 *
 * Proven RED before the fix (pipeline forwarding `purpose: "keep"` → origin
 * "user", select-all, retention "keep", row visible) and GREEN after.
 *
 * Run: npx tsx src/lib/grab/title-play-stream.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { runGrabPipeline } from "./pipeline";
import { resolveEffectiveAdd } from "@/lib/clients/add-purpose";
import { applySendRetention } from "@/lib/streaming/send-retention";
import type { AddTorrentPayload, ClientConnectionConfig } from "@/lib/clients/types";
import type { TorrentResult, SearchResponse } from "@/lib/torrents/types";

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

const userId = `title-play-${randomUUID()}`;
const HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const magnet = `magnet:?xt=urn:btih:${HASH}&dn=Dune.2021.1080p.WEB-DL`;

const config = {
  clientType: "builtin",
  host: "",
  savePath: process.cwd(),
} as ClientConnectionConfig;

/** Captured decision the fake engine derived from the stated purpose. */
let capturedSelection: string | null = null;
let capturedBirthOrigin: string | null = null;

/**
 * Faithful stand-in for `builtinClient.addTorrent`. It does the ONE thing the
 * real engine does that this test is about: it resolves the effective add from
 * the REQUIRED `purpose` on the payload and births `EngineTorrent.origin` from
 * it. If the pipeline ever stops stating intent, `payload.purpose` changes and
 * this row is born wrong — which is precisely the regression.
 */
async function fakeEngineSend(
  _cfg: ClientConnectionConfig,
  payload: AddTorrentPayload,
): Promise<{ ok: boolean; message: string }> {
  const hash = /btih:([0-9a-fA-F]{40})/.exec(payload.magnet ?? "")?.[1]?.toLowerCase();
  if (!hash) return { ok: false, message: "no hash in magnet" };

  const existing = await prisma.engineTorrent.findUnique({
    where: { userId_hash: { userId, hash } },
    select: { origin: true },
  });
  const lookup = existing
    ? ({ status: "found", origin: existing.origin } as const)
    : ({ status: "missing" } as const);

  const eff = resolveEffectiveAdd(payload.purpose, lookup);
  capturedSelection = eff.selection;
  capturedBirthOrigin = eff.birthOrigin;

  await prisma.engineTorrent.upsert({
    where: { userId_hash: { userId, hash } },
    create: {
      userId,
      hash,
      name: payload.name ?? "unknown",
      magnet: payload.magnet ?? null,
      savePath: payload.savePath ?? null,
      category: payload.category ?? null,
      status: "downloading",
      origin: eff.birthOrigin,
      sizeBytes: BigInt(2_000_000_000),
      progress: 0,
    },
    update: {},
  });
  return { ok: true, message: "Added to engine" };
}

function playResult(): TorrentResult {
  return {
    id: "dune-1",
    title: "Dune 2021 1080p WEB-DL",
    magnet,
    infoHash: HASH,
    sizeBytes: 2_000_000_000,
    seeders: 200,
    leechers: 5,
    source: "torrentscsv",
    sourceUrl: "https://example.com",
    tags: ["1080p", "WEB-DL"],
  };
}

function searchResponse(results: TorrentResult[]): SearchResponse {
  return {
    query: "Dune",
    results,
    tookMs: 10,
    totalCount: results.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    sources: [{ id: "torrentscsv", count: results.length }],
  };
}

async function main(): Promise<void> {
  console.log("title-play — a Play is an ephemeral stream, not a download\n");

  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, name: "title play test" },
    update: {},
  });

  try {
    // The title-page Play path: runGrabPipeline with purpose "stream".
    const outcome = await runGrabPipeline({
      userId,
      purpose: "stream",
      search: {
        query: "Dune",
        category: "movies",
        limit: 15,
        enrich: false,
        background: true,
        skipCache: true,
        filters: { hasMagnet: true },
      },
      config,
      fallbackTitle: "Dune",
      grabJobKind: "library",
      externalId: null,
      selectCandidate: (results) => results.find((r) => r.magnet) ?? null,
      resolveTarget: () => ({ category: "Movies", savePath: process.cwd() }),
      _searchFn: async () => searchResponse([playResult()]),
      _sendFn: fakeEngineSend,
      _prisma: prisma,
    });

    // The engine send path runs applySendRetention right after the add.
    await applySendRetention({
      userId,
      config,
      infoHash: HASH,
      retention: "stream",
    });

    await checkAsync("the pipeline reports the send succeeded", async () => {
      assert.equal(outcome.status, "sent", outcome.message);
    });

    await checkAsync("the EngineTorrent row is born origin=stream, NOT the user default", async () => {
      const row = await prisma.engineTorrent.findFirstOrThrow({ where: { userId, hash: HASH } });
      assert.equal(
        row.origin,
        "stream",
        "a Play classified as a kept download is THE bug — it must be born stream",
      );
    });

    await checkAsync("the engine is told to deselect — a Play fetches only what is played", async () => {
      assert.equal(capturedBirthOrigin, "stream");
      assert.equal(
        capturedSelection,
        "deselect",
        "a Play must NOT whole-file select; that is what downloads the entire file",
      );
    });

    await checkAsync("applySendRetention verifies and does NOT reclassify the stream to a download", async () => {
      const row = await prisma.engineTorrent.findFirstOrThrow({ where: { userId, hash: HASH } });
      assert.equal(
        row.origin,
        "stream",
        "applySendRetention is verification only — it must never promote a stream to user",
      );
    });

    await checkAsync("the acquisition is recorded with retention=stream", async () => {
      const hist = await prisma.downloadHistory.findFirstOrThrow({ where: { userId, infoHash: HASH } });
      assert.equal(hist.retention, "stream", "the history row must be tagged as an ephemeral stream");
    });

    await checkAsync("the Play does NOT appear in the downloads list", async () => {
      // Recently Added / Activity / History all filter retention: { not: "stream" }.
      const visible = await prisma.downloadHistory.findMany({
        where: { userId, status: "sent", retention: { not: "stream" } },
      });
      assert.equal(visible.length, 0, "a Play must never surface in the downloads view");
    });

    await checkAsync("control — the stream history row exists; the filter is what hides it", async () => {
      const all = await prisma.downloadHistory.findMany({ where: { userId, status: "sent" } });
      assert.equal(
        all.length,
        1,
        "exactly one history row was written — the empty downloads view is the retention filter, not an absent write",
      );
    });
  } finally {
    await prisma.downloadHistory.deleteMany({ where: { userId } });
    await prisma.grabJob.deleteMany({ where: { userId } });
    await prisma.engineTorrent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nPASS title-play-stream: a Play stays an ephemeral stream");
}

main().catch((err) => {
  console.error("FAIL title-play-stream (threw):", err);
  process.exit(1);
});
