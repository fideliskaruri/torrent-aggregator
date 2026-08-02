/**
 * Real-filesystem proof that deleting a download removes its files AND its own
 * folder — including sidecar junk — while leaving sibling folders untouched.
 *
 * Kept out of *.test.ts on purpose: the unit suite bans os.tmpdir()/TEMP so it
 * cannot leak bytes onto the owner's media volume. This probe is a throwaway
 * script that builds a fixture under the OS temp dir, exercises the real
 * `realRemovalFs`, and cleans up after itself.
 *
 * Run: npx tsx scripts/probes/delete-release-files.mts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  planReleaseRemoval,
  executeReleaseRemoval,
} from "../../src/lib/clients/release-file-removal";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-del-"));

function touch(p: string, bytes = 16) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
}

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

try {
  const base = path.join(ROOT, "leech");
  const tv = path.join(base, "TV");
  const show = path.join(tv, "Rick and Morty");
  const episode = path.join(show, "Rick and Morty (2013) - S02E01.mkv");
  const featurette = path.join(show, "Featurettes", "behind-the-scenes.mkv");
  const marker = path.join(show, ".torrentflow", "meta.json");
  const spam = path.join(show, "Torrent Downloaded From Uindex.txt");
  const part = `${episode}.part`;
  const sibling = path.join(tv, "Other Show", "keep-me.mkv");

  // ── Scenario 1: the release owns its folder ──────────────────────────────
  for (const f of [episode, featurette, marker, spam, part, sibling]) touch(f);

  const plan1 = planReleaseRemoval({
    ownedFiles: [episode],
    savePath: show,
    baseRoot: base,
    otherPaths: [],
  });
  const res1 = executeReleaseRemoval(plan1);

  check("release folder is removed entirely (media + Featurettes + .torrentflow + txt)", () => {
    assert.equal(fs.existsSync(show), false, `${show} should be gone`);
    assert.equal(res1.folderRemoved, show);
  });
  check("the .part went with it", () => assert.equal(fs.existsSync(part), false));
  check("the sibling show folder is untouched", () => {
    assert.equal(fs.existsSync(sibling), true, "sibling media must survive");
  });
  check("the shared category folder TV survives", () =>
    assert.equal(fs.existsSync(tv), true),
  );
  check("the download root survives", () => assert.equal(fs.existsSync(base), true));

  // ── Scenario 2: two downloads share one folder → only the file goes ───────
  const shared = path.join(tv, "Shared Show");
  const e1 = path.join(shared, "S01E01.mkv");
  const e2 = path.join(shared, "S01E02.mkv");
  for (const f of [e1, e2]) touch(f, 32);

  const plan2 = planReleaseRemoval({
    ownedFiles: [e1],
    savePath: shared,
    baseRoot: base,
    otherPaths: [e2], // the other episode is a separate download
  });
  const res2 = executeReleaseRemoval(plan2);

  check("shared folder: only the deleted episode is removed", () => {
    assert.equal(fs.existsSync(e1), false, "deleted episode is gone");
    assert.equal(fs.existsSync(e2), true, "the sibling episode survives");
    assert.equal(res2.folderRemoved, null, "the shared folder is never removed");
    assert.equal(fs.existsSync(shared), true);
  });
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\nPROBE PASS: delete removes the release folder + junk, keeps siblings and shared dirs"
    : `\nPROBE FAIL: ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
