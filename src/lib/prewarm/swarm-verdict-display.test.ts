/**
 * Swarm verdict display tests.
 *
 * WHAT THESE ARE GUARDING
 * -----------------------
 * The settings surface shows what the pre-probe has actually measured. The one
 * rule that must never bend is that **"not measured" is not "measured and
 * poor"** — `unknown` (no evidence, or a measurement gone stale) must read
 * visibly differently from `dead` (a swarm we watched deliver nothing). These
 * assert that distinction directly, plus that a stale row is never presented as
 * a current fact.
 *
 * Run: node node_modules/tsx/dist/cli.mjs src/lib/prewarm/swarm-verdict-display.test.ts
 */
import assert from "node:assert/strict";
import {
  verdictDisplay,
  relativeAge,
  freshnessLabel,
} from "./swarm-verdict-display";

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

function main(): void {
  console.log("swarm verdict display\n");

  check("unknown reads neutral, never the bad tone", () => {
    // RED check: collapsing unknown into `dead` (bad) would make an unmeasured
    // swarm look broken — absence of evidence rendered as evidence of absence.
    const d = verdictDisplay("unknown", false);
    assert.equal(d.tone, "neutral", "unknown must not be a bad verdict");
    assert.notEqual(d.tone, "bad");
    assert.equal(d.label, "Not measured");
  });

  check("dead reads as the bad tone — measured and poor", () => {
    // RED check: `dead` is a claim backed by evidence (peers, zero bytes); it
    // must be visibly distinct from the neutral `unknown`.
    const d = verdictDisplay("dead", false);
    assert.equal(d.tone, "bad");
    assert.notEqual(d.tone, "neutral", "a measured-poor swarm is not 'not measured'");
  });

  check("good and weak are distinct, non-bad tones", () => {
    assert.equal(verdictDisplay("good", false).tone, "good");
    assert.equal(verdictDisplay("weak", false).tone, "weak");
    assert.notEqual(verdictDisplay("weak", false).tone, "bad");
  });

  check("an expired measurement is never presented as current", () => {
    // RED check: honouring the raw verdict when expired would show a 6h-old
    // `good` as if the swarm were healthy right now. Stale means unknown.
    const stale = verdictDisplay("good", true);
    assert.equal(stale.tone, "neutral", "a stale verdict is no longer evidence");
    assert.equal(stale.label, "Not measured");
    // And a stale `dead` must not harden into a permanent bad verdict either.
    assert.equal(verdictDisplay("dead", true).tone, "neutral");
  });

  check("relativeAge buckets minutes, hours and days", () => {
    const now = 1_000_000_000_000;
    assert.equal(relativeAge(now - 30_000, now), "just now");
    assert.equal(relativeAge(now - 5 * 60_000, now), "5m ago");
    assert.equal(relativeAge(now - 2 * 60 * 60_000, now), "2h ago");
    assert.equal(relativeAge(now - 3 * 24 * 60 * 60_000, now), "3d ago");
    // Never negative for a clock skew where measuredAt is slightly ahead.
    assert.equal(relativeAge(now + 10_000, now), "just now");
  });

  check("freshnessLabel marks stale rows and only stale rows", () => {
    // RED check: dropping the stale suffix would let the UI present a cached
    // measurement as current fact.
    const now = 1_000_000_000_000;
    assert.equal(freshnessLabel(now - 2 * 60 * 60_000, false, now), "checked 2h ago");
    assert.equal(freshnessLabel(now - 2 * 60 * 60_000, true, now), "checked 2h ago · stale");
  });

  console.log(
    failures === 0
      ? "\nPASS — unknown stays neutral, dead stays bad, stale never reads current"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

main();
