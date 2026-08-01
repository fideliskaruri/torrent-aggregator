import assert from "node:assert/strict";

import {
  buildRuleTogglePayload,
  buildRuleRetargetPayload,
  describeRuleCategory,
  normalizeRuleCategory,
  RULE_CATEGORY_OPTIONS,
} from "@/app/rules/page";
import {
  parseSettingsTab,
  PRIMARY_DOWNLOAD_CLIENT_OPTIONS,
} from "@/app/settings/page";
import { normalizeMediaType } from "@/lib/metadata/media-type";
import fs from "node:fs";

const ruleCategoryValues = RULE_CATEGORY_OPTIONS.map((option) => option.value);

assert.deepEqual(
  ruleCategoryValues,
  ["all", "anime", "movies", "tv"],
  "auto-download rules must only offer categories TorrentFlow can browse and play",
);

for (const category of ruleCategoryValues) {
  assert.ok(
    category === "all" || normalizeMediaType(category),
    `${category} must map to a playable media type`,
  );
}

assert.equal(
  normalizeRuleCategory("music"),
  "all",
  "legacy rule categories must be normalized before they reach a select control",
);

const legacyMusic = describeRuleCategory("music");
assert.equal(
  legacyMusic.supported,
  false,
  "a legacy music rule must be shown as unsupported rather than as a playable category",
);
assert.match(
  legacyMusic.label,
  /music/i,
  "a legacy music rule must show the stored category instead of rendering as All video",
);
assert.notEqual(
  legacyMusic.label,
  "All video",
  "unsupported stored categories must not be silently replaced by the first option",
);

assert.deepEqual(
  buildRuleTogglePayload("legacy-rule", false, "music"),
  { id: "legacy-rule", enabled: false },
  "editing an unrelated rule field must not rewrite a legacy category",
);

assert.deepEqual(
  buildRuleRetargetPayload("legacy-rule", "music"),
  { id: "legacy-rule", category: "all" },
  "retargeting a legacy rule must be the only deliberate path that migrates it",
);

const primaryOptions = PRIMARY_DOWNLOAD_CLIENT_OPTIONS.map((option) => ({
  value: option.value,
  stance: option.stance,
}));

assert.deepEqual(
  primaryOptions,
  [
    { value: "builtin", stance: "recommended" },
    { value: "qbittorrent", stance: "advanced" },
    { value: "transmission", stance: "advanced" },
  ],
  "external clients are useful integrations, but they must not be presented as equal to in-browser playback",
);

assert.equal(parseSettingsTab("connection"), "connection");
assert.equal(parseSettingsTab("folders"), "folders");
assert.equal(parseSettingsTab("categories"), "categories");
assert.equal(
  parseSettingsTab("unknown"),
  null,
  "unknown legacy Settings tabs must fall back to the basic page",
);

const settingsPage = fs.readFileSync("src/app/settings/page.tsx", "utf8");
const retentionPanel = fs.readFileSync(
  "src/components/settings/retention-panel.tsx",
  "utf8",
);

assert.match(
  settingsPage,
  /import \{ RetentionPanel \} from "@\/components\/settings\/retention-panel";/,
  "retention settings must be imported by the Settings page, not left as dead code",
);
assert.match(
  settingsPage,
  /<RetentionPanel showPolicy=\{false\} \/>/,
  "storage cleanup must stay available in Advanced without duplicating the basic file-behaviour choice",
);
assert.doesNotMatch(
  retentionPanel,
  />\s*Stream-only\s*</,
  "the default-retention option label must state the effect, not the mechanism",
);
assert.match(
  retentionPanel,
  /Free up space after watching/,
  "the stream-cache default should be labelled by the user-visible effect",
);
assert.match(
  retentionPanel,
  /Delete temporary streams now/,
  "the destructive sweep button must say it deletes files",
);

assert.match(
  settingsPage,
  /<SettingsDisclosure[\s\S]*title="Advanced"/,
  "implementation details must be behind one explicit Advanced disclosure",
);
assert.doesNotMatch(
  settingsPage,
  /role="tablist"|role="tabpanel"/,
  "Settings must not leak or divide content across subsystem tabs",
);
for (const id of [
  "download-folder",
  "storage-limit",
  "preferred-quality",
  "file-behavior",
  "use-another-download-app",
  "new-category",
]) {
  assert.match(
    settingsPage,
    new RegExp(`(?:htmlFor|id)="${id}"`),
    `${id} must have an explicit accessible label`,
  );
}
assert.match(
  settingsPage,
  /defaultRetentionPolicy: form\.defaultRetentionPolicy/,
  "the basic file-behaviour choice must round-trip through the existing API field",
);
assert.match(
  settingsPage,
  /data-external-client-fields/,
  "external connection details must have a progressive-disclosure boundary",
);

// --- Untracked files ------------------------------------------------------
// The owner's complaint was "i cna't even see these on my downloads" while the
// folder held 40.42 GB and the Client page listed nothing. These pin the rules
// that make that answerable, so a later edit cannot quietly undo them.

assert.match(
  retentionPanel,
  /Download folder on disk/,
  "the panel must state the real on-disk total, not only the app's own accounting",
);
assert.match(
  retentionPanel,
  /tracked by transfers[\s\S]{0,400}untracked[\s\S]{0,400}TorrentFlow files/,
  "the headline must break down into the three buckets that reconcile to it",
);
assert.match(
  retentionPanel,
  /formatExactBytes\(usage\.diskBytes\)/,
  "an exact byte count is what lets the owner check the number against Explorer",
);

for (const [pattern, why] of [
  [/scan\.truncated \?/, "a truncated walk must be stated, since under-reporting is the bug"],
  [/unreadablePaths\.length \?/, "locations that could not be read must be named"],
  [/groups\.length === 0 \?/, "the reconciled, nothing-untracked state must be rendered"],
  [/CheckCircle2/, "the empty state must read as reassurance, not as a blank panel"],
  [/groupsTruncated \?/, "a capped list must say it is capped"],
  [/revealing === key/, "revealing must show it is working"],
  [/deleting === group\.relativePath/, "a delete in flight must show on that row"],
] as const) {
  assert.match(retentionPanel, pattern, why);
}

assert.match(
  retentionPanel,
  /<AlertDialog[\s\S]*Delete this untracked/,
  "deleting files off the volume must be confirmed in the product's own dialog",
);
assert.doesNotMatch(
  retentionPanel,
  /window\.confirm\([^)]*untracked/i,
  "the untracked-delete path must not fall back to a browser confirm",
);
assert.doesNotMatch(
  retentionPanel,
  /Clean up everything|Delete all untracked|Remove all orphans/i,
  "there is deliberately no bulk delete: invisible mass deletion is the complaint, not the fix",
);
assert.doesNotMatch(
  retentionPanel,
  /useEffect\([^)]*\)[^;]*untracked-files/,
  "nothing may delete without the owner asking for it",
);

const orphanButtons = retentionPanel.match(
  /onClick=\{\(\) =>\s*on(Reveal|RequestDelete)\(/g,
);
assert.ok(
  orphanButtons && orphanButtons.length >= 3,
  "each untracked row needs a real reveal and a real delete, not decorative controls",
);
assert.equal(
  (retentionPanel.match(/min-h-\[44px\]/g) ?? []).length >= 4,
  true,
  "every new touch target must be at least 44px",
);
