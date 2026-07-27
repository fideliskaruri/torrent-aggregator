/**
 * Retention policy tests — unknown is never safe-to-delete.
 * Run: node node_modules\tsx\dist\cli.mjs src/lib/library/retention-settings.test.ts
 */
import assert from "node:assert/strict";
import {
  DEFAULT_RETENTION_POLICY,
  RETENTION_POLICY_EPHEMERAL,
  RETENTION_POLICY_KEPT,
  isSafeToEvictEphemeral,
  normalizeRetentionPolicy,
  resolveRetentionPolicy,
  retentionPolicyForOrigin,
  shouldDemoteToEphemeral,
  shouldPromoteToKept,
} from "./retention-settings";

async function main() {
  assert.equal(DEFAULT_RETENTION_POLICY, RETENTION_POLICY_EPHEMERAL);
  assert.equal(normalizeRetentionPolicy("keep"), RETENTION_POLICY_KEPT);
  assert.equal(normalizeRetentionPolicy("stream"), RETENTION_POLICY_EPHEMERAL);
  assert.equal(normalizeRetentionPolicy("mystery"), RETENTION_POLICY_EPHEMERAL);

  assert.equal(retentionPolicyForOrigin("user"), RETENTION_POLICY_KEPT);
  assert.equal(retentionPolicyForOrigin("stream"), RETENTION_POLICY_EPHEMERAL);
  assert.equal(retentionPolicyForOrigin("prewarm"), RETENTION_POLICY_EPHEMERAL);
  assert.equal(retentionPolicyForOrigin("mystery"), null);

  assert.equal(shouldPromoteToKept({ tracked: true }), true);
  assert.equal(shouldPromoteToKept({ watchListItemId: "wl" }), true);
  assert.equal(shouldPromoteToKept({ requestedPolicy: "KEPT" }), true);
  assert.equal(shouldPromoteToKept({ requestedPolicy: "EPHEMERAL" }), false);

  assert.equal(
    resolveRetentionPolicy({ defaultPolicy: "KEPT" }),
    RETENTION_POLICY_KEPT,
  );
  assert.equal(
    resolveRetentionPolicy({ defaultPolicy: "EPHEMERAL", tracked: true }),
    RETENTION_POLICY_KEPT,
  );
  assert.equal(
    resolveRetentionPolicy({ existingOrigin: "user", defaultPolicy: "EPHEMERAL" }),
    RETENTION_POLICY_KEPT,
  );
  assert.equal(
    shouldDemoteToEphemeral({
      existingPolicy: RETENTION_POLICY_KEPT,
      explicitDemotion: true,
    }),
    false,
  );

  const now = new Date("2026-07-27T12:00:00.000Z");
  const oldComplete = new Date(now.getTime() - 8 * 60 * 60 * 1000);
  assert.equal(
    isSafeToEvictEphemeral({
      retentionPolicy: RETENTION_POLICY_EPHEMERAL,
      hasProgressRow: true,
      completedAt: oldComplete,
      referencedByWatchlist: false,
      now,
    }),
    true,
  );

  assert.equal(
    isSafeToEvictEphemeral({
      retentionPolicy: RETENTION_POLICY_EPHEMERAL,
      hasProgressRow: null,
      completedAt: oldComplete,
      referencedByWatchlist: false,
      now,
    }),
    false,
    "indeterminate progress must survive eviction",
  );
  assert.equal(
    isSafeToEvictEphemeral({
      retentionPolicy: null,
      hasProgressRow: true,
      completedAt: oldComplete,
      referencedByWatchlist: false,
      now,
    }),
    false,
    "indeterminate retention must survive eviction",
  );
  assert.equal(
    isSafeToEvictEphemeral({
      retentionPolicy: RETENTION_POLICY_EPHEMERAL,
      hasProgressRow: true,
      completedAt: oldComplete,
      referencedByWatchlist: null,
      now,
    }),
    false,
    "indeterminate references must survive eviction",
  );
  assert.equal(
    isSafeToEvictEphemeral({
      retentionPolicy: RETENTION_POLICY_KEPT,
      hasProgressRow: true,
      completedAt: oldComplete,
      referencedByWatchlist: false,
      now,
    }),
    false,
    "kept content is never evictable",
  );

  console.log("retention-settings.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
