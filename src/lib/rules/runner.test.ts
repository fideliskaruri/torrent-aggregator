/**
 * An auto-rule runs unattended and writes to disk, so "the indexer returned it
 * under that category" is not good enough. Both cases below actually happened:
 * a rule named "Weekly anime, 1080p" grabbed Silo, and a "4K movies" rule
 * grabbed a Silo episode.
 */
import assert from "node:assert/strict";
import { matchesRuleCategory } from "./runner";

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

const silo = {
  title: "Silo S03E02 Its All Good 1080p ATVP WEB-DL DDP5 1 H 264-NTb",
  source: "torrentscsv" as const,
};

const frierenOnNyaa = {
  title:
    "[Yameii] Frieren - Beyond Journey's End - S01E09 [English Dub] [CR WEB-DL 1080p]",
  source: "nyaa" as const,
};

const duneMovie = {
  title: "Dune Part Two (2024) [1080p] [BluRay]",
  source: "yts" as const,
};

async function main() {
  console.log("rules/runner category guard");

  check("an anime rule rejects a live-action TV episode", () => {
    assert.equal(matchesRuleCategory(silo, "anime"), false);
  });

  check("a movies rule rejects a TV episode", () => {
    assert.equal(matchesRuleCategory(silo, "movies"), false);
  });

  check("a tv rule accepts a TV episode", () => {
    assert.equal(matchesRuleCategory(silo, "tv"), true);
  });

  check("an anime rule accepts an anime episode", () => {
    assert.equal(matchesRuleCategory(frierenOnNyaa, "anime"), true);
  });

  check("a movies rule accepts a movie", () => {
    assert.equal(matchesRuleCategory(duneMovie, "movies"), true);
  });

  check("a tv rule accepts anime — an episodic request, loosely read", () => {
    assert.equal(matchesRuleCategory(frierenOnNyaa, "tv"), true);
  });

  check("an all/unknown-category rule accepts anything", () => {
    assert.equal(matchesRuleCategory(silo, "all"), true);
    assert.equal(matchesRuleCategory(silo, null), true);
  });

  check("the rule's own category is not used as evidence for itself", () => {
    // If the rule category leaked in as a searchCategory hint, an anime rule
    // would classify every unstructured release as anime and accept it.
    assert.equal(
      matchesRuleCategory(
        { title: "Some Unstructured Release 1080p", source: "apibay" as const },
        "anime",
      ),
      false,
    );
  });

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
