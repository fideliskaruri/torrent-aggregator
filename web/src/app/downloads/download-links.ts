import { titlePath } from "@/components/title/work-key";
import type { ClientTorrent } from "./types";

export function downloadTitleHref(torrent: ClientTorrent): string | null {
  const workKey = torrent.workKey?.trim();
  const workTitle = torrent.workTitle?.trim();
  if (!workKey || !workTitle) return null;
  return titlePath(workKey, {
    title: workTitle,
    year: torrent.workYear ?? null,
    mediaType: torrent.workMediaType ?? torrent.category ?? null,
    season: torrent.season ?? null,
  });
}
