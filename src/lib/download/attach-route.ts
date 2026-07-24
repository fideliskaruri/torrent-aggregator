import type { TorrentResult, DownloadRoute } from "@/lib/torrents/types";
import { parseEpisode } from "@/lib/torrents/episodes";
import {
  smartCategorize,
  resolveSmartPath,
  showFolderName,
  seasonFolderSegment,
  type ContentKind,
} from "@/lib/download/smart-category";

export interface RoutingPrefs {
  categories?: string[];
  baseDownloadPath?: string | null;
  pathRules?: Record<string, string>;
  savePath?: string | null;
}

/**
 * Server-side only: attach download routing to each result.
 * Frontend should display `route` and send commands — not re-classify.
 *
 * Paths are Sonarr-style:
 *   base/Anime/One Piece                 ← absolute-ep anime (no season)
 *   base/Anime/One Piece/Season 23       ← anime or TV when season known
 *   base/TV/Family Guy/Season 15
 * never:
 *   base/Anime/www.UIndex.org - ONE PIECE…
 *   base/Anime/One Piece 1170 mkv
 */
export function attachDownloadRoutes(
  results: TorrentResult[],
  searchCategory: string | undefined,
  prefs?: RoutingPrefs | null,
): TorrentResult[] {
  const categories = prefs?.categories?.length
    ? prefs.categories
    : ["Anime", "Movies", "TV", "Music", "Games", "Software", "Books", "Other"];

  const base = prefs?.baseDownloadPath?.trim() || null;
  const sep = base?.includes("\\") ? "\\" : "/";

  return results.map((r) => {
    const smart = smartCategorize(
      {
        title: r.title,
        tags: r.tags,
        metadata: r.metadata,
        source: r.source,
      },
      categories,
      searchCategory === "all" ? null : searchCategory,
    );

    const cleanTitle = showFolderName(r.title, r.metadata) || undefined;

    let savePath: string | null = null;

    if (prefs?.pathRules?.[smart.category]?.trim()) {
      // pathRules[category] is already the category root (e.g. D:\Torrents\Anime)
      const root = prefs.pathRules[smart.category].trim();
      savePath = resolveSmartPath(root, smart.kind as ContentKind, "", {
        title: r.title,
        metadata: r.metadata,
        nestShowFolder: true,
        separator: root.includes("\\") ? "\\" : sep,
      });
    } else if (base) {
      savePath = resolveSmartPath(base, smart.kind as ContentKind, smart.category, {
        title: r.title,
        metadata: r.metadata,
        nestShowFolder: true,
        separator: sep,
      });
    } else if (prefs?.savePath?.trim()) {
      savePath = prefs.savePath.trim();
    }

    const relativeParts: string[] = [smart.category];
    if (
      cleanTitle &&
      (smart.kind === "tv" ||
        smart.kind === "anime" ||
        smart.kind === "movies")
    ) {
      relativeParts.push(cleanTitle);
      // Season nesting for both TV and anime when a single season is known
      if (smart.kind === "tv" || smart.kind === "anime") {
        const ep = parseEpisode(r.title);
        const seasonSeg = seasonFolderSegment(ep);
        if (seasonSeg) {
          relativeParts.push(seasonSeg);
        }
      }
    }

    const route: DownloadRoute = {
      kind: smart.kind,
      category: smart.category,
      confidence: smart.confidence,
      cleanTitle: cleanTitle ?? null,
      savePath,
      relativePath: savePath ? null : relativeParts.join("/"),
    };

    return { ...r, route };
  });
}
