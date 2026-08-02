/**
 * The scope-bucketing rule, tested without a database.
 *
 * Run: npx tsx "src/app/api/title/[workKey]/acquisition-scopes.test.ts"
 *
 * Table-driven over the row shapes the writer actually produces, because the
 * defect being pinned here was invisible to every existing test: it lived in a
 * Prisma `where` clause (`scope: "episode"`), and a `where` clause has no
 * offline surface to assert against. Extracting the decision is what makes
 * these cases possible at all.
 */
import assert from "node:assert/strict";
import { bucketTargetsByScope, episodeTargetKey } from "./acquisition-scopes";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
  }
}

type Row = {
  id: string;
  scope: string;
  season: number | null;
  episode: number | null;
};

const row = (over: Partial<Row> & { id: string }): Row => ({
  scope: "episode",
  season: 1,
  episode: 1,
  ...over,
});

check("every scope the writer produces is read back", () => {
  // The regression in one assertion: all three scopes must survive. When the
  // route filtered to `scope: "episode"`, title and season grabs vanished and
  // the page offered Download for a torrent already in flight.
  const buckets = bucketTargetsByScope([
    row({ id: "t", scope: "title", season: null, episode: null }),
    row({ id: "s", scope: "season", season: 2, episode: null }),
    row({ id: "e", scope: "episode", season: 2, episode: 5 }),
  ]);

  assert.equal(buckets.title?.id, "t");
  assert.equal(buckets.seasons.get(2)?.id, "s");
  assert.equal(buckets.episodes.get(episodeTargetKey(2, 5))?.id, "e");
  assert.equal(buckets.malformed.length, 0);
});

check("scopes never bleed into one another", () => {
  const buckets = bucketTargetsByScope([
    row({ id: "s", scope: "season", season: 3, episode: null }),
  ]);
  // A season grab is not a claim about the work...
  assert.equal(buckets.title, null);
  // ...nor about any episode inside it. Copying season progress onto episode
  // rows is how a pack at 40% starts claiming episode 3 is 40% ready.
  assert.equal(buckets.episodes.size, 0);
  assert.equal(buckets.seasons.size, 1);
});

check("an episode target claims only its own row", () => {
  const buckets = bucketTargetsByScope([
    row({ id: "e", scope: "episode", season: 1, episode: 4 }),
  ]);
  assert.equal(buckets.episodes.get(episodeTargetKey(1, 4))?.id, "e");
  // The sibling is untouched — no "the season is downloading" by inference.
  assert.equal(buckets.episodes.get(episodeTargetKey(1, 5)), undefined);
  assert.equal(buckets.seasons.get(1), undefined);
  assert.equal(buckets.title, null);
});

check("newest wins, for every scope", () => {
  // The route queries `orderBy: updatedAt desc`, so the first row seen is the
  // current one. An older duplicate overwriting it would resurrect a finished
  // download as `queued`.
  const buckets = bucketTargetsByScope([
    row({ id: "new-t", scope: "title", season: null, episode: null }),
    row({ id: "old-t", scope: "title", season: null, episode: null }),
    row({ id: "new-s", scope: "season", season: 1, episode: null }),
    row({ id: "old-s", scope: "season", season: 1, episode: null }),
    row({ id: "new-e", scope: "episode", season: 1, episode: 1 }),
    row({ id: "old-e", scope: "episode", season: 1, episode: 1 }),
  ]);
  assert.equal(buckets.title?.id, "new-t");
  assert.equal(buckets.seasons.get(1)?.id, "new-s");
  assert.equal(buckets.episodes.get(episodeTargetKey(1, 1))?.id, "new-e");
});

check("a row whose scope and columns disagree is never widened", () => {
  const cases: { why: string; input: Row }[] = [
    {
      why: "episode scope with no episode names no row",
      input: row({ id: "a", scope: "episode", season: 1, episode: null }),
    },
    {
      why: "episode scope with no season names no row",
      input: row({ id: "b", scope: "episode", season: null, episode: 3 }),
    },
    {
      why: "season scope with no season names no season",
      input: row({ id: "c", scope: "season", season: null, episode: null }),
    },
    {
      why: "season scope carrying an episode contradicts itself",
      input: row({ id: "d", scope: "season", season: 1, episode: 2 }),
    },
    {
      why: "title scope carrying a season contradicts itself",
      input: row({ id: "e", scope: "title", season: 1, episode: null }),
    },
    {
      why: "an unknown scope means nothing yet",
      input: row({ id: "f", scope: "collection", season: null, episode: null }),
    },
  ];

  for (const c of cases) {
    const buckets = bucketTargetsByScope([c.input]);
    assert.equal(buckets.malformed.length, 1, c.why);
    assert.equal(buckets.malformed[0].id, c.input.id, c.why);
    // The point of the rule: a broken row becomes *nothing*, not a broader
    // claim. Widening is how "one episode queued" becomes "series queued".
    assert.equal(buckets.title, null, c.why);
    assert.equal(buckets.seasons.size, 0, c.why);
    assert.equal(buckets.episodes.size, 0, c.why);
  }
});

check("a malformed row does not discard the good ones beside it", () => {
  const buckets = bucketTargetsByScope([
    row({ id: "bad", scope: "season", season: null, episode: null }),
    row({ id: "good", scope: "episode", season: 1, episode: 1 }),
  ]);
  assert.equal(buckets.malformed.length, 1);
  assert.equal(buckets.episodes.get(episodeTargetKey(1, 1))?.id, "good");
});

check("no rows means no claims", () => {
  const buckets = bucketTargetsByScope([]);
  assert.equal(buckets.title, null);
  assert.equal(buckets.seasons.size, 0);
  assert.equal(buckets.episodes.size, 0);
  assert.equal(buckets.malformed.length, 0);
});

if (failures > 0) {
  console.error(`\n${failures} acquisition-scope test(s) failed.`);
  process.exit(1);
}
console.log("\nAll acquisition-scope tests passed.");
