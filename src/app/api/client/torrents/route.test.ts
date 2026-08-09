/**
 * `POST /api/client/torrents` — the delete path must leave nothing behind.
 *
 * Run: npx tsx src/app/api/client/torrents/route.test.ts
 *
 * A source-shape suite, the same discipline as `library/delete/route.test.ts`
 * uses for its authorisation half: the subject is deleting the owner's media,
 * so the assertion is made against the route's source rather than by driving
 * real removal code over real paths on the machine that holds the library.
 *
 * The behaviour being pinned is the one the user hit: pressing Delete removed
 * the torrent and the files but left the database remembering the release, so
 * the title page still claimed it was present and a re-download inside the
 * five-minute dedup window was refused as "already downloading". Delete must
 * therefore also drop the three rows that name the infoHash and the two memos
 * that still believe the files exist — but only when files were actually
 * removed (`deleteFiles`), and only after the client reported success.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/app/api/client/torrents/route.ts", "utf8");

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

console.log("\nPOST /api/client/torrents delete reconciles state");

check("delete drops the rows that remember the infoHash", () => {
  // All three models keyed on the deleted release must be cleared: the intent
  // row (AcquisitionTarget) so availability stops claiming it, the resume row
  // (PlaybackProgress) so Play does not open a deleted file, and the grab log
  // (GrabJob) so the dedup guard does not refuse an immediate re-download.
  assert.match(source, /prisma\.grabJob\.deleteMany/);
  assert.match(source, /prisma\.acquisitionTarget\.deleteMany/);
  assert.match(source, /prisma\.playbackProgress\.deleteMany/);
});

check("the row cleanup is scoped to this user and this infoHash", () => {
  assert.match(
    source,
    /deleteMany\(\{\s*where:\s*\{\s*userId:\s*session\.user\.id,\s*infoHash:\s*\{\s*in:\s*infoHashes\s*\}/,
  );
  // Hex hashes arrive in mixed case from different clients; all spellings go.
  assert.match(
    source,
    /const infoHashes = \[hash, hash\.toLowerCase\(\), hash\.toUpperCase\(\)\]/,
  );
});

check("cleanup only runs on a successful file delete, never a bare removal", () => {
  // The block that clears the rows must sit behind `deleteFiles && result.ok`.
  // Removing a torrent but keeping its files leaves the content on disk, so its
  // intent and resume rows are still true and must not be dropped.
  assert.match(
    source,
    /if \(deleteFiles && result\.ok\) \{[\s\S]*?prisma\.\$transaction\(\[/,
  );
});

check("delete drops the memos that still believe the files exist", () => {
  // Same three caches `library/delete` resets: a stale size total refuses the
  // next send, and a stale presence memo offers a Play against gone files.
  assert.match(source, /resetDirectorySizeCache\(\)/);
  assert.match(source, /resetDiskInventoryCache\(\)/);
  assert.match(source, /resetLocalFilePresenceCache\(\)/);
});

if (process.exitCode) {
  console.error("\nclient/torrents delete-reconcile shape drifted");
} else {
  console.log("\nPASS — delete leaves nothing behind");
}
