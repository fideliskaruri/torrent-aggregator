import assert from "node:assert/strict";
import {
  activityKindLabel,
  boundedActivityItems,
  formatActivityKind,
  groupActivityByDay,
} from "./presentation";

const cases: Array<[string, string]> = [
  ["Ondemand", "On-demand"],
  ["ondemand", "On-demand"],
  ["onDemand", "On-demand"],
  ["on_demand", "On-demand"],
  ["ON-DEMAND", "On-demand"],
  ["autoRule", "Auto-rule"],
  ["AUTO_RULE", "Auto-rule"],
  ["prewarm", "Pre-warm"],
  ["pre_warm", "Pre-warm"],
  ["titlePlay", "Title play"],
  ["SCHEDULED_RETRY", "Scheduled retry"],
  ["manual-download", "Manual download"],
  ["library", "Library"],
];

for (const [input, expected] of cases) {
  assert.equal(
    formatActivityKind(input),
    expected,
    `kind ${JSON.stringify(input)} should be humanised by the general rule`,
  );

  assert.deepEqual(
    boundedActivityItems([1, 2, 3, 4], 2),
    [1, 2],
    "the first activity batch is bounded",
  );
  assert.deepEqual(
    boundedActivityItems([1, 2], -1),
    [],
    "negative limits never leak rows",
  );

  const now = new Date("2026-07-31T12:00:00");
  const groups = groupActivityByDay(
    [
      { id: "a", createdAt: "2026-07-31T08:00:00" },
      { id: "b", createdAt: "2026-07-31T07:00:00" },
      { id: "c", createdAt: "2026-07-30T23:00:00" },
      { id: "d", createdAt: "not-a-date" },
    ],
    now,
  );
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.map((item) => item.id)]),
    [
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Earlier", ["d"]],
    ],
    "activity is grouped in stable first-seen day order",
  );
}

assert.equal(formatActivityKind("  "), null);
assert.equal(formatActivityKind(null), null);
assert.equal(
  activityKindLabel({
    kind: "ondemand",
    context: "On-demand S01E01",
  }),
  "On-demand S01E01",
  "the richer context replaces the generic enum instead of adding a second badge",
);
assert.equal(
  activityKindLabel({ kind: "scheduledRetry", context: null }),
  "Scheduled retry",
);

console.log("PASS activity presentation");
