import type { TorrentResult } from "@/lib/torrents/types";
import { parseEpisode } from "@/lib/torrents/episodes";
import { parseResolution, parseSourceTier, SOURCE_TIER } from "@/lib/torrents/quality";

export interface SearchReleaseDisplay {
  headline: string;
  rawTitle: string;
  facts: string[];
  anchor: string;
  healthLabel: { label: "Health"; value: string } | null;
}

function sourceTierLabel(raw: string): string | null {
  const tier = parseSourceTier(raw);
  if (tier === SOURCE_TIER.WEBDL) return "WEB-DL";
  if (tier === SOURCE_TIER.HDTV) return "HDTV";
  if (tier === SOURCE_TIER.BLURAY) return "Blu-ray";
  return null;
}

function titleWithYear(title: string | null, year: number | null): string | null {
  if (!title) return null;
  return year ? `${title} (${year})` : title;
}

export function searchReleaseDisplay(
  torrent: TorrentResult,
  {
    workTitle,
    workYear,
  }: {
    workTitle?: string | null;
    workYear?: number | null;
  } = {},
): SearchReleaseDisplay {
  const rawTitle = torrent.title;
  const episode = torrent.episode?.label
    ? torrent.episode
    : parseEpisode(rawTitle);
  const resolution = parseResolution(rawTitle);
  const source = sourceTierLabel(rawTitle);
  const baseTitle = titleWithYear(workTitle ?? null, workYear ?? null) ?? rawTitle;
  const headline = episode.label ? `${baseTitle} · ${episode.label}` : baseTitle;
  const facts = [
    resolution ? `${resolution}p` : null,
    source,
  ].filter((fact): fact is string => Boolean(fact));
  const health =
    typeof torrent.health === "number" && Number.isFinite(torrent.health)
      ? Math.max(0, Math.min(100, Math.round(torrent.health)))
      : null;

  return {
    headline,
    rawTitle,
    facts,
    anchor: episode.label ?? (resolution ? `${resolution}p` : `#${torrent.source}`),
    healthLabel: health == null ? null : { label: "Health", value: `${health}%` },
  };
}
