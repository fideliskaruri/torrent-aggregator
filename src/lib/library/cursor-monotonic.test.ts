/**
 * The hunt cursor may only ever move forward.
 *
 * This exists because season downloads are no longer sequential. A season
 * fan-out searches several episodes at once and they finish in whatever order
 * the indexers answer, so E07 can land before E03. Each success asks the
 * library item to advance its cursor, and the naive "cursor = grabbed + 1"
 * would let the late E03 drag the cursor from S01E08 back to S01E04 — making
 * the automation re-hunt five episodes it already has.
 *
 * Run: npx tsx src/lib/library/cursor-monotonic.test.ts
 */
import assert from "node:assert/strict";
import { isForwardCursorMove } from "./ondemand";

interface Case {
  name: string;
  current: { season?: number | null; episode?: number | null };
  next: { season?: number | null; episode?: number | null };
  forward: boolean;
}

const cases: Case[] = [
  {
    name: "the next episode in the same season is forward",
    current: { season: 1, episode: 3 },
    next: { season: 1, episode: 4 },
    forward: true,
  },
  {
    name: "a jump ahead within the season is forward",
    current: { season: 1, episode: 3 },
    next: { season: 1, episode: 9 },
    forward: true,
  },
  {
    name: "the next season is forward even at a lower episode number",
    current: { season: 1, episode: 22 },
    next: { season: 2, episode: 1 },
    forward: true,
  },
  {
    name: "a late-finishing earlier episode must not drag the cursor back",
    current: { season: 1, episode: 8 },
    next: { season: 1, episode: 4 },
    forward: false,
  },
  {
    name: "an earlier season must not drag the cursor back",
    current: { season: 3, episode: 1 },
    next: { season: 2, episode: 20 },
    forward: false,
  },
  {
    name: "standing still is not forward — a duplicate settle is a no-op",
    current: { season: 2, episode: 5 },
    next: { season: 2, episode: 5 },
    forward: false,
  },
  {
    name: "an item with no cursor yet accepts the first position",
    current: { season: null, episode: null },
    next: { season: 4, episode: 2 },
    forward: true,
  },
  {
    name: "an unusable next position is never written",
    current: { season: 1, episode: 1 },
    next: { season: null, episode: null },
    forward: false,
  },
  {
    name: "garbage in the next position is never written",
    current: { season: 1, episode: 1 },
    next: { season: Number.NaN, episode: 3 },
    forward: false,
  },
];

for (const tc of cases) {
  assert.equal(isForwardCursorMove(tc.current, tc.next), tc.forward, tc.name);
}

// The property the whole guard exists for: replaying a season's successes in
// ANY completion order must leave the cursor exactly where the in-order replay
// leaves it. Applying only forward moves is what makes that true.
{
  const positions = [
    { season: 1, episode: 1 },
    { season: 1, episode: 2 },
    { season: 1, episode: 3 },
    { season: 1, episode: 4 },
    { season: 1, episode: 5 },
  ];
  const orders = [
    [0, 1, 2, 3, 4],
    [4, 3, 2, 1, 0],
    [2, 0, 4, 1, 3],
    [1, 1, 4, 0, 4, 2],
  ];
  for (const order of orders) {
    let cursor: { season: number | null; episode: number | null } = {
      season: null,
      episode: null,
    };
    for (const i of order) {
      if (isForwardCursorMove(cursor, positions[i])) cursor = positions[i];
    }
    assert.deepEqual(
      cursor,
      { season: 1, episode: 5 },
      `completion order ${order.join(",")} must settle at the furthest episode`,
    );
  }
}

console.log("PASS cursor advance is monotonic under out-of-order completions");
