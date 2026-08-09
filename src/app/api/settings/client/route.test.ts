/**
 * `PUT /api/settings/client` — saving download settings must refresh the stale
 * storage caches that key off the active library root.
 *
 * Run: npx tsx src/app/api/settings/client/route.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/app/api/settings/client/route.ts", "utf8");

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

console.log("\nPUT /api/settings/client refreshes download storage caches");

check("the route resets both caches after the settings row is saved", () => {
  const invalidateAt = source.indexOf(
    "if (shouldResetDownloadStorageCaches(existing, settings))",
  );
  const saveAt = source.lastIndexOf(
    "const settings = await prisma.clientSettings.upsert",
    invalidateAt,
  );
  const resetSizeAt = source.indexOf("resetDirectorySizeCache()");
  const resetInventoryAt = source.indexOf("resetDiskInventoryCache()");
  const retentionAt = source.indexOf(
    "const retention = await getRetentionSettingsSnapshot",
    invalidateAt,
  );

  assert.ok(invalidateAt > -1, "the route must decide when to invalidate");
  assert.ok(saveAt > -1, "the settings row must be saved before invalidation");
  assert.ok(resetSizeAt > saveAt, "size cache reset must happen after the save");
  assert.ok(
    resetInventoryAt > saveAt,
    "inventory cache reset must happen after the save",
  );
  assert.ok(
    resetSizeAt < retentionAt,
    "the next settings snapshot must read after cache invalidation",
  );
  assert.ok(
    resetInventoryAt < retentionAt,
    "the next settings snapshot must read after cache invalidation",
  );
});

check("the invalidation is driven by the active download root or storage cap", () => {
  assert.match(source, /shouldResetDownloadStorageCaches\(/);
  assert.ok(source.includes("downloadRootFor(previous ?? {})"));
  assert.ok(source.includes("downloadRootFor(next)"));
  assert.ok(source.includes("configuredStorageCap(previous ?? {})"));
  assert.ok(source.includes("configuredStorageCap(next)"));
});

if (process.exitCode) {
  console.error("\nsettings/client cache invalidation drifted");
} else {
  console.log("\nPASS — settings saves refresh the storage caches");
}
