/**
 * Active download row wording.
 *
 * Run: npx tsx src/components/tf/active-row-state.test.ts
 *
 * The cases worth writing are the ones where a plausible number lies: a
 * rounded 100% on an incomplete file, a zero speed presented as a measurement,
 * or the client's own vocabulary leaking through as an apparent error.
 */
import assert from "node:assert/strict";
import {
  activityLabel,
  progressPercent,
  speedLabel,
  stateLabel,
} from "./active-row-state";

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

check("an almost-finished file never rounds up to 100%", () => {
  assert.equal(
    progressPercent(0.996),
    99,
    "100% on a file still being written sends someone to open it",
  );
  assert.equal(progressPercent(0.999999), 99);
  assert.equal(progressPercent(1), 100);
});

check("a barely-started file is not floored away into nothing visible", () => {
  assert.equal(progressPercent(0.00068), 0);
  assert.equal(progressPercent(0.011), 1);
});

check("junk progress reads as zero rather than NaN%", () => {
  for (const bad of [NaN, Infinity, -1, -0.5]) {
    assert.equal(progressPercent(bad), 0, `for ${bad}`);
  }
  assert.equal(progressPercent(5), 100, "over-unity clamps rather than lies");
});

check("no speed is absent, not zero", () => {
  assert.equal(
    speedLabel(0),
    null,
    "'0 B/s' reads as a measurement of failure; the absence of one is the truth",
  );
  assert.equal(speedLabel(-5), null);
  assert.equal(speedLabel(NaN), null);
});

check("speed scales into units a person reads", () => {
  assert.equal(speedLabel(512), "512 B/s");
  assert.equal(speedLabel(1536), "1.5 KB/s");
  assert.equal(speedLabel(5 * 1024 * 1024), "5 MB/s");
});

check("the client's vocabulary never reaches the user", () => {
  // stalledDL is the dangerous one: it reads as an error and means only
  // "no peers right now", which usually resolves itself.
  assert.equal(stateLabel("stalledDL"), "Looking for peers");
  assert.equal(stateLabel("metaDL"), "Finding files");
  assert.equal(stateLabel("queuedDL"), "Queued");
  assert.equal(stateLabel("checkingDL"), "Checking");
  assert.equal(stateLabel("allocating"), "Preparing");
  for (const raw of ["stalledDL", "metaDL", "queuedDL", "allocating"]) {
    assert.ok(
      !/DL|stalled|alloc/i.test(stateLabel(raw)),
      `raw client word leaked for ${raw}`,
    );
  }
});

check("an unknown state is described as downloading, not as unknown", () => {
  assert.equal(stateLabel("someNewQbitState"), "Downloading");
  assert.equal(stateLabel(""), "Downloading");
});

check("a moving download states progress and speed", () => {
  assert.equal(
    activityLabel({ progress: 0.41, dlspeed: 2 * 1024 * 1024, state: "downloading" }),
    "Downloading 41% · 2 MB/s",
  );
});

check("a stopped download omits the speed rather than printing zero", () => {
  assert.equal(
    activityLabel({ progress: 0.41, dlspeed: 0, state: "stalledDL" }),
    "Looking for peers 41%",
  );
});

check("a torrent with nothing yet reports its phase, not 0%", () => {
  // "Finding files 0%" reads as stalled at nothing. There is simply no
  // progress to report until there are files to measure.
  assert.equal(
    activityLabel({ progress: 0, dlspeed: 0, state: "metaDL" }),
    "Finding files",
  );
  assert.equal(
    activityLabel({ progress: 0, dlspeed: 0, state: "queuedDL" }),
    "Queued",
  );
});

check("a running download at zero still says zero, because it has started", () => {
  // The distinction matters: queued means not begun, downloading at 0% means
  // begun and not yet productive. Collapsing them hides a stuck transfer.
  assert.equal(
    activityLabel({ progress: 0, dlspeed: 0, state: "downloading" }),
    "Downloading 0%",
  );
});

if (failures) {
  console.error(`\n${failures} active-row test(s) failed.`);
  process.exit(1);
}
console.log("\nAll active-row state tests passed.");
