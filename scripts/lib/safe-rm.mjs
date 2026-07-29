// Guarded recursive delete for harnesses and probes.
//
// WHY THIS EXISTS: on 2026-07-29 an automated cleanup deleted ~25 GB of the user's
// real media. The reasoning was "`.e2e-instant-play` is a harness directory, so
// everything under it is a fixture". That was wrong — the app's configured save
// root is `.e2e-instant-play\<runid>\leech`, so real user media lives inside a
// directory that LOOKS disposable. A path is not evidence of provenance.
//
// So this refuses to delete on POSITIVE evidence that real data is present, and
// it throws rather than skipping quietly: a harness that cannot clean up must
// fail loudly, not leave the operator believing the delete happened.

import fs from "node:fs";
import path from "node:path";

export const MARKER_NAME = "DO-NOT-DELETE-REAL-MEDIA.txt";

// Harness fixtures are encoded clips of a few MB. Real media is GB. A large file
// under a "disposable" path is the single strongest signal that the path
// classification is wrong.
const LARGE_FILE_BYTES = 64 * 1024 * 1024;

function markerAtOrAbove(target, stopAt) {
  let dir = path.resolve(target);
  const stop = path.resolve(stopAt);
  for (;;) {
    if (fs.existsSync(path.join(dir, MARKER_NAME))) return path.join(dir, MARKER_NAME);
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findLargeFile(dir, budget = 20000) {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > budget) {
        // Fail CLOSED: we could not finish looking, so we do not get to claim it is safe.
        throw new Error(
          `safeRmRecursive: refusing to delete ${dir} — too many entries to verify ` +
            `(>${budget}). Cannot prove this holds no real media, so it is not deleted.`,
        );
      }
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        if (fs.statSync(full).size >= LARGE_FILE_BYTES) return full;
      } catch {
        /* vanished mid-walk; nothing to protect */
      }
    }
  }
  return null;
}

/**
 * Recursively delete `target`, but refuse if there is positive evidence of real
 * user data. Throws on refusal — never returns quietly having done nothing.
 *
 * @param {string} target  directory to remove
 * @param {{ repoRoot: string, allowLargeFiles?: boolean }} opts
 */
export function safeRmRecursive(target, opts) {
  const repoRoot = path.resolve(opts.repoRoot);
  const resolved = path.resolve(target);

  if (!fs.existsSync(resolved)) return;

  const rel = path.relative(repoRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`safeRmRecursive: refusing to delete outside the repo: ${resolved}`);
  }
  if (rel === "") {
    throw new Error("safeRmRecursive: refusing to delete the repo root");
  }

  const marker = markerAtOrAbove(resolved, repoRoot);
  if (marker) {
    throw new Error(
      `safeRmRecursive: refusing to delete ${resolved} — protected by ${marker}. ` +
        `This path is, or is inside, a directory holding real user media.`,
    );
  }

  if (!opts.allowLargeFiles) {
    const big = findLargeFile(resolved);
    if (big) {
      throw new Error(
        `safeRmRecursive: refusing to delete ${resolved} — it contains a file of ` +
          `>=${Math.round(LARGE_FILE_BYTES / 1024 / 1024)} MB (${big}). Harness fixtures ` +
          `are small; a large file here means this directory is NOT disposable. ` +
          `If this really is fixture data, pass allowLargeFiles: true deliberately.`,
      );
    }
  }

  fs.rmSync(resolved, { recursive: true, force: true });
}
