import assert from "node:assert/strict";
import { activityKindLabel, formatActivityKind } from "./presentation";

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
