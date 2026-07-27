import assert from "node:assert/strict";

import {
  buildRuleTogglePayload,
  buildRuleRetargetPayload,
  describeRuleCategory,
  normalizeRuleCategory,
  RULE_CATEGORY_OPTIONS,
} from "@/app/rules/page";
import { PRIMARY_DOWNLOAD_CLIENT_OPTIONS } from "@/app/settings/page";
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
  /<RetentionPanel \/>/,
  "retention controls must be rendered where users manage downloads",
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
  /Delete reclaimable stream-only files/,
  "the destructive sweep button must say it deletes files",
);
