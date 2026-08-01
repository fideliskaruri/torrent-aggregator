import type { ClientTorrent } from "@/lib/torrents/types";
import type {
  AddTorrentPayload,
  AddTorrentResult,
  ClientConnectionConfig,
  TorrentClientAdapter,
} from "./types";
import { resolveDownloadTarget } from "./types";

export type TransmissionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TransmissionRpcResponse {
  result: string;
  arguments?: unknown;
}

export function buildTransmissionRpcRequest(
  config: ClientConnectionConfig,
  method: string,
  args: Record<string, unknown>,
  sessionId?: string,
): { url: string; init: RequestInit } {
  const base = config.host.replace(/\/+$/, "");
  const url = base.endsWith("/transmission/rpc")
    ? base
    : `${base}/transmission/rpc`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.username || config.password) {
    const token = Buffer.from(
      `${config.username ?? ""}:${config.password ?? ""}`,
    ).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }
  if (sessionId) headers["X-Transmission-Session-Id"] = sessionId;
  return {
    url,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ method, arguments: args }),
      signal: AbortSignal.timeout(12_000),
    },
  };
}

export function buildTransmissionAddArguments(
  config: ClientConnectionConfig,
  payload: AddTorrentPayload,
):
  | { ok: true; args: Record<string, unknown>; category: string | null; savePath: string | null }
  | { ok: false; message: string } {
  const filename = payload.magnet ?? payload.torrentUrl;
  if (!filename) return { ok: false, message: "No magnet or torrent URL provided" };
  const target = resolveDownloadTarget(config, {
    category: payload.category,
    savePath: payload.savePath,
  });
  const args: Record<string, unknown> = { filename };
  if (target.savePath) args["download-dir"] = target.savePath;
  if (target.category) args.labels = [target.category];
  return {
    ok: true,
    args,
    category: target.category ?? null,
    savePath: target.savePath ?? null,
  };
}

function parseRpcResponse(value: unknown): TransmissionRpcResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Transmission returned an invalid RPC response");
  }
  const fields = new Map(Object.entries(value));
  const result = fields.get("result");
  if (typeof result !== "string") {
    throw new Error("Transmission RPC response is missing result");
  }
  return { result, arguments: fields.get("arguments") };
}

/**
 * Transmission RPC client (JSON-RPC over HTTP).
 */
export class TransmissionClient implements TorrentClientAdapter {
  readonly type = "transmission" as const;

  constructor(private readonly fetchFn: TransmissionFetch = fetch) {}

  async testConnection(
    config: ClientConnectionConfig,
  ): Promise<AddTorrentResult> {
    try {
      const result = await this.rpc(config, "session-get", {});
      const args =
        result.arguments !== null &&
        typeof result.arguments === "object" &&
        !Array.isArray(result.arguments)
          ? new Map(Object.entries(result.arguments))
          : null;
      const rawVersion = args?.get("version");
      const version = typeof rawVersion === "string" ? rawVersion : "unknown";
      return { ok: true, message: `Connected to Transmission ${version}` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async addTorrent(
    config: ClientConnectionConfig,
    payload: AddTorrentPayload,
  ): Promise<AddTorrentResult> {
    try {
      const built = buildTransmissionAddArguments(config, payload);
      if (!built.ok) return built;
      await this.rpc(config, "torrent-add", built.args);

      const where = [
        built.category ? `label “${built.category}”` : null,
        built.savePath ? `folder ${built.savePath}` : null,
      ]
        .filter(Boolean)
        .join(", ");

      return {
        ok: true,
        message: where
          ? `Torrent added to Transmission (${where})`
          : "Torrent added to Transmission",
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listTorrents(config: ClientConnectionConfig): Promise<ClientTorrent[]> {
    const result = await this.rpc(config, "torrent-get", {
      fields: [
        "hashString",
        "name",
        "percentDone",
        "totalSize",
        "rateDownload",
        "rateUpload",
        "status",
        "eta",
        "labels",
        "downloadDir",
      ],
    });
    if (
      result.arguments === null ||
      typeof result.arguments !== "object" ||
      Array.isArray(result.arguments)
    ) {
      return [];
    }
    const torrents = new Map(Object.entries(result.arguments)).get("torrents");
    if (!Array.isArray(torrents)) return [];
    const out: ClientTorrent[] = [];
    for (const value of torrents) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const fields = new Map(Object.entries(value));
      const hash = fields.get("hashString");
      const name = fields.get("name");
      const progress = fields.get("percentDone");
      const sizeBytes = fields.get("totalSize");
      const dlspeed = fields.get("rateDownload");
      const upspeed = fields.get("rateUpload");
      const status = fields.get("status");
      const eta = fields.get("eta");
      const labels = fields.get("labels");
      const downloadDir = fields.get("downloadDir");
      if (
        typeof hash !== "string" ||
        typeof name !== "string" ||
        typeof progress !== "number" ||
        typeof sizeBytes !== "number" ||
        typeof dlspeed !== "number" ||
        typeof upspeed !== "number" ||
        typeof status !== "number"
      ) {
        continue;
      }
      out.push({
        hash,
        name,
        progress,
        sizeBytes,
        dlspeed,
        upspeed,
        state: transmissionStatus(status),
        eta: typeof eta === "number" && eta > 0 ? eta : undefined,
        category:
          Array.isArray(labels) && typeof labels[0] === "string"
            ? labels[0]
            : undefined,
        savePath: typeof downloadDir === "string" && downloadDir ? downloadDir : null,
      });
    }
    return out;
  }

  async pauseTorrent(
    config: ClientConnectionConfig,
    hash: string,
  ): Promise<AddTorrentResult> {
    try {
      await this.rpc(config, "torrent-stop", { ids: [hash] });
      return { ok: true, message: "Paused" };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async resumeTorrent(
    config: ClientConnectionConfig,
    hash: string,
  ): Promise<AddTorrentResult> {
    try {
      await this.rpc(config, "torrent-start", { ids: [hash] });
      return { ok: true, message: "Resumed" };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async deleteTorrent(
    config: ClientConnectionConfig,
    hash: string,
    deleteFiles = false,
  ): Promise<AddTorrentResult> {
    try {
      await this.rpc(config, "torrent-remove", {
        ids: [hash],
        "delete-local-data": deleteFiles,
      });
      return { ok: true, message: "Removed" };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async rpc(
    config: ClientConnectionConfig,
    method: string,
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<TransmissionRpcResponse> {
    const request = buildTransmissionRpcRequest(config, method, args, sessionId);
    const res = await this.fetchFn(request.url, request.init);

    if (res.status === 409) {
      const sid =
        res.headers.get("X-Transmission-Session-Id") ??
        res.headers.get("x-transmission-session-id");
      if (!sid) throw new Error("Transmission CSRF handshake failed");
      if (sessionId) throw new Error("Transmission rejected the refreshed session");
      return this.rpc(config, method, args, sid);
    }

    if (!res.ok) throw new Error(`Transmission RPC HTTP ${res.status}`);

    const value: unknown = await res.json();
    const json = parseRpcResponse(value);

    if (json.result !== "success") {
      throw new Error(json.result || "Transmission RPC error");
    }

    return json;
  }
}

function transmissionStatus(code: number): string {
  switch (code) {
    case 0:
      return "stopped";
    case 1:
      return "queuedCheck";
    case 2:
      return "checking";
    case 3:
      return "queuedDownload";
    case 4:
      return "downloading";
    case 5:
      return "queuedSeed";
    case 6:
      return "seeding";
    default:
      return `status_${code}`;
  }
}

export const transmissionClient = new TransmissionClient();
