/**
 * Four reported defects, as rules.
 *
 * All four came from the owner using the app:
 *
 *   1. *"double downloading"*
 *   2. *"the delete button doesn't even delete the folders"*
 *   3. *"downloads show ready but download button still clickable.. maybe make
 *      it say 'Downloaded' instead"*
 *   4. *"when i stream but want to download it, it tracks the download but it's
 *      not fast... it's being limited"*
 *
 * (1) and (3) are one defect seen from two sides: a control that does not know
 * its own state invites a press that repeats work. (2) and (4) are separate and
 * both come from the same shape of mistake — a step that updates one half of the
 * world and leaves the other half stale.
 *
 * Run: npx tsx src/components/search/held-releases.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  classifyHeld,
  downloadControlFor,
  heldFor,
  type HeldRelease,
} from "./use-held-releases";
import {
  pruneEmptyDescendants,
  pruneEmptyParents,
} from "@/lib/clients/prune-empty-parents";
import { withScratchDirSync } from "@/lib/test-support/scratch-dir";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const HASH = "a".repeat(40);

function main() {
  console.log("held-releases.test.ts");

  // ── (3) The button must report what is already held ──────────────────────
  const classify: Array<{
    name: string;
    input: Parameters<typeof classifyHeld>[0];
    state: HeldRelease["state"];
    why: string;
  }> = [
    {
      name: "a finished kept download is 'downloaded'",
      input: { retentionState: "kept", progress: 1 },
      state: "downloaded",
      why: "the reported case — this must stop offering Download",
    },
    {
      name: "a kept download in progress is 'downloading'",
      input: { retentionState: "kept", progress: 0.42 },
      state: "downloading",
      why: "pressing again would repeat work already underway",
    },
    {
      name: "a completed STREAM is not a download",
      input: { retentionState: "stream", progress: 1 },
      state: "stream",
      why: "a stream is reclaimable cache; Download still means 'keep this'",
    },
    {
      name: "a prewarm is not a download either",
      input: { retentionState: "prewarm", progress: 1 },
      state: "stream",
      why: "speculative cache the sweep may reclaim at any moment",
    },
    {
      name: "unknown retention suppresses nothing",
      input: { retentionState: "unknown", progress: 1 },
      state: "none",
      why: "not knowing must never remove the only way to get the file",
    },
    {
      name: "a missing retention suppresses nothing",
      input: { progress: 1 },
      state: "none",
      why: "same rule: absence of evidence is not evidence",
    },
    {
      name: "a kept download waiting in the engine queue is 'queued'",
      input: { retentionState: "kept", progress: 0, state: "queued", queuePosition: 3 },
      state: "queued",
      why: "it is admitted but not moving; 'Downloading 0%' would be a lie",
    },
    {
      name: "a queued STREAM is still a stream",
      input: { retentionState: "stream", progress: 0, state: "queued" },
      state: "stream",
      why: "retention decides first: Download still means 'keep this'",
    },
  ];
  for (const row of classify) {
    check(row.name, () => {
      assert.equal(classifyHeld(row.input).state, row.state, row.why);
    });
  }

  check("progress is clamped, never echoed raw into a label", () => {
    // A percentage over 100 or below 0 in the UI reads as a bug even when the
    // underlying number is just noise from the engine.
    assert.equal(classifyHeld({ retentionState: "kept", progress: 1.7 }).progress, 1);
    assert.equal(classifyHeld({ retentionState: "kept", progress: -3 }).progress, 0);
    assert.equal(
      classifyHeld({ retentionState: "kept", progress: Number.NaN }).progress,
      0,
    );
  });

  const controls: Array<{
    state: HeldRelease["state"];
    progress: number;
    label: RegExp;
    disabled: boolean;
  }> = [
    { state: "downloaded", progress: 1, label: /^Downloaded$/, disabled: true },
    { state: "downloading", progress: 0.42, label: /^Downloading 42%$/, disabled: true },
    { state: "queued", progress: 0, label: /^Queued$/, disabled: true },
    { state: "stream", progress: 1, label: /^Download$/, disabled: false },
    { state: "none", progress: 0, label: /^Download$/, disabled: false },
  ];
  for (const row of controls) {
    check(`the ${row.state} control reads "${row.label.source}"`, () => {
      const c = downloadControlFor({ state: row.state, progress: row.progress });
      assert.match(c.label, row.label);
      assert.equal(c.disabled, row.disabled);
    });
  }

  check("a suppressed button always explains why", () => {
    // Disabling with no reason is its own dead end — the viewer cannot tell a
    // deliberate 'you already have this' from a broken control.
    for (const state of ["downloaded", "downloading", "queued"] as const) {
      const c = downloadControlFor({ state, progress: 0.5 });
      assert.ok(c.disabled);
      assert.ok(c.hint && c.hint.trim().length > 0, `${state} gave no hint`);
    }
  });

  check("a queued control names its place in line", () => {
    const held = classifyHeld({
      retentionState: "kept",
      progress: 0,
      state: "queued",
      queuePosition: 2,
    });
    assert.equal(held.queuePosition, 2);
    assert.equal(downloadControlFor(held).label, "Queued · #2");
  });

  // ── Lookup: results carry hashes in more than one shape ─────────────────
  check("a release is matched by info hash or by magnet", () => {
    const held = new Map([[HASH, { state: "downloaded" as const, progress: 1 }]]);
    assert.equal(heldFor(held, HASH, null).state, "downloaded");
    assert.equal(heldFor(held, HASH.toUpperCase(), null).state, "downloaded");
    assert.equal(
      heldFor(held, null, `magnet:?xt=urn:btih:${HASH}&dn=x`).state,
      "downloaded",
      "some sources give only a magnet",
    );
    assert.equal(heldFor(held, "b".repeat(40), null).state, "none");
    assert.equal(heldFor(held, null, null).state, "none");
    assert.equal(heldFor(new Map(), HASH, null).state, "none");
  });

  // ── (2) Delete must remove the folders it made ──────────────────────────
  //
  // The upward walk starts at the torrent's `savePath`, but a multi-file
  // torrent creates its own folder BELOW that. After the files go, that folder
  // is left empty — and it also makes `savePath` look non-empty, so the upward
  // walk stops having removed nothing. Measured: `Games/Some Repack/` survived
  // a delete that reported success.
  check("an empty release folder below savePath is removed", () => {
    withScratchDirSync("prune-below", (base) => {
      const root = path.join(base, "root");
      const category = path.join(root, "Games");
      const release = path.join(category, "Some Repack");
      fs.mkdirSync(path.join(release, "data"), { recursive: true });

      // Upward-only is the old behaviour, and it does nothing here.
      const upOnly = pruneEmptyParents(category, root);
      assert.equal(upOnly.removed.length, 0, "precondition: upward alone is blind to it");
      assert.ok(fs.existsSync(release));

      pruneEmptyDescendants(category, root);
      pruneEmptyParents(category, root);
      assert.equal(fs.existsSync(release), false, "the empty release folder must go");
      assert.equal(fs.existsSync(category), false, "and the category it emptied");
    });
  });

  check("a folder that still holds anything is never removed", () => {
    // The dangerous direction. `rmdir` refuses non-empty directories, and this
    // asserts the guarantee rather than trusting it.
    withScratchDirSync("prune-keep", (base) => {
      const root = path.join(base, "root");
      const category = path.join(root, "Games");
      const empty = path.join(category, "Gone");
      const kept = path.join(category, "Still Here");
      fs.mkdirSync(empty, { recursive: true });
      fs.mkdirSync(kept, { recursive: true });
      fs.writeFileSync(path.join(kept, "game.bin"), "x");

      pruneEmptyDescendants(category, root);
      pruneEmptyParents(category, root);

      assert.equal(fs.existsSync(empty), false, "the empty sibling goes");
      assert.equal(
        fs.readFileSync(path.join(kept, "game.bin"), "utf8"),
        "x",
        "the occupied sibling and its file survive untouched",
      );
      assert.ok(fs.existsSync(category), "and so does the folder holding it");
    });
  });

  check("pruning refuses to walk outside the download root", () => {
    withScratchDirSync("prune-escape", (base) => {
      const root = path.join(base, "root");
      const outside = path.join(base, "outside");
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });

      const r = pruneEmptyDescendants(outside, root);
      assert.deepEqual(r.removed, []);
      assert.ok(fs.existsSync(outside), "a path outside the root is left alone");
      assert.match(r.reason ?? "", /outside/i);
    });
  });

  check("pruning never removes the download root itself", () => {
    withScratchDirSync("prune-root", (base) => {
      const root = path.join(base, "root");
      fs.mkdirSync(root, { recursive: true });
      pruneEmptyDescendants(root, root);
      pruneEmptyParents(root, root);
      assert.ok(fs.existsSync(root), "the root must survive being empty");
    });
  });

  if (failures > 0) {
    console.error(`held-releases.test.ts: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("held-releases.test.ts: all assertions passed");
}

main();
