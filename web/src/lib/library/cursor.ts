/**
 * Library show cursor — what automation hunts next (SxxEyy).
 * On-demand rewatch must not rewind this cursor (Phase 3).
 */

function padEp(n: number): string {
  return n.toString().padStart(2, "0");
}

export function formatEpisodeLabel(season: number, episode: number): string {
  return `S${padEp(season)}E${padEp(episode)}`;
}
