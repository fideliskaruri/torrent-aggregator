function padEp(n: number): string {
  return n.toString().padStart(2, "0");
}

export function formatEpisodeNumber(episode: number): string {
  return padEp(episode);
}

export function formatSeasonLabel(season: number): string {
  return `S${padEp(season)}`;
}

export function formatEpisodeLabel(season: number, episode: number): string {
  return `${formatSeasonLabel(season)}E${formatEpisodeNumber(episode)}`;
}
