/**
 * A link saved before the release-suffix cleanup must still open its work.
 *
 * The cleanup changed what `workIdentityFor` produces for YIFY/YTS-shaped
 * names, and that value is the *persisted* key: `Work.workKey`,
 * `AcquisitionTarget.targetKey` (which embeds it), `CatalogEntry.workKey`, and
 * whatever the user bookmarked. Rows written before the fix say
 * `ninja-assassin-1-4gb-yify-2009`; everything written after says
 * `ninja-assassin-2009`.
 *
 * Nothing rewrites those rows. A migration would have to decide that two
 * `Work` rows are the same work and merge them, and a wrong merge cannot be
 * undone. The read path accepts the old spelling instead, so the old link
 * lands on the same page and the stale row simply stops being pointed at.
 *
 * These tests cover the resolution rule itself — the one funnel
 * (`workKeyMatches`) that `detail.ts` uses for watchlist rows, engine
 * torrents, catalog rows and cached releases alike.
 */
import assert from "node:assert/strict";
import {
  acquisitionTargetKey,
} from "@/app/api/title/[workKey]/acquisition-target";
import {
  workKeyAliases,
  workKeyForRelease,
  workKeyMatches,
} from "@/components/title/work-key";
import { workIdentityFor } from "@/components/title/work-key";

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

/** The key this release produced *before* the cleanup landed. */
const LEGACY_KEY = "ninja-assassin-1-4gb-yify-2009";
const CURRENT_KEY = "ninja-assassin-2009";
const RELEASE = "Ninja Assassin (2009) 1080p BrRip x264 - 1.4GB - YIFY";

console.log("legacy work keys: saved links keep working…");

check("the release now keys the new way", () => {
  assert.equal(workKeyForRelease(RELEASE), CURRENT_KEY);
});

check("an old bookmark resolves the same releases as the new key", () => {
  // This is exactly what detail.ts does for every EngineTorrent row: compute
  // the identity from the stored release name, then ask whether it answers to
  // the key in the URL.
  const identity = workIdentityFor(RELEASE);
  assert.equal(workKeyMatches(CURRENT_KEY, identity.name, identity.year), true);
  assert.equal(
    workKeyMatches(LEGACY_KEY, identity.name, identity.year),
    true,
    "a link saved under the old key must not silently show an empty page",
  );
});

check("an old watchlist row (no year) resolves from either key", () => {
  assert.equal(workKeyMatches(LEGACY_KEY, "Ninja Assassin", null), true);
  assert.equal(workKeyMatches(CURRENT_KEY, "Ninja Assassin", null), true);
});

check("an old catalog row keyed by title+year resolves from either key", () => {
  assert.equal(workKeyMatches(LEGACY_KEY, "Ninja Assassin", 2009), true);
  assert.equal(workKeyMatches(CURRENT_KEY, "Ninja Assassin", 2009), true);
});

check("an in-flight acquisition target keyed the old way is still addressable", () => {
  // AcquisitionTarget.targetKey embeds the work key verbatim, so a row written
  // before the fix reads `<legacy>:title:-:-`. The two target keys differ —
  // that is unavoidable without rewriting data — but both resolve to the same
  // work, so the page can recognise the row rather than treating it as another
  // title's download.
  const legacyTarget = acquisitionTargetKey(LEGACY_KEY, "title", null, null);
  const currentTarget = acquisitionTargetKey(CURRENT_KEY, "title", null, null);
  assert.notEqual(legacyTarget, currentTarget);
  const [legacyWork] = legacyTarget.split(":");
  assert.ok(
    workKeyAliases(legacyWork).includes(CURRENT_KEY),
    "the legacy target's work key must alias to the current one",
  );
});

console.log("\n…without merging anything it should not merge");

check("the alias never reaches a different work", () => {
  assert.equal(workKeyMatches(LEGACY_KEY, "The Matrix", 1999), false);
  assert.equal(workKeyMatches(LEGACY_KEY, "Ninja Assassin 2", 2009), false);
  assert.equal(workKeyMatches("children-of-dune", "Dune", 2021), false);
});

check("the year still separates two films that share a name", () => {
  assert.equal(workKeyMatches("dune-1-5gb-yify-1984", "Dune", 1984), true);
  assert.equal(workKeyMatches("dune-1-5gb-yify-1984", "Dune", 2021), false);
  assert.equal(workKeyMatches("dune-1-9gb-yify-2021", "Dune", 1984), false);
});

check("a current key is untouched — no second spelling is invented", () => {
  for (const key of [
    CURRENT_KEY,
    "blade-runner-2049",
    "breaking-bad",
    "children-of-dune",
    "dune-prophecy",
    "fahrenheit-451",
  ]) {
    assert.deepEqual(workKeyAliases(key), [key], `${key} must not be rewritten`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll legacy work key tests passed.");
