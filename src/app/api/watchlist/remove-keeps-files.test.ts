/**
 * Removing a title from the Library stops tracking and keeps the files.
 *
 * Run: npx tsx src/app/api/watchlist/remove-keeps-files.test.ts
 *
 * Two halves, because the promise has two halves and only one of them is
 * visible in the handler:
 *
 *  1. **Behaviour** — the retention machinery, driven against an in-memory
 *     database, showing that removing a library row is exactly what *unlocks*
 *     a streamed episode for eviction, and that promoting first closes it. This
 *     is the half that would have caught the real defect.
 *  2. **Source shape** — the DELETE handler does the promotion, does it in the
 *     right order, and does not reach for a file-deleting API. Ordering cannot
 *     be observed from outside the route, and "before" is the whole safety
 *     property: the reverse order leaves a window with the files unprotected.
 *
 * Nothing here touches a real filesystem or the live database.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import type prisma from "@/lib/prisma";
import {
  listEvictableStreams,
  promoteLibraryStreamsToKept,
  STREAM_ORIGIN,
} from "@/lib/streaming/retention";
import { USER_ORIGIN } from "@/lib/prewarm/types";
import { resetForegroundState } from "@/lib/prewarm/foreground";
import { removeFromLibraryCopy } from "@/app/watchlist/remove-copy";

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(`      ${(error as Error).message}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// A database small enough to reason about
// ---------------------------------------------------------------------------

const USER = "user-1";
const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ITEM = "item-1";
const GB = 1024 * 1024 * 1024;

interface EngineRow {
  id: string;
  userId: string;
  hash: string;
  name: string;
  origin: string;
  status: string;
  progress: number;
  sizeBytes: bigint;
  evictLease: string | null;
  evictFrom: string | null;
  lastUsedAt: Date;
  createdAt: Date;
}
interface ProgressRow {
  userId: string;
  infoHash: string;
  completedAt: Date | null;
  watchListItemId: string | null;
  title: string;
}
interface LibraryRow {
  id: string;
  userId: string;
  title: string;
  mediaType: string;
}
interface Store {
  engine: EngineRow[];
  progress: ProgressRow[];
  library: LibraryRow[];
}

type InFilter = { in?: string[] } | undefined;
function matchesIn(filter: InFilter, value: string): boolean {
  return !filter?.in || filter.in.includes(value);
}

/**
 * The one scenario that matters: an episode the owner *streamed* (origin
 * `stream`, watched to completion, past the six-hour seeding grace) belonging to
 * a title that is in the Library. Every guard in the eviction path is satisfied
 * except the library reference — which is precisely what removal takes away.
 */
function freshStore(now: Date): Store {
  return {
    engine: [
      {
        id: "engine-1",
        userId: USER,
        hash: HASH,
        name: "Severance.S02E06.1080p.WEB-DL",
        origin: STREAM_ORIGIN,
        status: "seeding",
        progress: 1,
        sizeBytes: BigInt(2 * GB),
        evictLease: null,
        evictFrom: null,
        lastUsedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      },
    ],
    progress: [
      {
        userId: USER,
        infoHash: HASH,
        // Watched to the end, long enough ago that the seeding grace has passed.
        completedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
        watchListItemId: ITEM,
        title: "Severance",
      },
    ],
    library: [{ id: ITEM, userId: USER, title: "Severance", mediaType: "tv" }],
  };
}

function fakeDb(store: Store) {
  return {
    engineTorrent: {
      findMany: async ({
        where,
      }: {
        where: { userId?: string; origin?: string };
      }) =>
        store.engine.filter(
          (row) =>
            (where.userId === undefined || row.userId === where.userId) &&
            (where.origin === undefined || row.origin === where.origin),
        ),
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId?: string; hash?: InFilter; origin?: InFilter };
        data: Partial<EngineRow>;
      }) => {
        let count = 0;
        for (const row of store.engine) {
          if (where.userId !== undefined && row.userId !== where.userId) continue;
          if (!matchesIn(where.hash, row.hash)) continue;
          if (!matchesIn(where.origin, row.origin)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
    },
    playbackProgress: {
      findMany: async ({
        where,
      }: {
        where: {
          userId?: string;
          infoHash?: InFilter;
          OR?: Array<{ watchListItemId?: string; title?: { equals: string } }>;
        };
      }) =>
        store.progress.filter((row) => {
          if (where.userId !== undefined && row.userId !== where.userId) return false;
          if (!matchesIn(where.infoHash, row.infoHash)) return false;
          if (!where.OR) return true;
          return where.OR.some(
            (clause) =>
              (clause.watchListItemId !== undefined &&
                row.watchListItemId === clause.watchListItemId) ||
              (clause.title !== undefined && row.title === clause.title.equals),
          );
        }),
    },
    watchListItem: {
      findMany: async ({
        where,
      }: {
        where: { userId?: string; id?: InFilter };
      }) =>
        store.library.filter(
          (row) =>
            (where.userId === undefined || row.userId === where.userId) &&
            matchesIn(where.id, row.id),
        ),
    },
  } as unknown as typeof prisma;
}

/** Exactly what `DELETE /api/watchlist` now does, with the HTTP layer removed. */
async function removeFromLibrary(store: Store, itemId: string): Promise<void> {
  const item = store.library.find((row) => row.id === itemId && row.userId === USER);
  if (!item) return;
  await promoteLibraryStreamsToKept(
    USER,
    { watchListItemId: item.id, title: item.title, mediaType: item.mediaType },
    { db: fakeDb(store) },
  );
  store.library = store.library.filter((row) => row.id !== itemId);
}

/** The old behaviour, kept so the danger it created is stated, not assumed. */
function removeFromLibraryWithoutPromotion(store: Store, itemId: string): void {
  store.library = store.library.filter((row) => row.id !== itemId);
}

async function evictable(store: Store, now: Date) {
  resetForegroundState();
  return listEvictableStreams(USER, { db: fakeDb(store), now });
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

async function behaviour() {
  const now = new Date("2026-08-02T12:00:00Z");

  await check("a streamed episode is protected while its title is in the library", async () => {
    const store = freshStore(now);
    const listed = await evictable(store, now);
    assert.deepEqual(listed.candidates, [], "nothing may be reclaimable yet");
    assert.deepEqual(
      listed.skipped.map((s) => s.reason),
      ["watchlisted"],
      "the library row is the only thing holding it",
    );
  });

  await check("removing the row WITHOUT promoting is what exposes the files", async () => {
    // This is the defect, stated as a fact rather than described. If this case
    // ever stops finding a candidate, the guard being fixed has moved and the
    // fix below needs re-deriving — it is not simply passing for free.
    const store = freshStore(now);
    removeFromLibraryWithoutPromotion(store, ITEM);
    const listed = await evictable(store, now);
    assert.equal(
      listed.candidates.length,
      1,
      "the sweep would now delete 2 GB the user was told they kept",
    );
    assert.equal(listed.candidates[0].hash, HASH);
  });

  await check("removing the row through the route leaves nothing reclaimable", async () => {
    const store = freshStore(now);
    await removeFromLibrary(store, ITEM);

    assert.deepEqual(store.library, [], "the title really is out of the library");
    assert.equal(
      store.engine[0].origin,
      USER_ORIGIN,
      "the streamed episode is now a kept download",
    );

    const listed = await evictable(store, now);
    assert.deepEqual(listed.candidates, [], "no candidate");
    assert.deepEqual(listed.skipped, [], "and not merely skipped — no stream row exists");
    assert.equal(listed.usedBytes, 0);
  });

  await check("the files themselves are never touched by a library removal", async () => {
    const store = freshStore(now);
    const before = store.engine.map((row) => ({ ...row }));
    await removeFromLibrary(store, ITEM);
    assert.equal(store.engine.length, before.length, "no engine row may be dropped");
    assert.equal(store.engine[0].hash, before[0].hash);
    assert.equal(store.engine[0].sizeBytes, before[0].sizeBytes, "no bytes released");
    assert.equal(store.progress.length, 1, "watch position survives too");
  });

  await check("removing a title the user does not own changes nothing", async () => {
    const store = freshStore(now);
    await removeFromLibrary(store, "someone-elses-item");
    assert.equal(store.library.length, 1);
    assert.equal(store.engine[0].origin, STREAM_ORIGIN);
  });
}

// ---------------------------------------------------------------------------
// Source shape
// ---------------------------------------------------------------------------

const ROUTE = fs.readFileSync("src/app/api/watchlist/route.ts", "utf8");

/** Just the DELETE handler, so a match in POST/PATCH cannot stand in for it. */
function deleteHandler(): string {
  const start = ROUTE.indexOf("export async function DELETE(");
  assert.ok(start > -1, "the route must still export DELETE");
  const after = ROUTE.indexOf("export async function ", start + 10);
  return after > -1 ? ROUTE.slice(start, after) : ROUTE.slice(start);
}

function sourceShape() {
  const handler = deleteHandler();
  return [
    check("DELETE keeps the files by promoting BEFORE it removes the row", () => {
      const promoteAt = handler.indexOf("promoteLibraryStreamsToKept");
      const deleteAt = handler.indexOf("watchListItem.deleteMany");
      assert.ok(promoteAt > -1, "the title's streams must be promoted to kept");
      assert.ok(deleteAt > -1, "the library row must still be removed");
      assert.ok(
        promoteAt < deleteAt,
        "promote first: the reverse order leaves a window in which the sweep may " +
          "reclaim files the user was just told are safe",
      );
    }),

    check("DELETE never reaches for anything that removes media", () => {
      for (const forbidden of [
        "deleteTorrent",
        "engineTorrent.deleteMany",
        "fsp.rm",
        "fs.rm",
        "unlink",
        "rmSync",
        "sweepRetentionCache",
        "reclaimForBytes",
        "evictStreamCacheForBudget",
      ]) {
        assert.equal(
          handler.includes(forbidden),
          false,
          `removing from the library must not call ${forbidden}`,
        );
      }
    }),

    check("DELETE stays authorised and scoped to the session user", () => {
      assert.match(handler, /await auth\(\)/);
      assert.match(handler, /status:\s*401/);
      assert.match(handler, /guardBrowserMutation\(request\)/);
      // Every read and write, not just the delete: choosing what to promote from
      // another user's row would be a cross-account leak of its own.
      const scoped = handler.match(/userId:\s*session\.user\.id/g) ?? [];
      assert.ok(
        scoped.length >= 2,
        `both the lookup and the delete must be user-scoped (found ${scoped.length})`,
      );
      assert.match(handler, /promoteLibraryStreamsToKept\(\s*session\.user\.id/);
    }),
  ];
}

// ---------------------------------------------------------------------------
// What the user is told
// ---------------------------------------------------------------------------

function copy() {
  return [
    check("the confirm dialog promises the files survive, in words", () => {
      const c = removeFromLibraryCopy("Severance");
      assert.equal(
        c.body,
        "“Severance” leaves your library and TorrentFlow stops looking for new " +
          "episodes. Downloaded files are kept — nothing is removed from your disk. " +
          "To remove the files too, use “Delete files” under More options before you " +
          "remove the title.",
      );
      // The exact string above is a drift guard. These are the properties that
      // make it correct, and they must survive any rewording.
      assert.match(c.body, /Severance/, "the user must see which title this is");
      assert.match(c.body, /\bkept\b/, "the survival of the files must be stated");
      assert.match(c.body, /nothing is removed from your disk/i);
      assert.match(c.confirmLabel, /keep/i, "the button itself states the outcome");
    }),

    check("the copy never implies this deletes anything of the user's", () => {
      const c = removeFromLibraryCopy("Severance");
      const whole = `${c.title} ${c.body} ${c.confirmLabel}`;
      assert.doesNotMatch(
        whole,
        /files? (?:will be|are|get) (?:deleted|erased|wiped)/i,
        "a deletion promise here is the opposite of what the route does",
      );
      // The old copy talked about a system the user does not have. Almost every
      // install uses the built-in engine, so "your torrent client" either meant
      // nothing or meant the opposite of the truth.
      assert.doesNotMatch(whole, /torrent client/i);
    }),

    check("a title with no name still reads as a sentence", () => {
      const c = removeFromLibraryCopy("   ");
      assert.match(c.body, /^This title leaves your library/);
      assert.doesNotMatch(c.body, /“”/, "an empty quote reads as a rendering bug");
      assert.match(c.body, /\bkept\b/, "the promise holds for an unnamed row too");
    }),
  ];
}

async function main() {
  await behaviour();
  // Awaited, not fired and forgotten. An earlier draft called these without
  // awaiting, so their failures landed after the exit check and could not turn
  // the run red — a suite that cannot fail is the thing this repo bans.
  await Promise.all([...sourceShape(), ...copy()]);
  if (failures > 0) {
    console.error(`\n${failures} remove-keeps-files test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll remove-keeps-files tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
