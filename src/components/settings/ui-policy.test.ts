import assert from "node:assert/strict";

import { RULE_CATEGORY_OPTIONS } from "@/app/rules/page";
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
