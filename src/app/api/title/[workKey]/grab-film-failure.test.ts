/**
 * A film grab that fails must say which thing failed.
 *
 * Three different problems used to share one sentence — "No seeded torrent for
 * X": every indexer being unreachable, a quality floor nothing cleared, and a
 * work key corrupted by a release suffix so the film's own releases read as a
 * different work. The user cannot act on that sentence, and in two of the three
 * cases it is a false claim about availability.
 *
 * Nothing here asserts anything about peers or swarms; this layer has no
 * evidence about those and must not pretend to.
 */
import assert from "node:assert/strict";
import type { TorrentResult } from "@/lib/torrents/types";
import { logAcquisitionDecision } from "@/lib/observability/acquisition-diagnostics";
import { sanitizeLogFields } from "@/lib/observability/logging";
import {
  filmNoMatchMessage,
  selectWorkCandidate,
  sourceOutageMessage,
  storageRootMode,
  summarizeFilmRejection,
} from "./grab";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

/** Collect what the logger actually wrote, without polluting the run's output. */
function captureInfo(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.info = original;
  }
  return lines;
}

function result(over: Partial<TorrentResult> = {}): TorrentResult {
  return {
    id: over.id ?? "r1",
    title: over.title ?? "Ninja Assassin (2009) 1080p BrRip x264 - 1.4GB - YIFY",
    magnet: "magnet" in over ? over.magnet : "magnet:?xt=urn:btih:abc",
    infoHash: over.infoHash ?? "abc",
    sizeBytes: over.sizeBytes ?? 1_400_000_000,
    sizeLabel: over.sizeLabel ?? "1.4 GB",
    seeders: over.seeders ?? 10,
    leechers: over.leechers ?? 1,
    category: over.category ?? "movies",
    source: over.source ?? "yts",
    sourceUrl: over.sourceUrl ?? null,
    publishedAt: over.publishedAt ?? null,
    tags: over.tags ?? [],
    metadata: over.metadata,
    episode: over.episode,
  } as TorrentResult;
}

console.log("film grab: honest failure…");

check("the reported release is now selectable for its own page", () => {
  // The whole defect in one assertion: before the title cleanup, the YIFY size
  // and group survived into the identity, so this release was read as a
  // different work and the page reported "no release" for its own film.
  const picked = selectWorkCandidate(
    [result()],
    "ninja-assassin-2009",
    false,
    1080,
    "Ninja Assassin",
    "movies",
    1080,
  );
  assert.equal(picked?.id, "r1");
});

check("the 1080p floor is a minimum, not a preference", () => {
  const picked = selectWorkCandidate(
    [
      result({ id: "sd", title: "Ninja Assassin (2009) 720p BrRip x264 - 0.7GB - YIFY" }),
      result({ id: "unknown", title: "Ninja Assassin (2009) BrRip x264 - YIFY" }),
    ],
    "ninja-assassin-2009",
    false,
    1080,
    "Ninja Assassin",
    "movies",
    1080,
  );
  assert.equal(picked, null, "below-floor and unknown quality are ineligible");
});

check("a higher resolution is allowed when the exact one does not exist", () => {
  const picked = selectWorkCandidate(
    [result({ id: "uhd", title: "Ninja Assassin (2009) 2160p BluRay x265 - 8.0GB - YTS" })],
    "ninja-assassin-2009",
    false,
    1080,
    "Ninja Assassin",
    "movies",
    1080,
  );
  assert.equal(picked?.id, "uhd");
});

check("a film never takes a season pack", () => {
  const picked = selectWorkCandidate(
    [result({ id: "pack", title: "Ninja Assassin (2009) S01 COMPLETE 1080p BluRay" })],
    "ninja-assassin-2009",
    false,
    1080,
    "Ninja Assassin",
    "movies",
    1080,
  );
  assert.equal(picked, null);
});

console.log("\nsourceOutageMessage…");

check("every source failing is an outage, not a missing release", () => {
  const msg = sourceOutageMessage([
    { id: "yts", count: 0, error: "yts.mx returned a non-API response" },
    { id: "apibay", count: 0, error: "HTTP 403" },
  ]);
  assert.ok(msg);
  assert.match(msg, /outage, not a missing release/);
  assert.match(msg, /yts, apibay/);
  // No claim about peers, and nothing from the failure text that could carry a
  // magnet or a credential.
  assert.doesNotMatch(msg, /magnet:|peer/i);
});

check("one working source that found nothing is a real empty answer", () => {
  assert.equal(
    sourceOutageMessage([
      { id: "yts", count: 0 },
      { id: "apibay", count: 0, error: "HTTP 403" },
    ]),
    null,
  );
});

check("no source information at all makes no claim", () => {
  assert.equal(sourceOutageMessage(undefined), null);
  assert.equal(sourceOutageMessage([]), null);
});

console.log("\nsummarizeFilmRejection + message…");

check("counts each rejection reason without leaking anything", () => {
  const summary = summarizeFilmRejection(
    [
      result({ id: "a", title: "Ninja Assassin (2009) 720p BrRip - 0.7GB - YIFY" }),
      result({ id: "b", title: "Children of Dune (2003) 1080p BluRay x264" }),
      result({ id: "c", seeders: 0 }),
      result({ id: "d", magnet: undefined }),
      result({ id: "e", title: "Ninja Assassin (2009) S01E01 1080p WEB-DL" }),
    ],
    "ninja-assassin-2009",
    1080,
  );
  assert.equal(summary.total, 5);
  assert.equal(summary.belowFloor, 1);
  assert.equal(summary.otherWork, 1);
  assert.equal(summary.unseeded, 1);
  assert.equal(summary.noMagnet, 1);
  assert.equal(summary.packOrEpisode, 1);
});

check("the message names the reason, not just a count", () => {
  const msg = filmNoMatchMessage({
    title: "Ninja Assassin",
    minimumResolution: 1080,
    count: 3,
    sources: [{ id: "yts", count: 3 }],
    rejection: {
      total: 3,
      noMagnet: 0,
      unseeded: 0,
      belowFloor: 2,
      otherWork: 1,
      packOrEpisode: 0,
    },
  });
  assert.match(msg, /Ninja Assassin/);
  assert.match(msg, /1 were a different work/);
  assert.match(msg, /2 below 1080p or of unknown quality/);
});

check("an outage wins over the count-shaped sentence", () => {
  const msg = filmNoMatchMessage({
    title: "Ninja Assassin",
    minimumResolution: 1080,
    count: 0,
    sources: [{ id: "yts", count: 0, error: "all mirrors failed" }],
  });
  assert.match(msg, /outage/);
  assert.doesNotMatch(msg, /No seeded/);
});

check("a genuinely empty search still says so plainly", () => {
  const msg = filmNoMatchMessage({
    title: "Ninja Assassin",
    minimumResolution: 1080,
    count: 0,
    sources: [{ id: "yts", count: 0 }],
  });
  assert.equal(msg, "No seeded 1080p-or-higher torrent for Ninja Assassin");
});

console.log("\nstorageRootMode…");

check("names the rule that won, never the path", () => {
  assert.equal(
    storageRootMode({ baseDownloadPath: "D:\\Media", savePath: "D:\\x" }, "D:\\y"),
    "base",
  );
  assert.equal(storageRootMode({ savePath: "D:\\x" }, "D:\\y"), "target");
  assert.equal(storageRootMode({ savePath: "D:\\x" }, null), "client");
  assert.equal(storageRootMode({}, null), "cwd");
  // Low-cardinality and path-free, so it survives the log sanitiser intact.
  for (const mode of ["base", "target", "client", "cwd"]) {
    assert.deepEqual(sanitizeLogFields({ pathMode: mode }), { pathMode: mode });
  }
});

console.log("\nacquisition diagnostics…");

check("a film decision line is emitted only when the setting is on", () => {
  const lines = captureInfo(() => {
    logAcquisitionDecision({ verboseDiagnostics: false }, "candidate_none", {
      stage: "select",
      scope: "title",
    });
    logAcquisitionDecision({}, "candidate_none", { stage: "select" });
  });
  assert.deepEqual(lines, [], "diagnostics are opt-in and silent by default");
});

check("the film's fields survive the sanitiser and carry no user content", () => {
  const lines = captureInfo(() => {
    logAcquisitionDecision({ verboseDiagnostics: true }, "candidate_none", {
      stage: "select",
      scope: "title",
      category: "movies",
      source: "yts",
      resultCount: 20,
      candidateCount: 0,
      rejectedIdentity: 12,
      rejectedQuality: 6,
      rejectedSeeders: 2,
      minResolution: 1080,
      overrideStorageCap: false,
      pathMode: "base",
    });
  });
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(payload.component, "acquisition");
  assert.equal(payload.action, "candidate_none");
  assert.equal(payload.stage, "select");
  assert.equal(payload.rejectedIdentity, 12);
  assert.equal(payload.minResolution, 1080);
  assert.equal(payload.pathMode, "base");
  // Nothing that could identify the work, the release or the disk.
  assert.doesNotMatch(lines[0], /magnet:|Ninja|\\\\|[a-f0-9]{40}/i);
});

check("a release name or hash cannot be smuggled into a decision line", () => {
  const lines = captureInfo(() => {
    logAcquisitionDecision({ verboseDiagnostics: true }, "candidate_selected", {
      // Not a safe field name — dropped outright.
      title: "Ninja Assassin (2009) 1080p BrRip x264 - 1.4GB - YIFY",
      // A safe field name carrying an unsafe value — redacted, not printed.
      source: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    } as never);
  });
  const payload = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(payload.title, undefined);
  assert.equal(payload.source, "[redacted]");
});

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll film grab failure tests passed.");
