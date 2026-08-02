/**
 * `POST /api/library/delete` — separate, confirmed, granular file deletion.
 *
 * Run: npx tsx src/app/api/library/delete/route.test.ts
 *
 * Two halves:
 *
 *  1. **Source shape** — the route authorises, refuses without `confirm: true`
 *     *before* it costs anything, and re-derives every hash it deletes from the
 *     database. A route that took a hash from the request body would pass every
 *     behavioural test below and still be a remote file-delete primitive.
 *  2. **Behaviour** — the route's plan-then-remove sequence run over a table of
 *     scopes against an in-memory volume. A refusal must leave that volume
 *     byte-for-byte unchanged, and a season delete must not touch another
 *     season's files.
 *
 * ## Why the volume is a Map and not a directory
 *
 * This is the one suite in the repo whose subject is *unlinking media*, and the
 * machine it runs on holds the owner's library. Writing throwaway files to
 * prove it would mean running deletion code against real paths, which is
 * exactly the thing that must not happen even once, even in a scratch folder.
 * The behaviour being asserted — which releases the plan names, and therefore
 * which files disappear — is unchanged by the storage being a Map: the remove
 * function is handed the same recorded paths the real one is, and the before/
 * after snapshots are compared the same way.
 *
 * `fs` is used only to read this repository's own source for the shape half.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  deletionPlanSummary,
  planDeletion,
  type DeletionScope,
  type HeldTorrent,
} from "@/lib/library/deletion-plan";

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(`      ${(error as Error).stack ?? (error as Error).message}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// A library, in memory
// ---------------------------------------------------------------------------

const MB = 1_000_000;
const ROOT = "D:\\Media";

/** path → bytes. Stands in for the volume the engine writes into. */
type Volume = Map<string, number>;

function writeFile(volume: Volume, relative: string, bytes: number): string {
  const full = path.join(ROOT, ...relative.split("/"));
  volume.set(full, bytes);
  return full;
}

/** Every file on the volume, relative and POSIX, so states can be compared. */
function snapshot(volume: Volume): string[] {
  return [...volume.keys()]
    .map((full) => path.relative(ROOT, full).split(path.sep).join("/"))
    .sort();
}

/**
 * The library, and the engine rows that claim it.
 *
 * One season-1 pack of ten episodes in a single release, and two single-episode
 * season-2 releases — the layout in which "delete episode 3" is dangerous and
 * "delete season 2" must be surgical.
 */
function buildLibrary(volume: Volume): HeldTorrent[] {
  const packFiles = Array.from({ length: 10 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return writeFile(volume, `Severance/Season 01/Severance.S01E${n}.mkv`, 10 * MB);
  });
  const s02e01 = writeFile(
    volume,
    "Severance/Season 02/Severance.S02E01.mkv",
    20 * MB,
  );
  const s02e02 = writeFile(
    volume,
    "Severance/Season 02/Severance.S02E02.mkv",
    20 * MB,
  );

  const held = (hash: string, name: string, files: string[]): HeldTorrent => ({
    hash,
    name,
    allocatedBytes: files.reduce((sum, f) => sum + (volume.get(f) ?? 0), 0),
    files: files.map((file) => ({
      path: file,
      sizeBytes: volume.get(file) ?? 0,
      presence: volume.has(file) ? ("present" as const) : ("absent" as const),
    })),
  });

  return [
    held("pack-s01", "Severance.S01.1080p.WEB-DL.x265", packFiles),
    held("s02e01", "Severance.S02E01.1080p.WEB-DL", [s02e01]),
    held("s02e02", "Severance.S02E02.1080p.WEB-DL", [s02e02]),
  ];
}

interface HandleResult {
  ok: boolean;
  reason?: string;
  freedBytes: number;
  freedFiles: number;
  removedHashes: string[];
  summary: string;
}

/**
 * The route's plan-then-remove sequence, with HTTP, prisma and the torrent
 * client stripped off.
 *
 * `remove` stands in for `client.deleteTorrent(config, hash, true)` and is
 * handed the same release the real one is, so what the volume loses is decided
 * by the plan and nothing else.
 */
async function handle(
  held: HeldTorrent[],
  scope: DeletionScope,
  remove: (torrent: HeldTorrent) => Promise<{ ok: boolean; message: string }>,
): Promise<HandleResult> {
  const plan = planDeletion(held, scope);
  const summary = deletionPlanSummary(plan);
  if (plan.outcome !== "deletes") {
    return {
      ok: false,
      reason: plan.outcome,
      freedBytes: 0,
      freedFiles: 0,
      removedHashes: [],
      summary,
    };
  }

  const removedHashes: string[] = [];
  let freedBytes = 0;
  let freedFiles = 0;
  for (const release of plan.releases) {
    const torrent = held.find((t) => t.hash === release.hash);
    assert.ok(torrent, "the plan may only name releases the server read");
    const result = await remove(torrent);
    if (!result.ok) continue;
    removedHashes.push(release.hash);
    freedBytes += release.bytes;
    freedFiles += release.fileCount;
  }
  return { ok: true, freedBytes, freedFiles, removedHashes, summary };
}

/** Removes exactly the files the engine recorded for one release. */
function unlinkFrom(volume: Volume) {
  return (torrent: HeldTorrent): Promise<{ ok: boolean; message: string }> => {
    for (const file of torrent.files) volume.delete(file.path);
    return Promise.resolve({ ok: true, message: "removed" });
  };
}

async function withLibrary(
  fn: (ctx: {
    volume: Volume;
    held: HeldTorrent[];
    before: string[];
  }) => Promise<void>,
): Promise<void> {
  const volume: Volume = new Map();
  const held = buildLibrary(volume);
  await fn({ volume, held, before: snapshot(volume) });
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

async function behaviour() {
  await check("an episode request against a pack deletes nothing at all", async () => {
    await withLibrary(async ({ volume, held, before }) => {
      const result = await handle(
        held,
        { kind: "episode", season: 1, episode: 3 },
        unlinkFrom(volume),
      );
      assert.equal(result.ok, false);
      assert.equal(result.reason, "blocked");
      assert.deepEqual(result.removedHashes, []);
      assert.deepEqual(
        snapshot(volume),
        before,
        "a refused delete must leave the volume byte-for-byte unchanged",
      );
      assert.match(result.summary, /Nothing can be deleted for S01E03/);
      assert.match(result.summary, /delete Season 1 to remove it/);
    });
  });

  await check("deleting season 1 removes exactly season 1", async () => {
    await withLibrary(async ({ volume, held }) => {
      const result = await handle(held, { kind: "season", season: 1 }, unlinkFrom(volume));
      assert.equal(result.ok, true);
      assert.deepEqual(result.removedHashes, ["pack-s01"]);
      assert.equal(result.freedFiles, 10);
      assert.equal(result.freedBytes, 100 * MB);
      assert.deepEqual(snapshot(volume), [
        "Severance/Season 02/Severance.S02E01.mkv",
        "Severance/Season 02/Severance.S02E02.mkv",
      ]);
    });
  });

  await check("deleting season 2 leaves season 1 alone", async () => {
    await withLibrary(async ({ volume, held }) => {
      const result = await handle(held, { kind: "season", season: 2 }, unlinkFrom(volume));
      assert.equal(result.ok, true);
      assert.deepEqual(result.removedHashes, ["s02e01", "s02e02"]);
      assert.equal(result.freedBytes, 40 * MB);
      assert.deepEqual(
        snapshot(volume),
        Array.from({ length: 10 }, (_, i) =>
          `Severance/Season 01/Severance.S01E${String(i + 1).padStart(2, "0")}.mkv`,
        ),
      );
    });
  });

  await check("deleting one episode removes one file", async () => {
    await withLibrary(async ({ volume, held }) => {
      const result = await handle(
        held,
        { kind: "episode", season: 2, episode: 1 },
        unlinkFrom(volume),
      );
      assert.equal(result.ok, true);
      assert.deepEqual(result.removedHashes, ["s02e01"]);
      assert.equal(result.freedFiles, 1);
      assert.equal(
        snapshot(volume).includes("Severance/Season 02/Severance.S02E02.mkv"),
        true,
        "the sibling episode must survive",
      );
      assert.equal(snapshot(volume).length, 11);
    });
  });

  await check("deleting the show removes everything held", async () => {
    await withLibrary(async ({ volume, held }) => {
      const result = await handle(held, { kind: "show" }, unlinkFrom(volume));
      assert.equal(result.ok, true);
      assert.deepEqual(result.removedHashes.sort(), ["pack-s01", "s02e01", "s02e02"]);
      assert.equal(result.freedFiles, 12);
      assert.equal(result.freedBytes, 140 * MB);
      assert.deepEqual(snapshot(volume), []);
    });
  });

  await check("a season we hold nothing for removes nothing", async () => {
    await withLibrary(async ({ volume, held, before }) => {
      const result = await handle(held, { kind: "season", season: 7 }, unlinkFrom(volume));
      assert.equal(result.ok, false);
      assert.equal(result.reason, "nothing-held", "distinct from a refusal");
      assert.deepEqual(snapshot(volume), before);
    });
  });

  await check("files removed outside the app are not claimed as freed", async () => {
    await withLibrary(async ({ volume, held }) => {
      // The owner deleted season 2 from Explorer. The rows still claim it.
      for (const file of [...volume.keys()]) {
        if (file.includes("Season 02")) volume.delete(file);
      }
      const restated = restatePresence(held, volume);

      const result = await handle(
        restated,
        { kind: "season", season: 2 },
        unlinkFrom(volume),
      );
      assert.equal(result.ok, true, "the engine rows still have to go");
      assert.equal(result.freedFiles, 0);
      assert.equal(result.freedBytes, 0, "nothing was on the disk to free");
      assert.equal(
        result.summary.includes("40 MB"),
        false,
        "the recorded sizes must not be reported as reclaimed",
      );
      assert.equal(snapshot(volume).length, 10, "season 1 untouched");
    });
  });

  await check("a client that refuses leaves the files and reports nothing freed", async () => {
    await withLibrary(async ({ volume, held, before }) => {
      const result = await handle(held, { kind: "season", season: 2 }, () =>
        Promise.resolve({ ok: false, message: "client offline" }),
      );
      assert.equal(result.ok, true, "the request itself was valid");
      assert.deepEqual(result.removedHashes, [], "nothing was removed");
      assert.equal(result.freedBytes, 0, "a refusal must not be counted as freed space");
      assert.deepEqual(snapshot(volume), before);
    });
  });
}

/** Re-reads presence and size from the volume, as the route does per request. */
function restatePresence(held: readonly HeldTorrent[], volume: Volume): HeldTorrent[] {
  return held.map((torrent) => ({
    ...torrent,
    files: torrent.files.map((file) => ({
      ...file,
      sizeBytes: volume.get(file.path) ?? file.sizeBytes,
      presence: volume.has(file.path) ? ("present" as const) : ("absent" as const),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Source shape
// ---------------------------------------------------------------------------

const SOURCE = fs.readFileSync("src/app/api/library/delete/route.ts", "utf8");

function handlerSource(name: "GET" | "POST"): string {
  const start = SOURCE.indexOf(`export async function ${name}(`);
  assert.ok(start > -1, `the route must export ${name}`);
  const after = SOURCE.indexOf("export async function ", start + 10);
  return after > -1 ? SOURCE.slice(start, after) : SOURCE.slice(start);
}

function sourceShape() {
  return [
    check("the route authorises before it can remove anything", () => {
      const post = handlerSource("POST");
      const authAt = post.indexOf("await auth()");
      const deleteAt = post.indexOf("deleteTorrent(");
      assert.ok(authAt > -1, "the route must authenticate");
      assert.ok(deleteAt > authAt, "nothing may be deleted before the session check");
      assert.match(post, /status:\s*401/);
      assert.match(post, /guardBrowserMutation\(request\)/);
    }),

    check("an unconfirmed request is refused before anything is even costed", () => {
      const post = handlerSource("POST");
      const confirmAt = post.indexOf("confirm.value !== true");
      const planAt = post.indexOf("planDeletion(");
      const heldAt = post.indexOf("heldForWork(");
      const deleteAt = post.indexOf("deleteTorrent(");
      assert.ok(confirmAt > -1, "`confirm: true` must be required");
      // Anchored, not a substring search. A first draft of this assertion only
      // looked for the text `confirm.value !== true` anywhere in the handler,
      // and a mutation to `if (false && confirm.value !== true)` — a guard that
      // never fires — sailed straight past it. The condition has to *be* the
      // condition, so the `)` and `{` are part of the assertion.
      assert.match(
        post,
        /\n {2}if \(confirm\.value !== true\) \{\n/,
        "the confirmation must be the whole guard, not one term of a disabled one",
      );
      assert.ok(confirmAt < heldAt, "an unconfirmed request must not read the library");
      assert.ok(confirmAt < planAt, "…nor build a plan");
      assert.ok(confirmAt < deleteAt, "…and certainly not delete");
      // The refusal has to be a 400 the caller can act on, and it has to be
      // inside the guard's own block. An earlier draft asserted against a slice
      // reaching all the way to `planDeletion(`, which happens to contain the
      // unrelated 400 for "no client configured" — so a guard whose body had
      // been emptied to a `console.warn` still passed.
      const guardBody = post.slice(confirmAt, post.indexOf("const scope =", confirmAt));
      assert.match(
        guardBody,
        /return NextResponse\.json\(/,
        "the guard must return, not merely log and continue",
      );
      assert.match(guardBody, /status:\s*400/);
    }),

    check("every hash deleted is derived server-side, never taken from the caller", () => {
      const post = handlerSource("POST");
      assert.match(
        post,
        /const plan = planDeletion\(held, scope\)/,
        "the plan is computed here, from rows this route read",
      );
      assert.match(
        post,
        /client\.deleteTorrent\(config, release\.hash, true\)/,
        "only a hash the plan produced may be deleted",
      );
      // A body field naming a file, a path or a hash would turn this endpoint
      // into a remote delete primitive, whatever the plan said.
      for (const forbidden of ["hash", "path", "filePath", "files", "infoHash"]) {
        assert.doesNotMatch(
          post,
          new RegExp(`(?:string|stringArray)Field\\(fields,\\s*"${forbidden}"`),
          `the body must not carry \`${forbidden}\``,
        );
      }
    }),

    check("the library row is proven to belong to the session user", () => {
      assert.match(
        SOURCE,
        /prisma\.watchListItem\.findFirst\(\{\s*where:\s*\{\s*id:\s*watchListItemId,\s*userId\s*\}/,
        "ownership is checked by querying on both id and userId",
      );
      const post = handlerSource("POST");
      const ownedAt = post.indexOf("ownedItem(session.user.id");
      const deleteAt = post.indexOf("deleteTorrent(");
      assert.ok(ownedAt > -1 && ownedAt < deleteAt, "ownership is checked before deleting");
      assert.match(post, /status:\s*404/, "a title the user does not own is not found");
      assert.match(
        SOURCE,
        /where:\s*\{\s*userId,\s*status:\s*\{\s*not:\s*"removed"\s*\}\s*\}/,
        "only the session user's engine rows may be considered",
      );
    }),

    check("GET plans and never removes", () => {
      const get = handlerSource("GET");
      for (const forbidden of ["deleteTorrent", "deleteMany", "rmSync", "unlink", "fsp.rm"]) {
        assert.equal(
          get.includes(forbidden),
          false,
          `the planning endpoint must not call ${forbidden}`,
        );
      }
      assert.match(get, /planDeletion\(held, scope\)/);
      assert.match(
        get,
        /plan:\s*planPayload\(/,
        "the planning endpoint must return the shared payload",
      );
      assert.match(
        SOURCE,
        /summary:\s*deletionPlanSummary\(plan\)/,
        "…and that payload must carry the sentence the dialog shows",
      );
    }),

    check("a refused plan deletes nothing and says why", () => {
      const post = handlerSource("POST");
      const guardAt = post.indexOf('plan.outcome !== "deletes"');
      const deleteAt = post.indexOf("deleteTorrent(");
      assert.ok(guardAt > -1 && guardAt < deleteAt, "the plan gates the delete loop");
      // Anchored for the same reason as the confirmation guard: `if (false &&
      // plan.outcome !== "deletes")` contains the text and gates nothing.
      assert.match(
        post,
        /\n {2}if \(plan\.outcome !== "deletes"\) \{\n/,
        "the outcome must be the whole guard",
      );
      const guardBody = post.slice(guardAt, post.indexOf("const deleted", guardAt));
      assert.match(
        guardBody,
        /return NextResponse\.json\(/,
        "the guard must return, not merely log and continue",
      );
      assert.match(guardBody, /status:\s*409/);
      assert.match(guardBody, /deletionPlanSummary\(plan\)/);
    }),

    check("the byte caches are dropped after the files go", () => {
      const post = handlerSource("POST");
      const deleteAt = post.indexOf("deleteTorrent(");
      for (const reset of [
        "resetDirectorySizeCache()",
        "resetDiskInventoryCache()",
        "resetLocalFilePresenceCache()",
      ]) {
        assert.ok(
          post.indexOf(reset) > deleteAt,
          `${reset} must run after the delete, or the storage cap keeps refusing Play ` +
            "against files that are no longer there",
        );
      }
    }),

    check("the response reports what happened, not what was planned", () => {
      const post = handlerSource("POST");
      assert.match(post, /freedBytes \+= release\.bytes/);
      assert.match(post, /failed\.push\(/, "a client refusal must be reported");
      assert.doesNotMatch(
        post,
        /freedBytes:\s*plan\.totalBytes/,
        "claiming the planned total after a partial failure tells the user they " +
          "have space they do not have",
      );
    }),
  ];
}

async function main() {
  await behaviour();
  await Promise.all(sourceShape());
  if (failures > 0) {
    console.error(`\n${failures} library-delete route test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll library-delete route tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
