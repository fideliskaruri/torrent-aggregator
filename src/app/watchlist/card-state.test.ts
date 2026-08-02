/**
 * Library card state rules.
 *
 * Run: npx tsx src/app/watchlist/card-state.test.ts
 *
 * The cases worth writing are the ones where a plausible-looking answer is
 * wrong: reporting the hunt cursor as the viewer's position, announcing
 * "Tracking" on a show that finished, or highlighting every monitored row
 * until the highlight means nothing.
 */
import assert from "node:assert/strict";
import {
  activityLine,
  formatEpisode,
  needsAttention,
  positionLine,
  type LibraryCardRow,
} from "./card-state";

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

const row = (over: Partial<LibraryCardRow> = {}): LibraryCardRow => ({
  status: "watching",
  monitored: true,
  cursorSeason: null,
  cursorEpisode: null,
  lastEpisode: null,
  nextEpisodeHint: null,
  ...over,
});

check("formatEpisode pads, truncates, and refuses half-known input", () => {
  assert.equal(formatEpisode(1, 1), "S01E01");
  assert.equal(formatEpisode(12, 7), "S12E07");
  assert.equal(formatEpisode(2026, 143), "S2026E143");
  // Half an answer is not an answer.
  assert.equal(formatEpisode(1, null), null);
  assert.equal(formatEpisode(null, 1), null);
  assert.equal(formatEpisode(undefined, undefined), null);
  assert.equal(formatEpisode(Number.NaN, 1), null);
  assert.equal(formatEpisode(Infinity, 2), null);
});

check("position is where the viewer is, not where the hunt is", () => {
  // The cursor names the episode the app is *looking for*, one ahead of the
  // viewer. Reporting it as position tells someone who just finished S02E06
  // that they are on an episode they have not seen and that may not exist.
  const r = row({ lastEpisode: "S02E06", cursorSeason: 2, cursorEpisode: 7 });
  assert.equal(positionLine(r), "S02E06");
});

check("a tracked show with nothing held says what it is waiting for", () => {
  assert.equal(
    positionLine(row({ cursorSeason: 1, cursorEpisode: 1 })),
    "Waiting for S01E01",
  );
  // Not "S01E01" on its own - that would claim a position the user never had.
  assert.notEqual(positionLine(row({ cursorSeason: 1, cursorEpisode: 1 })), "S01E01");
});

check("nothing known means no line, not an empty one", () => {
  assert.equal(positionLine(row()), null);
  assert.equal(positionLine(row({ lastEpisode: "   " })), null);
});

check("a found release outranks everything else", () => {
  const r = row({
    monitored: true,
    nextEpisodeHint: "New episode S03E01",
    cursorSeason: 3,
    cursorEpisode: 1,
  });
  assert.deepEqual(activityLine(r), { kind: "update", text: "New episode S03E01" });
  assert.equal(needsAttention(r), true);
});

check("a finished show is not waiting for anything", () => {
  // "Tracking" on a completed show is the app talking about itself. There is
  // nothing the user can do with it.
  for (const status of ["completed", "dropped"]) {
    assert.equal(activityLine(row({ status, monitored: true })), null, status);
    assert.equal(activityLine(row({ status, monitored: false })), null, status);
  }
});

check("a finished show still reports a real release", () => {
  // Completed does not mean deaf: if automation found something, say so.
  assert.deepEqual(
    activityLine(row({ status: "completed", nextEpisodeHint: "New episode S04E01" })),
    { kind: "update", text: "New episode S04E01" },
  );
});

check("tracking is stated quietly, and names what is next when known", () => {
  assert.deepEqual(activityLine(row({ monitored: true })), {
    kind: "tracking",
    text: "Tracking",
  });
  assert.deepEqual(
    activityLine(row({ monitored: true, cursorSeason: 2, cursorEpisode: 4 })),
    { kind: "tracking", text: "Tracking · next S02E04" },
  );
});

check("a paused show says so, because silence is ambiguous", () => {
  // A row with no activity line and a row that has been switched off look
  // identical otherwise, and the second is a thing the user chose.
  assert.deepEqual(activityLine(row({ monitored: false })), {
    kind: "paused",
    text: "Not tracking",
  });
});

check("only news is highlighted", () => {
  // Highlighting every monitored row makes the highlight meaningless - the
  // mistake the old Activity feed made at page scale.
  assert.equal(needsAttention(row({ monitored: true })), false);
  assert.equal(
    needsAttention(row({ monitored: true, cursorSeason: 1, cursorEpisode: 2 })),
    false,
  );
  assert.equal(needsAttention(row({ monitored: false })), false);
  assert.equal(needsAttention(row({ status: "completed" })), false);
  assert.equal(needsAttention(row({ nextEpisodeHint: "New episode S01E02" })), true);
});

check("the two lines answer different questions and do not overlap", () => {
  const r = row({
    lastEpisode: "S02E06",
    cursorSeason: 2,
    cursorEpisode: 7,
    monitored: true,
  });
  const position = positionLine(r);
  const activity = activityLine(r);
  assert.equal(position, "S02E06");
  assert.equal(activity?.text, "Tracking · next S02E07");
  // Position is durable, activity is transient. If they ever print the same
  // string, one of them is redundant.
  assert.notEqual(position, activity?.text);
});

if (failures > 0) {
  console.error(`\n${failures} card-state test(s) failed.`);
  process.exit(1);
}
console.log("\nAll card-state tests passed.");
