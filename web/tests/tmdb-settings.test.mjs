import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../src/components/settings/tmdb-settings.tsx", import.meta.url), "utf8");
test("TMDB settings keeps secrets in a password input and clears drafts after saving", () => {
  assert.match(panel, /type="password"/);
  assert.match(panel, /autoComplete="new-password"/);
  assert.match(panel, /setKey\(""\)/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage/);
});
test("TMDB controls are separate guarded API actions with responsive wrapping", () => {
  for (const action of ["save", "test", "remove"]) assert.match(panel, new RegExp(`data-tmdb-${action}`));
  assert.match(panel, /flex-wrap/);
  assert.match(panel, /window.confirm/);
  assert.match(panel, /AniList and keyless sources/);
});
