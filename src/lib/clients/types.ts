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
   * Max total bytes under baseDownloadPath. Null/0 means setup is incomplete,
   * and new downloads must be refused.
   */
  maxStorageBytes?: number | null;
  /** Opt-in, redacted acquisition decision logs. */
  verboseDiagnostics?: boolean;
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

/**
 * Why a torrent is being added. REQUIRED at every add boundary so an intent can
 * never be left unstated — the type system forbids it. Exactly one value drives
 * file selection, `EngineTorrent.origin`, download-history behaviour, restart
 * rehydration, and eviction policy (see {@link resolveEffectiveAdd}).
 *
 *   - `keep`    Explicit, permanent Download. Whole file, appears in downloads,
 *               never auto-deleted.
 *   - `stream`  Ephemeral Play. Fetch only the pieces the player needs; an
 *               evictable cache; never listed as a download.
 *   - `prewarm` Speculative next-episode warming. Deselected + peer-capped;
 *               evictable; the user never asked for it.
 *
 * External clients (qBittorrent / Transmission) have no per-piece model and
 * ignore the value beyond recording it — every external send is a whole-file
 * download by nature.
 */
export type TorrentPurpose = "keep" | "stream" | "prewarm";

export interface AddTorrentPayload {
  magnet?: string;
  torrentUrl?: string;
  name?: string;
  /**
   * Required acquisition intent. Replaces the old `streamOnly` / `connectOnly`
   * boolean pair: those could be computed, carried, then never consulted, which
   * is exactly how a Play came to be recorded as a permanent Download. There is
   * no default — the caller must say why.
   */
  purpose: TorrentPurpose;
  /** Override category for this send */
  category?: string | null;
  /** Override download folder for this send */
  savePath?: string | null;
  /**
   * A storage limit already refused this send, the owner was shown the real
   * figures, and they chose to proceed.
   *
   * This has to travel with the payload because the engine runs its **own**
   * storage check before adding (`checkStoragePolicy`). Without the flag that
   * second check re-refused everything the caller had just been given
   * permission for, so "Download anyway" passed the route gate and then failed
   * anyway — measured live as a 502 still carrying the cap message.
   *
   * It is not a bypass: the engine re-derives what may be overridden through
   * `isOverridableLimit`, so this can never get past `wont-fit` or `setup`.
   */
  overrideStorageCap?: boolean;
}

export type AddTorrentDetails =
  | {
      type: "builtin-transfer";
      action: "started" | "already_downloading" | "already_complete";
      pct: number;
      peers: number;
    };

export interface AddTorrentResult {
  ok: boolean;
  message: string;
  details?: AddTorrentDetails;
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
