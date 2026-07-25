/**
 * Per-user run locks.
 *
 * Automation and rules dedupe by comparing the last-sent magnet, but that field
 * is only written after the async send completes. Two overlapping runs would
 * both read the stale value and grab the same release twice, so runs are
 * serialized per user and scope.
 */
import prisma from "@/lib/prisma";

/** Stale locks are reclaimed so a crashed run cannot block automation forever. */
export const RUN_LOCK_STALE_MS = 15 * 60 * 1000;

/** Returns the lock id, or null when another run already holds it. */
export async function acquireRunLock(
  userId: string,
  scope: string,
): Promise<string | null> {
  const cutoff = new Date(Date.now() - RUN_LOCK_STALE_MS);
  try {
    await prisma.runLock.deleteMany({
      where: { userId, scope, acquiredAt: { lt: cutoff } },
    });
  } catch {
    /* best-effort */
  }
  try {
    const lock = await prisma.runLock.create({ data: { userId, scope } });
    return lock.id;
  } catch {
    // Unique (userId, scope) violation — a run is already in flight.
    return null;
  }
}

export async function releaseRunLock(id: string | null): Promise<void> {
  if (!id) return;
  try {
    await prisma.runLock.delete({ where: { id } });
  } catch {
    /* best-effort */
  }
}
