import type {
  ClientConnectionConfig,
  TorrentClientType,
} from "./types";
import type {
  ClientTorrent,
  OwnedClientTorrent,
} from "@/lib/torrents/types";

export interface ClientListIssue {
  clientType: TorrentClientType;
  error: unknown;
}

export interface OwnedTransferSnapshot {
  torrents: OwnedClientTorrent[];
  issues: ClientListIssue[];
  availableClientTypes: TorrentClientType[];
}

export type ClientTorrentLister = (
  config: ClientConnectionConfig,
) => Promise<ClientTorrent[]>;

export function clientTypeLabel(type: TorrentClientType): string {
  if (type === "builtin") return "Built-in";
  if (type === "transmission") return "Transmission";
  return "qBittorrent";
}

export function transferIdFor(
  clientType: TorrentClientType,
  hash: string,
): string {
  return `${clientType}:${hash.trim().toLowerCase()}`;
}

export function tagOwnedTorrents(
  clientType: TorrentClientType,
  torrents: readonly ClientTorrent[],
): OwnedClientTorrent[] {
  const byId = new Map<string, OwnedClientTorrent>();
  for (const torrent of torrents) {
    const hash = torrent.hash?.trim();
    if (!hash) continue;
    const transferId = transferIdFor(clientType, hash);
    byId.set(transferId, {
      ...torrent,
      hash,
      ownerClientType: clientType,
      ownerClientLabel: clientTypeLabel(clientType),
      transferId,
    });
  }
  return [...byId.values()];
}

/**
 * Every configured client whose existing transfers remain relevant.
 * Preference decides future dispatch only, so the built-in engine is always a
 * source and a configured external remains a source whichever is preferred.
 */
export function configuredClientSources(
  config: ClientConnectionConfig,
): ClientConnectionConfig[] {
  const sources = new Map<TorrentClientType, ClientConnectionConfig>();
  sources.set("builtin", { ...config, clientType: "builtin" });

  if (config.clientType !== "builtin") {
    sources.set(config.clientType, config);
  }
  if (
    config.externalClientType === "qbittorrent" ||
    config.externalClientType === "transmission"
  ) {
    sources.set(config.externalClientType, {
      ...config,
      clientType: config.externalClientType,
    });
  }
  return [...sources.values()];
}

export function resolveOwnerClientConfig(
  config: ClientConnectionConfig,
  ownerClientType: TorrentClientType,
): ClientConnectionConfig | null {
  return (
    configuredClientSources(config).find(
      (candidate) => candidate.clientType === ownerClientType,
    ) ?? null
  );
}

export async function aggregateOwnedTorrents(
  config: ClientConnectionConfig,
  list: ClientTorrentLister,
): Promise<OwnedTransferSnapshot> {
  const results = await Promise.all(
    configuredClientSources(config).map(async (source) => {
      try {
        return {
          ok: true as const,
          clientType: source.clientType,
          torrents: tagOwnedTorrents(source.clientType, await list(source)),
        };
      } catch (error) {
        return {
          ok: false as const,
          clientType: source.clientType,
          error,
        };
      }
    }),
  );

  return {
    torrents: results.flatMap((result) =>
      result.ok ? result.torrents : [],
    ),
    issues: results.flatMap((result) =>
      result.ok
        ? []
        : [{ clientType: result.clientType, error: result.error }],
    ),
    availableClientTypes: results.flatMap((result) =>
      result.ok ? [result.clientType] : [],
    ),
  };
}

export async function verifyOwnedTransfer(
  config: ClientConnectionConfig,
  ownerClientType: TorrentClientType,
  hash: string,
  list: ClientTorrentLister,
): Promise<{
  config: ClientConnectionConfig;
  torrent: OwnedClientTorrent;
} | null> {
  const ownerConfig = resolveOwnerClientConfig(config, ownerClientType);
  if (!ownerConfig) return null;
  const wanted = transferIdFor(ownerClientType, hash);
  const torrent = tagOwnedTorrents(
    ownerClientType,
    await list(ownerConfig),
  ).find((candidate) => candidate.transferId === wanted);
  return torrent ? { config: ownerConfig, torrent } : null;
}

export async function otherOwnerState(
  config: ClientConnectionConfig,
  excludedOwner: TorrentClientType,
  hash: string,
  list: ClientTorrentLister,
): Promise<"present" | "absent" | "unknown"> {
  const others = configuredClientSources(config).filter(
    (source) => source.clientType !== excludedOwner,
  );
  const results = await Promise.allSettled(
    others.map((source) => list(source)),
  );
  const wanted = hash.trim().toLowerCase();
  for (const result of results) {
    if (
      result.status === "fulfilled" &&
      result.value.some(
        (torrent) => torrent.hash?.trim().toLowerCase() === wanted,
      )
    ) {
      return "present";
    }

  }
  return results.some((result) => result.status === "rejected")
    ? "unknown"
    : "absent";
}

export async function inspectOtherOwners(
  config: ClientConnectionConfig,
  excludedOwner: TorrentClientType,
  hash: string,
  list: ClientTorrentLister,
): Promise<{ torrents: OwnedClientTorrent[]; unknown: boolean }> {
  const others = configuredClientSources(config).filter(
    (source) => source.clientType !== excludedOwner,
  );
  const results = await Promise.allSettled(
    others.map(async (source) =>
      tagOwnedTorrents(source.clientType, await list(source)),
    ),
  );
  const wanted = hash.trim().toLowerCase();
  return {
    torrents: results.flatMap((result) =>
      result.status === "fulfilled"
        ? result.value.filter(
            (torrent) => torrent.hash.trim().toLowerCase() === wanted,
          )
        : [],
    ),
    unknown: results.some((result) => result.status === "rejected"),
  };
}

function normalizedStoragePath(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().replace(/\//g, "\\").replace(/\\+$/, "");
  return normalized ? normalized.toLowerCase() : null;
}

export function transferStoragePathsOverlap(
  first: string | null | undefined,
  second: string | null | undefined,
): boolean {
  const a = normalizedStoragePath(first);
  const b = normalizedStoragePath(second);
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
}

export async function ownedTransferState(
  config: ClientConnectionConfig,
  ownerClientType: TorrentClientType,
  hash: string,
  list: ClientTorrentLister,
): Promise<"present" | "absent" | "unknown"> {
  try {
    return (await verifyOwnedTransfer(
      config,
      ownerClientType,
      hash,
      list,
    ))
      ? "present"
      : "absent";
  } catch {
    return "unknown";
  }
}

/**
 * Keep last-known rows belonging to a client that failed this poll, while
 * replacing every successfully queried client's rows with the fresh answer.
 */
export function mergeOwnedTransferSnapshots(
  previous: readonly OwnedClientTorrent[],
  fresh: readonly OwnedClientTorrent[],
  unavailableClientTypes: readonly TorrentClientType[],
): OwnedClientTorrent[] {
  const unavailable = new Set(unavailableClientTypes);
  const merged = new Map<string, OwnedClientTorrent>();
  for (const torrent of previous) {
    if (unavailable.has(torrent.ownerClientType)) {
      merged.set(torrent.transferId, torrent);
    }
  }
  for (const torrent of fresh) merged.set(torrent.transferId, torrent);
  return [...merged.values()];
}

/**
 * The one external connection is retained even while it is preferred, so
 * switching back to built-in never discards the secondary configuration.
 */
export function retainedExternalClientType(
  preferred: TorrentClientType,
  requested: string | null | undefined,
  existing: string | null | undefined,
): "qbittorrent" | "transmission" | null {
  if (preferred === "qbittorrent" || preferred === "transmission") {
    return preferred;
  }
  const candidate = requested === undefined ? existing : requested;
  return candidate === "qbittorrent" || candidate === "transmission"
    ? candidate
    : null;
}
