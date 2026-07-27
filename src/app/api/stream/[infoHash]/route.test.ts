/**
 * The stream manifest is the only description of a torrent's contents the
 * browser ever sees, and every URL the player builds is assembled from the
 * `path` strings in it. So the separator in those strings is not cosmetic: it
 * decides whether a file can be addressed at all.
 *
 * These tests exist because it could not. On Windows, WebTorrent joins a
 * torrent's path components with a backslash, and this route passed that
 * straight through. A consumer that split on "/" — the obvious reading, and the
 * correct one for a format whose paths are defined as a list joined by "/" —
 * produced a single URL segment containing a literal backslash and got a 404
 * for a file that plays perfectly in the app.
 *
 * The stakes went up when the app started preferring season packs. A pack is by
 * definition a multi-file torrent, so every path in it carries a separator:
 * a bug that used to affect the occasional release with a subfolder now affects
 * the default case for every series.
 *
 * Run: npx tsx "src/app/api/stream/[infoHash]/route.test.ts"
 */
import assert from "node:assert/strict";

import { downloadedFileRanges, handleStreamIndexRequest } from "./route";
import type { ClientConnectionConfig } from "@/lib/clients";

let failures = 0;
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

const CONFIG = { clientType: "builtin" } as ClientConnectionConfig;

/**
 * Builds a lookup that answers with exactly the file list given, so each case
 * pins one path shape rather than depending on a fixture torrent.
 */
function lookupWith(paths: string[]) {
  return (async () => ({
    status: "ok" as const,
    torrent: {
      files: paths.map((p) => ({ path: p, length: 100 })),
      numPeers: 2,
      progress: 1,
      downloadSpeed: 0,
    },
    file: { path: paths[0], length: 100 },
  })) as never;
}

async function manifestFiles(paths: string[]): Promise<Array<{ path: string }>> {
  const res = await handleStreamIndexRequest(
    { infoHash: "a".repeat(40) },
    { getConfig: async () => CONFIG, findFile: lookupWith(paths), quiet: true },
  );
  assert.equal(res.status, 200, `expected a manifest, got HTTP ${res.status}`);
  const body = (await res.json()) as { files: Array<{ path: string }> };
  return body.files;
}

async function main() {
  console.log("── Stream manifest paths ──");

  /**
   * Table-driven because the rule is about the *separator*, not about the one
   * release that exposed it. Each row is a path shape a real torrent produces.
   */
  const cases: Array<{ name: string; input: string; expect: string }> = [
    {
      name: "a Windows-joined pack path is emitted with forward slashes",
      input: "Rick and Morty S01E02-Kitsune\\Rick and Morty S01E02.mkv",
      expect: "Rick and Morty S01E02-Kitsune/Rick and Morty S01E02.mkv",
    },
    {
      name: "a nested season pack keeps every level, all forward-slashed",
      input: "Shogun.S01.COMPLETE\\Season 01\\Shogun.S01E03.mkv",
      expect: "Shogun.S01.COMPLETE/Season 01/Shogun.S01E03.mkv",
    },
    {
      name: "a single-file torrent is unchanged",
      input: "Arrival.2016.1080p.mkv",
      expect: "Arrival.2016.1080p.mkv",
    },
    {
      name: "a path already using forward slashes is left alone",
      input: "Some.Pack/Some.Episode.mkv",
      expect: "Some.Pack/Some.Episode.mkv",
    },
    {
      name: "a mixed-separator path is normalised throughout, not just once",
      input: "Pack\\Season 01/Episode.mkv",
      expect: "Pack/Season 01/Episode.mkv",
    },
  ];

  for (const c of cases) {
    await checkAsync(c.name, async () => {
      const files = await manifestFiles([c.input]);
      assert.equal(files[0]?.path, c.expect);
    });
  }

  await checkAsync("no manifest path ever contains a backslash", async () => {
    const files = await manifestFiles(cases.map((c) => c.input));
    for (const f of files) {
      assert.ok(
        !f.path.includes("\\"),
        `a backslash survived into the manifest: ${JSON.stringify(f.path)}`,
      );
    }
  });

  /**
   * The regression as a viewer meets it: take the manifest path, build a URL the
   * only sane way, and check it round-trips to the same components the route
   * will parse back out. Before the fix this produced one segment with an
   * escaped backslash in it, which is what the stream route 404s on.
   */
  await checkAsync("a manifest path round-trips through URL segments", async () => {
    const files = await manifestFiles([
      "Rick and Morty S01E02-Kitsune\\Rick and Morty S01E02.mkv",
    ]);
    const encoded = files[0].path.split("/").map(encodeURIComponent).join("/");
    const decoded = encoded.split("/").map(decodeURIComponent);
    assert.deepEqual(decoded, [
      "Rick and Morty S01E02-Kitsune",
      "Rick and Morty S01E02.mkv",
    ]);
  });

  await checkAsync("a poll can omit downloaded ranges for files not on screen", async () => {
    const res = await handleStreamIndexRequest(
      { infoHash: "a".repeat(40) },
      {
        getConfig: async () => CONFIG,
        findFile: (async () => ({
          status: "ok" as const,
          torrent: {
            files: [
              { path: "Pack\\Episode 01.mkv", length: 100 },
              { path: "Pack\\Episode 02.mkv", length: 100 },
            ],
            numPeers: 2,
            progress: 0.5,
            downloadSpeed: 0,
          },
          file: { path: "Pack\\Episode 01.mkv", length: 100 },
        })) as never,
        quiet: true,
        downloadedRangesFor: "Pack/Episode 02.mkv",
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { files: Array<Record<string, unknown>> };
    assert.ok(!("downloadedRanges" in body.files[0]));
    assert.deepEqual(body.files[1]?.downloadedRanges, []);
  });

  await checkAsync("an incomplete multi-file pack still exposes every playable file", async () => {
    const res = await handleStreamIndexRequest(
      { infoHash: "a".repeat(40) },
      {
        getConfig: async () => CONFIG,
        findFile: (async () => ({
          status: "ok" as const,
          torrent: {
            files: [
              { path: "Pack\\Episode 01.mkv", length: 100 },
              { path: "Pack\\Episode 02.mkv", length: 200 },
              { path: "Pack\\Episode 03.mkv", length: 300 },
            ],
            numPeers: 1,
            progress: 0.12,
            downloadSpeed: 1024,
          },
          file: { path: "Pack\\Episode 01.mkv", length: 100 },
        })) as never,
        quiet: true,
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      files: Array<{ path: string; length: number; downloadedRanges?: unknown[] }>;
      swarm?: { progress: number | null };
    };
    assert.deepEqual(
      body.files.map((f) => [f.path, f.length]),
      [
        ["Pack/Episode 01.mkv", 100],
        ["Pack/Episode 02.mkv", 200],
        ["Pack/Episode 03.mkv", 300],
      ],
    );
    assert.equal(body.swarm?.progress, 0.12);
  });

  console.log("\n── Stream manifest downloaded ranges ──");

  const rangeCases: Array<{
    name: string;
    verifiedPieces: number[];
    file: { length: number; offset?: number; _startPiece?: number; _endPiece?: number };
    expect: Array<{ start: number; end: number }>;
  }> = [
    {
      name: "contiguous verified pieces merge into one held span",
      verifiedPieces: [0, 1],
      file: { length: 20, offset: 0, _startPiece: 0, _endPiece: 3 },
      expect: [{ start: 0, end: 10 }],
    },
    {
      name: "sparse verified pieces stay as separate islands",
      verifiedPieces: [0, 2],
      file: { length: 20, offset: 0, _startPiece: 0, _endPiece: 3 },
      expect: [
        { start: 0, end: 5 },
        { start: 10, end: 15 },
      ],
    },
    {
      name: "piece spans are clipped to a file that starts mid-piece",
      verifiedPieces: [1],
      file: { length: 8, offset: 3, _startPiece: 0, _endPiece: 2 },
      expect: [{ start: 2, end: 7 }],
    },
    {
      name: "a complete torrent paints the whole file without consulting peers",
      verifiedPieces: [],
      file: { length: 20, offset: 0, _startPiece: 0, _endPiece: 3 },
      expect: [{ start: 0, end: 20 }],
    },
  ];

  for (const c of rangeCases) {
    await checkAsync(c.name, async () => {
      const torrent = {
        done: c.name.startsWith("a complete"),
        progress: c.name.startsWith("a complete") ? 1 : 0.5,
        length: 20,
        pieceLength: 5,
        lastPieceLength: 5,
        pieces: Array.from({ length: 4 }),
        bitfield: { get: (index: number) => c.verifiedPieces.includes(index) },
      };
      assert.deepEqual(downloadedFileRanges(torrent as never, c.file), c.expect);
    });
  }

  await checkAsync("downloaded range islands are capped without moving outer bounds", async () => {
    const verifiedPieces = new Set<number>();
    for (let i = 0; i < 130; i += 2) verifiedPieces.add(i);
    const torrent = {
      done: false,
      progress: 0.5,
      length: 130,
      pieceLength: 1,
      lastPieceLength: 1,
      pieces: Array.from({ length: 130 }),
      bitfield: { get: (index: number) => verifiedPieces.has(index) },
    };
    const ranges = downloadedFileRanges(
      torrent as never,
      { length: 130, offset: 0, _startPiece: 0, _endPiece: 129 },
    );
    assert.equal(ranges.length, 64);
    assert.deepEqual(ranges[0], { start: 0, end: 3 });
    assert.deepEqual(ranges[ranges.length - 1], { start: 128, end: 129 });
  });

  await checkAsync("a file already under the range cap is returned untouched", async () => {
    const verifiedPieces = new Set([0, 2, 4]);
    const torrent = {
      done: false,
      progress: 0.5,
      length: 6,
      pieceLength: 1,
      lastPieceLength: 1,
      pieces: Array.from({ length: 6 }),
      bitfield: { get: (index: number) => verifiedPieces.has(index) },
    };
    assert.deepEqual(
      downloadedFileRanges(
        torrent as never,
        { length: 6, offset: 0, _startPiece: 0, _endPiece: 5 },
      ),
      [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
        { start: 4, end: 5 },
      ],
    );
  });

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
