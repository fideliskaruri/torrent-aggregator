import { qualityLabel } from "@/lib/torrents/quality";
import type { TitleOwned } from "./types";

/**
 * What an owned film or episode says instead of Download: "In your library, 720p".
 * Origin (downloaded, imported, adopted) is never part of it.
 */
export function ownedLabel(owned: TitleOwned | null | undefined): string | null {
  if (!owned) return null;
  const quality = qualityLabel(owned.resolution);
  return quality ? `In your library, ${quality}` : "In your library";
}
