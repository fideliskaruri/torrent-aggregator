/**
 * Shut a test process down cleanly when it has touched the database.
 *
 * ## The crash this prevents
 *
 * `src/lib/prisma.ts` builds its client on the **libSQL adapter**, which is a
 * native module. A test that opens it and then lets Node exit on its own leaves
 * that native connection to be reclaimed during process teardown, racing the
 * JS runtime's own shutdown. On Windows that race surfaces as an access
 * violation — `exit 0xC0000005` — *after* every assertion has already printed
 * PASS. Measured on `retention-sweep.test.ts`: roughly one run in four.
 *
 * It was invisible for a long time because the suite runner forgave any
 * non-zero exit that had printed a PASS marker. That leniency exists for a good
 * reason (WebTorrent genuinely holds handles open past the last assertion) but
 * it also swallowed this. The runner now refuses to forgive NTSTATUS-shaped
 * exits, which is what surfaced the crash — and this is the other half of that
 * fix: stop producing it.
 *
 * ## Why `process.exit` and not just `$disconnect`
 *
 * Disconnecting is necessary but not sufficient. Other native handles (swarm
 * sockets, file watchers) can keep the loop alive long enough to hit the same
 * teardown race, and a test that has finished asserting has nothing left to say.
 * Exiting explicitly, *after* the adapter has been closed, makes the exit code
 * a deliberate statement rather than a side effect of whatever unwound last.
 *
 * A test that ends through this helper therefore has exactly two outcomes: 0
 * because every assertion passed, or non-zero because one did not. Nothing in
 * between, and nothing decided by teardown ordering.
 */
import prisma from "@/lib/prisma";

/**
 * Close the database connection. Safe to call more than once, and never throws
 * — a teardown failure must not turn a passing run red.
 */
export async function closeTestDb(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    /* best-effort: the process is ending either way */
  }
}

/**
 * End a database-touching test deterministically.
 *
 * @param code 0 when the assertions passed, non-zero when they did not.
 */
export async function endTestProcess(code = 0): Promise<never> {
  await closeTestDb();
  // Give the adapter's close a turn to settle before the process goes away.
  await new Promise((resolve) => setTimeout(resolve, 25));
  process.exit(code);
}

/**
 * Wrap a test's `main()` so it always ends through {@link endTestProcess}.
 *
 * Using this instead of a bare `main().catch(...)` is what makes the guarantee
 * hold for failures too: a thrown assertion still closes the database before
 * exiting, so a red run cannot *also* crash and confuse the reason it was red.
 */
export function runDbTest(main: () => Promise<void>): void {
  main()
    .then(() => endTestProcess(0))
    .catch((err) => {
      console.error(err);
      return endTestProcess(1);
    });
}
