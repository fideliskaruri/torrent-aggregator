/**
 * Playback locality contract.
 *
 * Four bugs lived in the seam between "is this file on disk" and "how are we
 * serving it", and every one of them had the same shape: locality was inferred
 * from something that does not actually mean locality. These tests pin the
 * corrected contract so it cannot silently regress.
 *
 *   1. `strategy` is not `source`. A session-strategy plan reads from disk
 *      whenever the file is complete, because ffmpeg gets the absolute path.
 *   2. One completion threshold (0.9999), not two — a strict `>= 1` in
 *      disk-fastpath made rows that the 0.9999 queries had already selected
 *      resolve to `null`.
 *   3. A completed torrent is routinely parked, so "no live torrent" must fall
 *      back to persisted verified files, not to the swarm.
 *   4. ffmpeg's input kind is part of a session's identity, or a swarm-backed
 *      session outlives the download that justified it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DOWNLOAD_COMPLETE_PROGRESS } from "@/lib/clients/builtin-engine-lifecycle";
import {
  isCompletedProgress,
  resolveCompletedPersistedDiskFile,
} from "@/lib/clients/disk-fastpath";
import { COMPLETE_PROGRESS } from "@/lib/media/local-file";
import { sessionSourceKind } from "@/lib/media/session";
import { makeScratchDir, removeScratchDir } from "@/lib/test-support/scratch-dir";

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

function readSource(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8");
}

function main() {
  // ── 2. One completion threshold ──

  check("the media layer and the engine share one completion threshold", () => {
    assert.equal(COMPLETE_PROGRESS, DOWNLOAD_COMPLETE_PROGRESS);
    assert.equal(COMPLETE_PROGRESS, 0.9999);
  });

  check("progress just under 1 counts as complete", () => {
    // This is the exact value WebTorrent reports for a finished torrent whose
    // piece lengths do not sum cleanly. The old strict `>= 1` rejected it.
    assert.equal(isCompletedProgress(0.99999994), true);
    assert.equal(isCompletedProgress(0.9999), true);
    assert.equal(isCompletedProgress(1), true);
  });

  check("progress below the threshold does not count as complete", () => {
    assert.equal(isCompletedProgress(0.9998), false);
    assert.equal(isCompletedProgress(0.5), false);
    assert.equal(isCompletedProgress(Number.NaN), false);
  });

  check("a verified file resolves at the threshold the queries select on", () => {
    // The regression in one assertion: a row that `progress: { gte: 0.9999 }`
    // returns must also resolve to a disk file, or the query and the resolver
    // disagree and playback falls back to the swarm forever.
    const root = makeScratchDir("locality-threshold");
    try {
      const absolute = path.join(root, "Show.S01E01.mkv");
      fs.writeFileSync(absolute, "x");
      const verifiedFilesJson = JSON.stringify([
        { path: absolute, size: 1, mtimeMs: 1 },
      ]);
      const resolved = resolveCompletedPersistedDiskFile(
        0.99995,
        root,
        verifiedFilesJson,
        "Show.S01E01.mkv",
      );
      assert.equal(resolved?.path, absolute);
    } finally {
      removeScratchDir(root);
    }
  });

  check("an incomplete torrent still resolves nothing from the persisted path", () => {
    const root = makeScratchDir("locality-incomplete");
    try {
      const absolute = path.join(root, "Show.S01E01.mkv");
      fs.writeFileSync(absolute, "x");
      const verifiedFilesJson = JSON.stringify([
        { path: absolute, size: 1, mtimeMs: 1 },
      ]);
      assert.equal(
        resolveCompletedPersistedDiskFile(0.42, root, verifiedFilesJson, "Show.S01E01.mkv"),
        null,
      );
    } finally {
      removeScratchDir(root);
    }
  });

  // ── 4. Source kind in session identity ──

  check("a loopback stream URL is classified as a swarm source", () => {
    assert.equal(sessionSourceKind("http://127.0.0.1:3000/api/stream/abc/File.mkv"), "swarm");
    assert.equal(sessionSourceKind("https://host/api/stream/abc/File.mkv"), "swarm");
  });

  check("an absolute local path is classified as a disk source", () => {
    assert.equal(sessionSourceKind("D:\\media\\Show\\File.mkv"), "disk");
    assert.equal(sessionSourceKind("/srv/media/Show/File.mkv"), "disk");
  });

  check("a Windows drive letter is not mistaken for a URL scheme", () => {
    // `C:` looks scheme-shaped; only http/https count, and only with `//`.
    assert.equal(sessionSourceKind("C:/media/File.mkv"), "disk");
  });

  check("the session key includes the source kind", () => {
    const source = readSource("src/lib/media/session.ts");
    assert.match(
      source,
      /function sessionKey\([^)]*source: SessionSourceKind,?[\s\S]*?\)/,
      "sessionKey must take the source kind",
    );
    assert.match(
      source,
      /return `\$\{infoHash\}\/\$\{filePath\}#a\$\{[^`]*\}@\$\{startSec\}~\$\{source\}`/,
      "the source kind must be part of the key string, not just an argument",
    );
  });

  check("getOrCreateSession derives the source kind from the url it was given", () => {
    const source = readSource("src/lib/media/session.ts");
    const derive = source.indexOf("const source = sessionSourceKind(sourceUrl)");
    const key = source.indexOf(
      "const key = sessionKey(infoHash, filePath, plan.selectedAudioIndex, startSec, source)",
    );
    assert.ok(derive >= 0, "the source kind is derived inside getOrCreateSession");
    assert.ok(derive < key, "the source kind is derived before the key is built");
  });

  // ── 1. Explicit source on the plan response ──

  check("the plan response reports source independently of strategy", () => {
    const source = readSource("src/app/api/playback/plan/route.ts");
    assert.match(
      source,
      /const source: PlaybackSource = local\.source/,
      "source comes from the local-file resolution, not from the strategy branch",
    );
    assert.match(source, /\n\s+source: result\.source,/, "source is serialised in the body");
  });

  check("every plan exit reports a source", () => {
    // A `respond({...})` that forgets `source` is a typecheck error now, but
    // the count is asserted so a new exit added without one is caught in review
    // rather than at runtime.
    const source = readSource("src/app/api/playback/plan/route.ts");
    const exits = source.match(/return respond\(\{[\s\S]*?\}\);/g) ?? [];
    assert.ok(exits.length >= 2, "the plan route has both a VOD and a session exit");
    for (const exit of exits) {
      assert.match(exit, /\bsource\b/, `a plan exit omits source: ${exit.slice(0, 80)}`);
    }
  });

  // ── 3. Persisted fallback when the live torrent is parked ──

  check("local resolution tries persisted disk before the engine lookup", () => {
    const source = readSource("src/lib/media/local-file.ts");
    const persisted = source.indexOf(
      "const persisted = await resolvePersistedLocalFile(config.userId, infoHash, filePath)",
    );
    const lookup = source.indexOf("await findBuiltinTorrentFile(");
    assert.ok(persisted >= 0, "the persisted fallback is extracted and called");
    assert.ok(
      persisted < lookup,
      "a parked completed torrent must resolve from disk without rehydrating the engine",
    );
  });

  check("a failed engine lookup is reported as a swarm source, not as complete", () => {
    const source = readSource("src/lib/media/local-file.ts");
    assert.match(source, /reason: `torrent lookup: \$\{lookup\.status\}`/);
    assert.equal(
      /ok: false,\s*reason:/.test(source),
      false,
      "every negative resolution must also state source: \"swarm\"",
    );
  });

  check("local resolution never returns ok without a disk source", () => {
    const source = readSource("src/lib/media/local-file.ts");
    assert.equal(
      /ok: true,(?![^}]*source: "disk")/.test(source),
      false,
      "an ok resolution without source: \"disk\" would let a caller default to swarm",
    );
  });
}

main();
if (failures > 0) {
  console.error(`\n${failures} playback locality test(s) failed`);
  process.exit(1);
}
console.log("\nAll playback locality tests passed.");
