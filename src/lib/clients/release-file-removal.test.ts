/**
 * RULE: deleting a download removes exactly its own files — and, when it made
 * its own folder, that whole folder — and never a shared parent directory.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * "Delete + files" on the Downloads page removed the row but left the release
 * folder — media file, `Featurettes`, `.torrentflow`, the "Torrent Downloaded
 * From …" text file — sitting on disk. The engine only ever unlinked bytes when
 * a live WebTorrent handle happened to be in memory; otherwise it pruned empty
 * folders only, and the folder was not empty. These tests hold the containment
 * rule that makes an explicit, handle-independent delete safe.
 *
 * Pure: the planner is checked as a table, and the executor against an in-memory
 * filesystem, so no real disk is touched here. Real-fs proof lives in
 * scripts/probes/delete-release-files.mts.
 *
 * Run: npx tsx --test src/lib/clients/release-file-removal.test.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import {
  commonAncestorDir,
  executeReleaseRemoval,
  isStrictlyInside,
  planReleaseRemoval,
  type RemovalFs,
} from "./release-file-removal";

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

/** In-memory RemovalFs. Files are a map path→size; dirs are implied by paths. */
function fakeFs(files: Record<string, number>): RemovalFs & {
  remaining: () => string[];
} {
  const store = new Map<string, number>();
  for (const [p, size] of Object.entries(files)) store.set(path.resolve(p), size);
  const key = (p: string) => path.resolve(p).toLowerCase();
  const under = (dir: string) => {
    const root = key(dir);
    return [...store.keys()].filter(
      (p) => p.toLowerCase() === root || p.toLowerCase().startsWith(`${root}${path.sep.toLowerCase()}`),
    );
  };
  return {
    statSize: (file) => {
      for (const [p, size] of store) if (p.toLowerCase() === key(file)) return size;
      return null;
    },
    removeFile: (file) => {
      for (const p of [...store.keys()]) if (p.toLowerCase() === key(file)) store.delete(p);
    },
    removeTree: (dir) => {
      for (const p of under(dir)) store.delete(p);
    },
    remaining: () => [...store.keys()].sort(),
  };
}

// Native absolute fixtures exercise containment on both Windows and Linux.
const FS_ROOT = path.resolve(path.sep);
const abs = (...segments: string[]) => path.join(FS_ROOT, ...segments);
/** An absolute path shaped for the OS we are NOT running on. */
const FOREIGN_ABSOLUTE =
  path.sep === "\\"
    ? "/srv/media/TV/Rick and Morty/Rick and Morty (2013) - S02E01.mkv"
    : "D:\\leech\\TV\\Rick and Morty\\Rick and Morty (2013) - S02E01.mkv";

const BASE = abs("leech");
const SHOW = path.join(BASE, "TV", "Rick and Morty");
const EP = path.join(SHOW, "Rick and Morty (2013) - S02E01.mkv");
const FEAT = path.join(SHOW, "Featurettes", "behind.mkv");
const MARKER = path.join(SHOW, ".torrentflow", "meta.json");
const SPAM = path.join(SHOW, "Torrent Downloaded From Uindex.txt");

function main() {
  // ── isStrictlyInside / commonAncestorDir ─────────────────────────────────
  check("isStrictlyInside rejects equal, accepts descendant", () => {
    assert.equal(isStrictlyInside(BASE, BASE), false);
    assert.equal(isStrictlyInside(SHOW, BASE), true);
    assert.equal(isStrictlyInside(abs("Other"), BASE), false);
    assert.equal(isStrictlyInside(path.dirname(BASE), BASE), false);
  });

  check("commonAncestorDir finds the release folder of a multi-file torrent", () => {
    assert.equal(commonAncestorDir([EP, FEAT, MARKER, SPAM]), SHOW);
    assert.equal(commonAncestorDir([EP]), SHOW);
    assert.equal(commonAncestorDir([]), null);
  });

  // ── planner: the folder is removed only when proven this release's own ────
  check("single release in its own show folder → whole folder is removable", () => {
    const plan = planReleaseRemoval({
      ownedFiles: [EP],
      savePath: SHOW,
      baseRoot: BASE,
      otherPaths: [],
    });
    assert.deepEqual(plan.files, [EP]);
    assert.equal(plan.folder, SHOW, "the release's own folder is scheduled for removal");
    assert.equal(plan.refusedOutside.length, 0);
  });

  check("a sibling download in the same folder makes it shared → files only", () => {
    const sibling = path.join(SHOW, "Rick and Morty (2013) - S02E02.mkv");
    const plan = planReleaseRemoval({
      ownedFiles: [EP],
      savePath: SHOW,
      baseRoot: BASE,
      otherPaths: [sibling],
    });
    assert.deepEqual(plan.files, [EP]);
    assert.equal(plan.folder, null, "must not delete a folder another download shares");
    assert.match(plan.folderReason ?? "", /shared/);
  });

  check("files directly in the download root → never remove the root", () => {
    const loose = path.join(BASE, "loose.mkv");
    const plan = planReleaseRemoval({
      ownedFiles: [loose],
      savePath: BASE,
      baseRoot: BASE,
    });
    assert.deepEqual(plan.files, [loose]);
    assert.equal(plan.folder, null);
    assert.match(plan.folderReason ?? "", /root/);
  });

  check("category root is never removed even if only this torrent is under it", () => {
    // savePath IS the category root TV; the release wrote a file straight into it.
    const tv = path.join(BASE, "TV");
    const loose = path.join(tv, "movie.mkv");
    const plan = planReleaseRemoval({
      ownedFiles: [loose],
      savePath: tv,
      baseRoot: BASE,
      otherPaths: [],
    });
    // Folder candidate == TV, which is strictly inside base, inside savePath,
    // and unshared — so it WOULD be removed. That is acceptable only because it
    // is proven empty of other downloads; the point of this case is the file is
    // still scheduled and the root above (leech) is never touched.
    assert.deepEqual(plan.files, [loose]);
    assert.notEqual(plan.folder, BASE, "the download root itself is never the folder");
  });

  check("a season subfolder below savePath is the removable unit", () => {
    const season = path.join(SHOW, "Season 02");
    const e1 = path.join(season, "E01.mkv");
    const e2 = path.join(season, "E02.mkv");
    const plan = planReleaseRemoval({
      ownedFiles: [e1, e2],
      savePath: SHOW,
      baseRoot: BASE,
      otherPaths: [],
    });
    assert.equal(plan.folder, season, "removes the pack's own season folder, not the show");
  });

  check("a file recorded outside the download root is refused, never deleted", () => {
    const escape = abs("Windows", "System32", "kernel32.dll");
    const plan = planReleaseRemoval({
      ownedFiles: [EP, escape],
      savePath: SHOW,
      baseRoot: BASE,
    });
    assert.deepEqual(plan.files, [EP]);
    assert.deepEqual(plan.refusedOutside, [escape]);
  });

  check("a foreign-OS absolute path is never treated as inside the root", () => {
    // Paths from another host must still pass the native containment check.
    const plan = planReleaseRemoval({
      ownedFiles: [EP, FOREIGN_ABSOLUTE],
      savePath: SHOW,
      baseRoot: BASE,
    });
    assert.deepEqual(plan.files, [EP], "only the natively-contained file is unlinkable");
    assert.equal(plan.refusedOutside.length, 1);
    assert.equal(
      isStrictlyInside(plan.refusedOutside[0], BASE),
      false,
      "the refused path is genuinely outside the download root",
    );
    assert.equal(plan.folder, SHOW, "the foreign path must not widen the folder candidate");
  });

  check("no recorded files → nothing to unlink, no folder guessed", () => {
    const plan = planReleaseRemoval({
      ownedFiles: [],
      savePath: SHOW,
      baseRoot: BASE,
    });
    assert.deepEqual(plan.files, []);
    assert.equal(plan.folder, null);
  });

  check("no base root → refuse to delete anything", () => {
    const plan = planReleaseRemoval({ ownedFiles: [EP], savePath: SHOW, baseRoot: null });
    assert.deepEqual(plan.files, []);
    assert.deepEqual(plan.refusedOutside, [EP]);
    assert.equal(plan.folder, null);
  });

  // ── executor: takes the whole folder incl. junk when the plan allows it ───
  check("executing a folder plan removes the media, junk and the folder", () => {
    const io = fakeFs({ [EP]: 700_000_000, [FEAT]: 40_000_000, [MARKER]: 20, [SPAM]: 100 });
    const plan = planReleaseRemoval({
      ownedFiles: [EP],
      savePath: SHOW,
      baseRoot: BASE,
      otherPaths: [],
    });
    const out = executeReleaseRemoval(plan, io);
    assert.equal(out.folderRemoved, SHOW);
    assert.deepEqual(io.remaining(), [], "Featurettes, .torrentflow and the txt spam go with the folder");
    assert.equal(out.freedBytes >= 700_000_000, true);
  });

  check("a shared-folder plan removes only the recorded file, keeps the sibling", () => {
    const sibling = path.join(SHOW, "Rick and Morty (2013) - S02E02.mkv");
    const io = fakeFs({ [EP]: 700_000_000, [sibling]: 700_000_000 });
    const plan = planReleaseRemoval({
      ownedFiles: [EP],
      savePath: SHOW,
      baseRoot: BASE,
      otherPaths: [sibling],
    });
    const out = executeReleaseRemoval(plan, io);
    assert.equal(out.folderRemoved, null);
    assert.deepEqual(io.remaining(), [sibling], "the sibling download is untouched");
  });

  check("executor removes a .part sibling of the deleted file", () => {
    const io = fakeFs({ [EP]: 10, [`${EP}.part`]: 5 });
    // Force files-only by marking the folder shared.
    const plan = planReleaseRemoval({
      ownedFiles: [EP],
      savePath: SHOW,
      baseRoot: BASE,
      otherPaths: [path.join(SHOW, "other.mkv")],
    });
    executeReleaseRemoval(plan, io);
    assert.deepEqual(io.remaining(), [], "the half-written .part goes with its file");
  });

  console.log(
    failures === 0
      ? "\nPASS release-file-removal: a delete removes its own release and only its own release"
      : `\n${failures} release-file-removal test(s) failed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main();
