import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/app/client/page.tsx", "utf8");

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

console.log("\n/client page source shape");

check("client rows render parsed display titles, not raw release names", () => {
  assert.match(source, /import \{ parseEpisode \} from "@\/lib\/torrents\/episodes";/);
  assert.match(
    source,
    /import \{ parseResolution, parseSourceTier, SOURCE_TIER \} from "@\/lib\/torrents\/quality";/,
  );
  assert.doesNotMatch(source, /function\s+(?:episodeChip|sourceChip)\s*\(/);
  assert.doesNotMatch(source, /<p[\s\S]*?>\s*\{t\.name\}/);
  assert.match(source, /<p[\s\S]*?>\s*\{display\.title\}/);
  assert.match(source, /title=\{t\.name\}/, "raw release name should remain available on hover");
});

check("overflow contains secondary actions and remains keyboard reachable", () => {
  assert.match(source, /<DropdownMenuTrigger asChild>\s*<Button[\s\S]*?aria-label="More actions"/);
  assert.match(source, /<DropdownMenuItem[\s\S]*?data-open-folder/);
  assert.match(source, /Copy stream URL/);
  assert.doesNotMatch(source, /data-inline-player|Hide player|<video\b/);
});

check("client page does not poll from a fixed interval", () => {
  assert.doesNotMatch(source, /\bsetInterval\s*\(/);
  assert.match(source, /startVisiblePoller/);
});

if (process.exitCode) {
  console.error("\nFAIL — client page source shape regressed");
} else {
  console.log("\nPASS — client page source shape is stable");
}
