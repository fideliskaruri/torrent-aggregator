import type {
  AddTorrentPayload,
  AddTorrentResult,
  ClientConnectionConfig,
  TorrentClientType,
} from "./types";
import type { ClientTorrent } from "@/lib/torrents/types";
import { qbittorrentClient } from "./qbittorrent";
import { transmissionClient } from "./transmission";
import { builtinClient } from "./builtin-engine";
import { decryptSecret } from "@/lib/crypto";
import {
  externalClientConfig,
} from "./types";
import { withFormattedAddTorrentMessage } from "./messages";

export function getClient(type: TorrentClientType) {
  if (type === "transmission") return transmissionClient;
  if (type === "builtin") return builtinClient;
  return qbittorrentClient;
}

export async function testClientConnection(
  config: ClientConnectionConfig,
): Promise<AddTorrentResult> {
  return getClient(config.clientType).testConnection(config);
}

export async function sendToClient(
  config: ClientConnectionConfig,
  payload: AddTorrentPayload,
): Promise<AddTorrentResult> {
  return withFormattedAddTorrentMessage(
    await getClient(config.clientType).addTorrent(config, payload),
  );
}

export async function listClientTorrents(
  config: ClientConnectionConfig,
): Promise<ClientTorrent[]> {
  const client = getClient(config.clientType);
  if (!client.listTorrents) {
    throw new Error("Client does not support listing torrents");
  }
  return client.listTorrents(config);
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(
  raw: string | null | undefined,
): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string" && val.trim()) out[k] = val.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export async function getUserClientConfig(
  userId: string,
): Promise<ClientConnectionConfig | null> {
  // One-app: auto-provision built-in; migrate legacy external-as-primary
  const { ensureDefaultClientSettings } = await import("./defaults");
  const settings = await ensureDefaultClientSettings(userId);

  const clientType = (settings.clientType ||
    "builtin") as ClientConnectionConfig["clientType"];
  let externalClientType =
    (settings.externalClientType as ClientConnectionConfig["externalClientType"]) ??
    null;
  if (
    externalClientType !== "qbittorrent" &&
    externalClientType !== "transmission"
  ) {
    externalClientType = null;
  }

  const maxRaw = (settings as { maxStorageBytes?: bigint | number | null })
    .maxStorageBytes;
  const capWasConfigured =
    (settings as { storageCapConfigured?: boolean | null })
      .storageCapConfigured === true;
  const hasConfiguredFolder = Boolean(
    settings.baseDownloadPath?.trim() || settings.savePath?.trim(),
  );
  const maxStorageBytes =
    !capWasConfigured || !hasConfiguredFolder || maxRaw == null
      ? null
      : typeof maxRaw === "bigint"
        ? Number(maxRaw)
        : Number(maxRaw);

  return {
    clientType,
    externalClientType,
    host: settings.host,
    username: settings.username,
    password: decryptSecret(settings.password),
    category: settings.category,
    savePath: settings.savePath,
    baseDownloadPath: settings.baseDownloadPath,
    maxStorageBytes:
      maxStorageBytes != null && Number.isFinite(maxStorageBytes)
        ? maxStorageBytes
        : null,
    categories: parseJsonArray(settings.categories),
    pathRules: parseJsonRecord(settings.pathRules),
    userId,
  };
}

/**
 * Resolve which connection to use for a send.
 * target "external" uses optional secondary client; otherwise primary.
 */
export function resolveSendConfig(
  config: ClientConnectionConfig,
  target: "primary" | "external" = "primary",
): ClientConnectionConfig {
  if (target === "external") {
    const ext = externalClientConfig(config);
    if (!ext) {
      throw new Error(
        "No external client configured. Connect qBittorrent or Transmission under Settings → optional external client.",
      );
    }
    return ext;
  }
  return config;
}

export type {
  AddTorrentPayload,
  AddTorrentResult,
  ClientConnectionConfig,
  TorrentClientType,
};

export {
  resolveDownloadTarget,
  joinDownloadPath,
  hasExternalClient,
  externalClientConfig,
} from "./types";
