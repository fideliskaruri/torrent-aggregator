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
