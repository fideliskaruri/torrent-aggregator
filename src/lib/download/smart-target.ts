/**
 * Shared smart category + path resolution for send / automation / rules.
 * Mirrors /api/torrent/send so every path nests show folders the same way.
 */
import {
  smartCategorize,
  resolveSmartPath,
  type ContentKind,
} from "@/lib/download/smart-category";
import {
  resolveDownloadTarget,
  type ClientConnectionConfig,
} from "@/lib/clients/types";
import type { MediaMetadata, TorrentSourceId } from "@/lib/torrents/types";

export type SmartSendTarget = {
  category: string | null;
  savePath: string | null;
  kind: ContentKind;
  smart: {
    kind: ContentKind;
    category: string;
    confidence: "high" | "medium" | "low";
  };
};

export type ResolveSmartSendOptions = {
  name: string;
  tags?: string[];
  metadata?: MediaMetadata | null;
  source?: string | null;
  searchCategory?: string | null;
  /** When true, trust category as manual override */
  categoryManual?: boolean;
  category?: string | null;
  /** Explicit save path override (skip smart resolution) */
  savePath?: string | null;
};

/**
 * Resolve category + save path the same way as /api/torrent/send.
 */
export function resolveSmartSendTarget(
  config: ClientConnectionConfig,
  options: ResolveSmartSendOptions,
): SmartSendTarget {
  const name = options.name || "";
  const smart = smartCategorize(
    {
      title: name,
      tags: options.tags ?? [],
      metadata: options.metadata ?? null,
      source: (options.source ?? "apibay") as TorrentSourceId,
    },
    config.categories ?? [],
    options.searchCategory,
  );

  const category = options.categoryManual
    ? options.category || smart.category
    : smart.category;

  const kind = smart.kind as ContentKind;
  const cat = category || smart.category;
  const sepGuess =
    (config.baseDownloadPath || config.pathRules?.[cat || ""] || "").includes(
      "\\",
    )
      ? "\\"
      : "/";

  let savePath: string | null =
    options.savePath !== undefined &&
    options.savePath !== null &&
    options.savePath !== ""
      ? options.savePath
      : null;

  if (!savePath && cat && config.pathRules?.[cat]?.trim()) {
    const ruleRoot = config.pathRules[cat].trim();
    savePath = resolveSmartPath(ruleRoot, kind, "", {
      title: name,
      metadata: options.metadata,
      nestShowFolder: true,
      separator: ruleRoot.includes("\\") ? "\\" : sepGuess,
    });
  }

  if (!savePath && config.baseDownloadPath?.trim()) {
    const base = config.baseDownloadPath.trim();
    savePath = resolveSmartPath(base, kind, cat, {
      title: name,
      metadata: options.metadata,
      nestShowFolder: true,
      separator: base.includes("\\") ? "\\" : sepGuess,
    });
  }

  if (!savePath) {
    const target = resolveDownloadTarget(config, {
      category: cat,
      savePath: null,
    });
    savePath = target.savePath;
  }

  return {
    category: cat,
    savePath,
    kind,
    smart: {
      kind: smart.kind,
      category: smart.category,
      confidence: smart.confidence,
    },
  };
}

/** Human label for client type in error messages. */
export function clientTypeLabel(clientType: string | null | undefined): string {
  if (clientType === "builtin") return "built-in engine";
  if (clientType === "transmission") return "Transmission";
  if (clientType === "qbittorrent") return "qBittorrent";
  return clientType?.trim() || "torrent client";
}
