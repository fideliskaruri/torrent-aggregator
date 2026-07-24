import type { ClientTorrent } from "@/lib/torrents/types";
import type {
  AddTorrentPayload,
  AddTorrentResult,
  ClientConnectionConfig,
  TorrentClientAdapter,
} from "./types";
import { resolveDownloadTarget } from "./types";

/**
 * Transmission RPC client (JSON-RPC over HTTP).
 */
export class TransmissionClient implements TorrentClientAdapter {
  readonly type = "transmission" as const;

  async testConnection(
    config: ClientConnectionConfig,
  ): Promise<AddTorrentResult> {
    try {
      const result = await this.rpc(config, "session-get", {});
      const version =
        (result?.arguments as { version?: string } | undefined)?.version ??
        "unknown";
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
      const args: Record<string, unknown> = {};
      if (payload.magnet) {
        args.filename = payload.magnet;
      } else if (payload.torrentUrl) {
        args.filename = payload.torrentUrl;
      } else {
        return { ok: false, message: "No magnet or torrent URL provided" };
      }

      const target = resolveDownloadTarget(config, {
        category: payload.category,
        savePath: payload.savePath,
      });

      if (target.savePath) args["download-dir"] = target.savePath;
      // Transmission 3+ labels (used like categories)
      if (target.category) args.labels = [target.category];

      await this.rpc(config, "torrent-add", args);

      const where = [
        target.category ? `label “${target.category}”` : null,
        target.savePath ? `folder ${target.savePath}` : null,
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
    const torrents =
      (
        result.arguments as {
          torrents?: {
            hashString: string;
            name: string;
            percentDone: number;
            totalSize: number;
            rateDownload: number;
            rateUpload: number;
            status: number;
            eta: number;
            labels?: string[];
            downloadDir?: string;
          }[];
        }
      )?.torrents ?? [];

    return torrents.map((t) => ({
      hash: t.hashString,
      name: t.name,
      progress: t.percentDone,
      sizeBytes: t.totalSize,
      dlspeed: t.rateDownload,
      upspeed: t.rateUpload,
      state: transmissionStatus(t.status),
      eta: t.eta > 0 ? t.eta : undefined,
      category: t.labels?.[0],
      savePath: t.downloadDir || null,
    }));
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
  ): Promise<{ result: string; arguments?: unknown }> {
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

    if (sessionId) {
      headers["X-Transmission-Session-Id"] = sessionId;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ method, arguments: args }),
      signal: AbortSignal.timeout(12_000),
    });

    if (res.status === 409) {
      const sid =
        res.headers.get("X-Transmission-Session-Id") ??
        res.headers.get("x-transmission-session-id");
      if (!sid) throw new Error("Transmission CSRF handshake failed");
      return this.rpc(config, method, args, sid);
    }

    if (!res.ok) throw new Error(`Transmission RPC HTTP ${res.status}`);

    const json = (await res.json()) as {
      result: string;
      arguments?: unknown;
    };

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
