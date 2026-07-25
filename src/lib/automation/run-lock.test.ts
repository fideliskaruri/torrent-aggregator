/**
 * Run-lock behaviour.
 *
 * The HTTP-level concurrency check is not deterministic — with an empty
 * watchlist a run finishes in milliseconds and two "concurrent" requests never
 * actually overlap. These assertions exercise the lock directly.
 */
import prisma from "@/lib/prisma";
import {
  acquireRunLock,
  releaseRunLock,
  RUN_LOCK_STALE_MS,
} from "./run-lock";

let failures = 0;

function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const USER = `runlock-test-${process.pid}`;

async function cleanup() {
  await prisma.runLock.deleteMany({ where: { userId: USER } });
}

async function main() {
  await cleanup();

  // A free lock is granted.
  const first = await acquireRunLock(USER, "automation");
  assert("first acquire succeeds", first !== null);

  // A second run for the same user+scope is refused.
  const second = await acquireRunLock(USER, "automation");
  assert("second acquire is refused while held", second === null, `got ${second}`);

  // A different scope is independent — rules and automation must not block
  // each other, only runs of the same kind.
  const otherScope = await acquireRunLock(USER, "rules");
  assert("a different scope is independent", otherScope !== null);
  await releaseRunLock(otherScope);

  // A different user is independent.
  const otherUser = await acquireRunLock(`${USER}-b`, "automation");
  assert("a different user is independent", otherUser !== null);
  await releaseRunLock(otherUser);
  await prisma.runLock.deleteMany({ where: { userId: `${USER}-b` } });

  // Releasing frees it for the next run.
  await releaseRunLock(first);
  const third = await acquireRunLock(USER, "automation");
  assert("acquire succeeds again after release", third !== null);
  await releaseRunLock(third);

  // Releasing a null id (the "we never held it" path) must not throw.
  let threw = false;
  try {
    await releaseRunLock(null);
  } catch {
    threw = true;
  }
  assert("releasing a null lock is a no-op", !threw);

  // A crashed run must not block automation forever: a lock older than the
  // stale window is reclaimed.
  const stale = await prisma.runLock.create({
    data: { userId: USER, scope: "automation" },
  });
  await prisma.runLock.update({
    where: { id: stale.id },
    data: { acquiredAt: new Date(Date.now() - RUN_LOCK_STALE_MS - 1000) },
  });
  const afterStale = await acquireRunLock(USER, "automation");
  assert("a stale lock is reclaimed", afterStale !== null);
  assert("the reclaimed lock is a new one", afterStale !== stale.id);
  await releaseRunLock(afterStale);

  // A lock that is merely old-but-live is NOT reclaimed.
  const live = await prisma.runLock.create({
    data: { userId: USER, scope: "automation" },
  });
  await prisma.runLock.update({
    where: { id: live.id },
    data: { acquiredAt: new Date(Date.now() - RUN_LOCK_STALE_MS + 60_000) },
  });
  const blocked = await acquireRunLock(USER, "automation");
  assert("a live lock inside the stale window still blocks", blocked === null);
  await releaseRunLock(live.id);

  // Concurrent acquires: exactly one winner.
  const racers = await Promise.all(
    Array.from({ length: 5 }, () => acquireRunLock(USER, "automation")),
  );
  const winners = racers.filter((r) => r !== null);
  assert(
    "exactly one of five concurrent acquires wins",
    winners.length === 1,
    `${winners.length} winners`,
  );
  for (const w of winners) await releaseRunLock(w);

  await cleanup();
  await prisma.$disconnect();

  console.log(failures === 0 ? "\nPASS run-lock" : `\nFAIL run-lock (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("FAIL run-lock:", err);
  await cleanup().catch(() => {});
  process.exit(1);
});
