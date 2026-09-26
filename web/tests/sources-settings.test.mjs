import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const panel = readFileSync(new URL("../src/components/settings/sources-settings.tsx", import.meta.url), "utf8");
test("source controls include enable, priority, mirrors, test and custom indexers", () => {
  for (const hook of ["enable", "save", "test", "mirrors", "remove", "add"]) assert.match(panel, new RegExp(`data-source-${hook}`));
  assert.match(panel, /Move .* up/);
  assert.match(panel, /Move .* down/);
  assert.match(panel, /type: "torznab"/);
  assert.match(panel, /flex-wrap/);
});
test("TMDB credential controls live within the TMDB source", () => {
  assert.match(panel, /source.type === "tmdb"/);
  assert.match(panel, /TmdbSettings embedded/);
  assert.match(panel, /type="password"/);
});
