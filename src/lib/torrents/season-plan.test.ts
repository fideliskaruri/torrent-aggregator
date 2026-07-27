/**
 * Season acquisition planner tests — pure, no swarm, no DB.
 *
 * The whole point of making `planSeason` pure is that the acquisition matrix is
 * testable off a table of fixtures and a `verdictOf` closure. Each case here
 * was proven RED first by inverting the exact thing it guards (see the notes on
 * each), so a passing run means the property, not the ceremony.
 *
 * Run: node node_modules/tsx/dist/cli.mjs src/lib/torrents/season-plan.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { planSeason, packEpisodeRange } from "./season-plan";
import type { SwarmVerdict } from "./swarm-probe";
import type { TorrentResult } from "./types";

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

function result(over: Partial<TorrentResult> & { title: string }): TorrentResult {
  const hash = over.infoHash ?? createHash("sha1").update(randomUUID()).digest("hex");
  return {
    id: randomUUID(),
    magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(over.title)}`,
    infoHash: hash,
    sizeBytes: 1_400_000_000,
    seeders: 30,
    leechers: 3,
    source: "apibay",
    sourceUrl: "https://example.invalid",
    tags: [],
    ...over,
  } as TorrentResult;
}

/** Build a verdictOf from a title→verdict table; anything unlisted is unknown. */
function verdicts(table: Record<string, SwarmVerdict>) {
  return (r: TorrentResult): SwarmVerdict => table[r.title] ?? "unknown";
}

function main(): void {
  console.log("season acquisition planner\n");

  // ── packEpisodeRange ──────────────────────────────────────────────────────
  check("packEpisodeRange reads SxxEyy-Ezz ranges the single-parse hides", () => {
    // parseEpisode("S01E01-E08") returns single E01; the range must be seen.
    assert.deepEqual(packEpisodeRange("The Show S01E01-E08 1080p"), { from: 1, to: 8 });
    assert.deepEqual(packEpisodeRange("The Show S01 E01-08 WEB"), { from: 1, to: 8 });
    assert.deepEqual(packEpisodeRange("The Show Episodes 1-8"), { from: 1, to: 8 });
  });

  check("packEpisodeRange refuses a bare number span (date/codec, not episodes)", () => {
    // RED check: dropping the E/Ep marker requirement made "2019-2021" parse
    // as episodes 2019..2021 and over-claim the whole season.
    assert.equal(packEpisodeRange("The Show 2019-2021 Complete"), null);
    assert.equal(packEpisodeRange("The Show S01E05"), null);
  });

  // ── 1. A good pack covering the whole season wins outright ────────────────
  check("a good full-season pack takes the season alone", () => {
    const pack = result({ title: "The Show S01 COMPLETE 1080p", seeders: 12 });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2, 3],
      releases: [pack],
      verdictOf: verdicts({ "The Show S01 COMPLETE 1080p": "good" }),
    });
    assert.ok(plan.pack, "expected a pack");
    assert.equal(plan.pack!.release.title, "The Show S01 COMPLETE 1080p");
    assert.deepEqual(plan.singles, []);
    assert.deepEqual(plan.covered, [1, 2, 3]);
    assert.deepEqual(plan.missing, []);
    assert.equal(plan.coverageLabel, "3 of 3 episodes");
  });

  // ── The headline failure: advertised numbers must lose to measurement ─────
  check("advertised-40 dead pack loses to advertised-12 good pack", () => {
    // Ranker order puts the 40-seeder pack first; the verdict must override it.
    const dead = result({ title: "The Show S01 COMPLETE HUGESWARM", seeders: 40 });
    const good = result({ title: "The Show S01 COMPLETE realpeers", seeders: 12 });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2],
      releases: [dead, good],
      verdictOf: verdicts({
        "The Show S01 COMPLETE HUGESWARM": "dead",
        "The Show S01 COMPLETE realpeers": "good",
      }),
    });
    assert.ok(plan.pack);
    assert.equal(plan.pack!.release.title, "The Show S01 COMPLETE realpeers");
    assert.equal(plan.pack!.verdict, "good");
  });

  // ── 3. Fall back to per-episode singles when the only pack is dead ────────
  check("a dead pack loses to good singles (assemble the season)", () => {
    const pack = result({ title: "The Show S01 COMPLETE", seeders: 40 });
    const e1 = result({ title: "The Show S01E01 1080p", seeders: 20 });
    const e2 = result({ title: "The Show S01E02 1080p", seeders: 20 });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2],
      releases: [pack, e1, e2],
      verdictOf: verdicts({
        "The Show S01 COMPLETE": "dead",
        "The Show S01E01 1080p": "good",
        "The Show S01E02 1080p": "good",
      }),
    });
    // The dead pack must not be the primary choice when singles cover the season.
    assert.equal(plan.pack, null);
    assert.deepEqual(
      plan.singles.map((s) => s.episode),
      [1, 2],
    );
    assert.deepEqual(plan.covered, [1, 2]);
    assert.deepEqual(plan.missing, []);
  });

  // ── 4. Hybrid: a partial pack + gap-filling singles, no double-grab ───────
  check("partial pack plus gap-filling singles, and never a double-grab", () => {
    const pack = result({ title: "The Show S01E01-E08 1080p WEB", seeders: 25 });
    const e1 = result({ title: "The Show S01E01 720p", seeders: 15 });
    const e9 = result({ title: "The Show S01E09 1080p", seeders: 15 });
    const e10 = result({ title: "The Show S01E10 1080p", seeders: 15 });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      releases: [pack, e1, e9, e10],
      verdictOf: verdicts({
        "The Show S01E01-E08 1080p WEB": "good",
        "The Show S01E09 1080p": "good",
        "The Show S01E10 1080p": "good",
      }),
    });
    assert.ok(plan.pack);
    assert.deepEqual(plan.pack!.covers, [1, 2, 3, 4, 5, 6, 7, 8]);
    // The E01 single must NOT be grabbed — the pack already covers episode 1.
    assert.deepEqual(
      plan.singles.map((s) => s.episode),
      [9, 10],
    );
    assert.deepEqual(plan.covered, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(plan.missing, []);
    assert.equal(plan.coverageLabel, "10 of 10 episodes");
  });

  // ── 5. Honest partial coverage ────────────────────────────────────────────
  check("reports a real partial-season coverage honestly", () => {
    const pack = result({ title: "The Show S01E01-E08 1080p", seeders: 25 });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      releases: [pack],
      verdictOf: verdicts({ "The Show S01E01-E08 1080p": "good" }),
    });
    assert.deepEqual(plan.covered, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(plan.missing, [9, 10]);
    assert.equal(plan.coverageLabel, "8 of 10 episodes");
  });

  check("nothing available is reported honestly, not as success", () => {
    const plan = planSeason({
      season: 1,
      wanted: [1, 2, 3],
      releases: [],
      verdictOf: () => "unknown",
    });
    assert.equal(plan.pack, null);
    assert.deepEqual(plan.singles, []);
    assert.deepEqual(plan.covered, []);
    assert.deepEqual(plan.missing, [1, 2, 3]);
    assert.equal(plan.coverageLabel, "0 of 3 episodes");
  });

  // ── Invariant: unknown is not dead — a cold cache still acquires ──────────
  check("an unmeasured (unknown) pack is still eligible and taken as primary", () => {
    // RED check: if the primary-pack gate required verdict==="good", this
    // (all-unknown, cold cache) would not take the pack as primary. The good
    // E01 single proves it: when the unknown pack is primary it covers E01 and
    // no single is grabbed (no double-grab); if the pack were demoted out of
    // the primary path the E01 single would be taken alongside it.
    const pack = result({ title: "The Show S01 COMPLETE", seeders: 30 });
    const e1 = result({ title: "The Show S01E01 1080p", seeders: 20 });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2, 3],
      releases: [pack, e1],
      verdictOf: verdicts({ "The Show S01E01 1080p": "good" }),
    });
    assert.ok(plan.pack, "an unknown pack must remain eligible");
    assert.equal(plan.pack!.verdict, "unknown");
    assert.deepEqual(plan.singles, [], "pack is primary, so no gap-filling single");
    assert.deepEqual(plan.covered, [1, 2, 3]);
  });

  check("a good pack beats an unknown pack of the same fit", () => {
    const unknown = result({ title: "The Show S01 COMPLETE first", seeders: 50 });
    const good = result({ title: "The Show S01 COMPLETE second", seeders: 10 });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2],
      releases: [unknown, good],
      verdictOf: verdicts({ "The Show S01 COMPLETE second": "good" }),
    });
    assert.equal(plan.pack!.release.title, "The Show S01 COMPLETE second");
  });

  // ── Demote-never-filter for packs: the only release must stay reachable ───
  check("a dead pack is still offered when it is the only release", () => {
    // No singles exist; the dead pack is the sole way to get the season. It
    // must be offered (demote, never filter) rather than the season reported
    // entirely missing.
    const pack = result({ title: "The Show S01 COMPLETE", seeders: 40 });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2, 3],
      releases: [pack],
      verdictOf: verdicts({ "The Show S01 COMPLETE": "dead" }),
    });
    assert.ok(plan.pack, "the only release must remain reachable even when dead");
    assert.equal(plan.pack!.verdict, "dead");
    assert.deepEqual(plan.covered, [1, 2, 3]);
    assert.deepEqual(plan.missing, []);
  });

  check("a weak single is taken when it is the only release for an episode", () => {
    const e1 = result({ title: "The Show S01E01", seeders: 5 });
    const plan = planSeason({
      season: 1,
      wanted: [1],
      releases: [e1],
      verdictOf: verdicts({ "The Show S01E01": "weak" }),
    });
    assert.deepEqual(
      plan.singles.map((s) => s.episode),
      [1],
    );
    assert.equal(plan.singles[0].verdict, "weak");
    assert.deepEqual(plan.missing, []);
  });

  // ── Fit: prefer the tightest pack for the wanted season ───────────────────
  check("a single-season pack beats a good complete-series pack", () => {
    const complete = result({ title: "The Show COMPLETE SERIES S01-S05", seeders: 50 });
    const single = result({ title: "The Show S01 season pack", seeders: 20 });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2],
      releases: [complete, single],
      verdictOf: verdicts({
        "The Show COMPLETE SERIES S01-S05": "good",
        "The Show S01 season pack": "unknown",
      }),
    });
    // Even though the complete pack is measured good and listed first, a single
    // season the user asked for is the right amount of bytes.
    assert.equal(plan.pack!.release.title, "The Show S01 season pack");
    assert.equal(plan.pack!.fit, "single-season");
  });

  // ── Usability gate ────────────────────────────────────────────────────────
  check("zero-seeder and magnet-less releases are not candidates", () => {
    const noSeed = result({ title: "The Show S01E01", seeders: 0 });
    const noMagnet = result({ title: "The Show S01E02", magnet: undefined, infoHash: undefined });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2],
      releases: [noSeed, noMagnet],
      verdictOf: () => "good",
    });
    assert.equal(plan.pack, null);
    assert.deepEqual(plan.singles, []);
    assert.deepEqual(plan.missing, [1, 2]);
  });

  // ── Wrong-season releases are ignored ─────────────────────────────────────
  check("a pack for a different season does not cover this one", () => {
    const other = result({ title: "The Show S02 COMPLETE", seeders: 40 });
    const plan = planSeason({
      season: 1,
      wanted: [1, 2],
      releases: [other],
      verdictOf: () => "good",
    });
    assert.equal(plan.pack, null);
    assert.deepEqual(plan.missing, [1, 2]);
  });

  console.log(
    failures === 0
      ? "\nPASS — season planner favours measured packs, falls back to singles, never double-grabs"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

main();
