import type { TitleEpisodeMeta } from "@/components/title/types";

const EPISODE_PLACEHOLDER_CAP = 200;

export function providerEpisodePlaceholders(
  season: number | null,
  episodesBySeason: Record<number, number> | undefined,
): TitleEpisodeMeta[] {
  if (season == null || !episodesBySeason) return [];
  const count = episodesBySeason[season];
  if (!Number.isInteger(count) || count < 1) return [];
  const capped = Math.min(count, EPISODE_PLACEHOLDER_CAP);
  return Array.from({ length: capped }, (_, index) => ({
    episode: index + 1,
    name: null,
    overview: null,
    airDate: null,
    runtimeMin: null,
    stillUrl: null,
  }));
}
