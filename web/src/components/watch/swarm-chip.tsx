
export type SwarmSample = {
  peers: number | null;
  downloadSpeedBps: number | null;
  progress: number | null;
  observedAt: number;
};

/** One sentence a screen reader can read out on demand. */
/**
 * Returns `true` when accumulated startup samples carry the same evidence that
 * `classifySwarm` in `swarm-probe.ts` uses to call a swarm dead:
 *   peers > 0 (swarm reached) AND bytesReceived ≤ 0 (nothing delivered).
 *
 * The client-side proxies for those two conditions are:
 *   - `sample.peers > 0`  — at least one connected peer is being tracked
 *   - `sample.downloadSpeedBps === 0` AND `sample.progress === 0`
 *     — nothing is arriving and progress has not moved at all
 *
 * All three values must be non-null (measured, not unknown) in EVERY sample,
 * because "unknown" is never "dead". Requires at least `minSamples` (default 2)
 * consecutive readings before making the call — a single zero-rate sample is
 * normal during piece scheduling; a pattern is evidence.
 */
export function deadEvidenceFromSamples(
  samples: readonly SwarmSample[],
  minSamples = 2,
): boolean {
  if (samples.length < minSamples) return false;
  return samples.every(
    (s) =>
      s.peers !== null &&
      s.peers > 0 &&
      s.downloadSpeedBps !== null &&
      s.downloadSpeedBps === 0 &&
      s.progress !== null &&
      s.progress === 0,
  );
}
