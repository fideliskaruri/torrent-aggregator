/**
 * Process-local exclusion for speculative pre-rank/probe passes.
 *
 * TorrentFlow is explicitly a single-process local application, so a keyed
 * in-memory lease is the correct boundary. Foreground playback never waits on
 * this lock; only speculative callers contend, and a second pass skips.
 */
const activeUsers = new Set<string>();

export function tryAcquirePreProbeLease(userId: string): (() => void) | null {
  if (activeUsers.has(userId)) return null;
  activeUsers.add(userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUsers.delete(userId);
  };
}

export async function tryRunPreProbePass<T>(
  userId: string,
  task: () => Promise<T>,
): Promise<{ started: false } | { started: true; value: T }> {
  const release = tryAcquirePreProbeLease(userId);
  if (!release) return { started: false };
  try {
    return { started: true, value: await task() };
  } finally {
    release();
  }
}
