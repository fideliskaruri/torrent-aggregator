import type { ClientTorrent } from "@/lib/torrents/types";

export type TorrentClientType = "qbittorrent" | "transmission" | "builtin";

export interface ClientConnectionConfig {
  clientType: TorrentClientType;
  host: string;
  username?: string | null;
  password?: string | null;
  /** Default category / label */
  category?: string | null;
  /** Default download directory (legacy / fallback) */
  savePath?: string | null;
  /**
   * Base download folder. When set and a category has no explicit pathRule,
   * the target resolves to join(baseDownloadPath, category).
   */
  baseDownloadPath?: string | null;
  /**
   * Max total bytes under baseDownloadPath. Null = default policy cap (100GB).
   * Enforced automatically before every download.
   */
  maxStorageBytes?: number | null;
  /** Quick-pick categories */
  categories?: string[];
  /** Map category → download folder (overrides base/Category) */
  pathRules?: Record<string, string>;
  /**
   * Owning user for built-in engine durability (EngineTorrent rows).
   * Optional so external clients and connection tests stay unchanged.
   */
  userId?: string | null;
  /**
   * Optional secondary client (qBittorrent / Transmission) for
   * "Send / move to my client" while primary stays built-in.
   * host/username/password on this config always apply to external when set.
   */
  externalClientType?: "qbittorrent" | "transmission" | null;
}

/** True when user has saved an optional external WebUI for dual-send. */
export function hasExternalClient(
  config: Pick<ClientConnectionConfig, "externalClientType" | "host">,
): boolean {
  const t = config.externalClientType;
  return (t === "qbittorrent" || t === "transmission") && Boolean(config.host?.trim());
}

/** Config for talking to the optional external client only. */
export function externalClientConfig(
  config: ClientConnectionConfig,
): ClientConnectionConfig | null {
  if (!hasExternalClient(config) || !config.externalClientType) return null;
  return {
    ...config,
    clientType: config.externalClientType,
  };
}

export interface AddTorrentPayload {
  magnet?: string;
  torrentUrl?: string;
  name?: string;
  /** Override category for this send */
  category?: string | null;
  /** Override download folder for this send */
  savePath?: string | null;
}

export interface AddTorrentResult {
  ok: boolean;
  message: string;
}

export interface TorrentClientAdapter {
  readonly type: TorrentClientType;
  testConnection(config: ClientConnectionConfig): Promise<AddTorrentResult>;
  addTorrent(
    config: ClientConnectionConfig,
    payload: AddTorrentPayload,
  ): Promise<AddTorrentResult>;
  listTorrents?(config: ClientConnectionConfig): Promise<ClientTorrent[]>;
  pauseTorrent?(
    config: ClientConnectionConfig,
    hash: string,
  ): Promise<AddTorrentResult>;
  resumeTorrent?(
    config: ClientConnectionConfig,
    hash: string,
  ): Promise<AddTorrentResult>;
  deleteTorrent?(
    config: ClientConnectionConfig,
    hash: string,
    deleteFiles?: boolean,
  ): Promise<AddTorrentResult>;
}

export type { ClientTorrent };

/** Join base + category using the separator implied by the base path. */
export function joinDownloadPath(base: string, category: string): string {
  const b = base.replace(/[/\\]+$/, "");
  const cat = category.replace(/^[/\\]+|[/\\]+$/g, "");
  if (!b) return cat;
  if (!cat) return b;
  const sep = b.includes("\\") ? "\\" : "/";
  return `${b}${sep}${cat}`;
}

/**
 * Resolve category + save path for a send.
 * Priority:
 * 1. explicit savePath override
 * 2. pathRules[category]
 * 3. join(baseDownloadPath, category) when base is set
 * 4. savePath default, then baseDownloadPath alone
 */
export function resolveDownloadTarget(
  config: ClientConnectionConfig,
  override?: { category?: string | null; savePath?: string | null },
): { category: string | null; savePath: string | null } {
  const category =
    (override?.category !== undefined && override.category !== ""
      ? override.category
      : config.category) || null;

  let savePath: string | null = null;

  if (override?.savePath !== undefined && override.savePath !== null && override.savePath !== "") {
    savePath = override.savePath;
  }

  // Explicit per-category rule wins
  if (!savePath && category && config.pathRules?.[category]) {
    savePath = config.pathRules[category];
  }

  // Smart path: baseDownloadPath / Category when no rule is set
  if (!savePath && category && config.baseDownloadPath?.trim()) {
    savePath = joinDownloadPath(config.baseDownloadPath.trim(), category);
  }

  if (!savePath) {
    savePath =
      config.savePath?.trim() ||
      config.baseDownloadPath?.trim() ||
      null;
  }

  return {
    category: category?.trim() || null,
    savePath: savePath?.trim() || null,
  };
}
