import assert from "node:assert/strict";

import {
  buildRuleCreatePayload,
  buildRuleFilterPayload,
  buildRuleRetargetPayload,
  buildRuleTogglePayload,
  bytesToMaxSizeGbInput,
  maxSizeGbToBytes,
  parseRuleSources,
} from "./form";

assert.equal(
  maxSizeGbToBytes(""),
  null,
  "blank max-size field must stay unset, not become a zero-byte filter",
);
assert.equal(
  maxSizeGbToBytes("8"),
  8 * 1024 ** 3,
  "rule size input is GB at the UI boundary and bytes at the API boundary",
);
assert.equal(bytesToMaxSizeGbInput(null), "");
assert.equal(bytesToMaxSizeGbInput(8 * 1024 ** 3), "8");

assert.deepEqual(parseRuleSources(null), []);
assert.deepEqual(parseRuleSources("nyaa,yts,bogus,nyaa"), ["nyaa", "yts"]);

assert.deepEqual(
  buildRuleCreatePayload({
    name: "Weekly",
    query: "show 1080p",
    category: "tv",
    minSeeders: "10",
    resolution: "",
    sources: [],
    maxSizeGb: "",
  }),
  {
    name: "Weekly",
    query: "show 1080p",
    category: "tv",
    minSeeders: 10,
    resolution: null,
    sources: null,
    maxSizeBytes: null,
  },
  "unset filters round-trip as null so old rules keep matching all sources and sizes",
);

assert.deepEqual(
  buildRuleCreatePayload({
    name: "Small anime",
    query: "frieren",
    category: "anime",
    minSeeders: "5",
    resolution: "1080p",
    sources: ["nyaa", "yts"],
    maxSizeGb: "4.5",
  }),
  {
    name: "Small anime",
    query: "frieren",
    category: "anime",
    minSeeders: 5,
    resolution: "1080p",
    sources: "nyaa,yts",
    maxSizeBytes: Math.round(4.5 * 1024 ** 3),
  },
);

assert.deepEqual(
  buildRuleTogglePayload("existing", false),
  { id: "existing", enabled: false },
  "editing an unrelated field on an old rule must not introduce source or size filters",
);

assert.deepEqual(
  buildRuleRetargetPayload("existing", "tv"),
  { id: "existing", category: "tv" },
  "retargeting an old rule must not introduce source or size filters",
);

assert.deepEqual(
  buildRuleFilterPayload("existing", { sources: [], maxSizeGb: "" }),
  { id: "existing", sources: null, maxSizeBytes: null },
  "saving an opened-but-unchanged legacy filter editor must persist unset, not restrictive defaults",
);
