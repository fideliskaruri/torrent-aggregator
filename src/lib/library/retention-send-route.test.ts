import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/app/api/torrent/send/route.ts", "utf8");
const retentionSettings = fs.readFileSync(
  "src/lib/library/retention-settings.ts",
  "utf8",
);

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

console.log("\n/api/torrent/send retention source shape");

check("send route reads the saved retention default when no explicit choice is sent", () => {
  assert.match(source, /readDefaultRetentionPolicy/);
  assert.match(source, /resolveSendRetentionChoice/);
  assert.match(source, /body\.retention\s*==\s*null/);
  assert.match(
    retentionSettings,
    /function resolveSendRetentionChoice[\s\S]*resolveRetentionPolicy/,
    "the send helper must use the same promotion/default policy code as settings",
  );
});

check("explicit retention is still the decision-point input to stream-only sends", () => {
  assert.match(source, /retention:\s*sendRetention/);
  assert.doesNotMatch(
    source,
    /retention:\s*body\.retention\s*\?\?\s*null/,
    "the route must not bypass the configured default at the final stream-only decision",
  );
});

if (process.exitCode) {
  console.error("\nFAIL — send route retention default is not wired");
} else {
  console.log("\nPASS — send route retention default is wired");
}
