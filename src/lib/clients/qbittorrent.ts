import type { ClientTorrent } from "@/lib/torrents/types";
import type {
  AddTorrentPayload,
  AddTorrentResult,
  ClientConnectionConfig,
  TorrentClientAdapter,
} from "./types";
import { resolveDownloadTarget } from "./types";

/**
 * qBittorrent Web UI API client (v2).
 */
export class QBittorrentClient implements TorrentClientAdapter {
  readonly type = "qbittorrent" as const;

  async testConnection(
    config: ClientConnectionConfig,
  ): Promise<AddTorrentResult> {
    try {
      const cookie = await this.login(config);
      const base = normalizeHost(config.host);
      const res = await fetch(`${base}/api/v2/app/version`, {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          message: `qBittorrent version check failed (${res.status})`,
        };
      }
      const version = await res.text();
      return { ok: true, message: `Connected to qBittorrent ${version}` };
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
      const cookie = await this.login(config);
      const base = normalizeHost(config.host);

      const built = buildQbittorrentAddBody(config, payload);
      if (!built.ok) {
        return { ok: false, message: built.message };
      }
      const { body, target } = built;

      let res: Response;
      try {
        res = await fetch(`${base}/api/v2/torrents/add`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          message: `qBittorrent unreachable at ${base} — is WebUI running? (${msg})`,
        };
      }

      const text = await res.text();
      if (!res.ok || text.toLowerCase().includes("fail")) {
        return {
          ok: false,
          message: text || `qBittorrent add failed (${res.status})`,
        };
      }

      const where = [
        target.category ? `category “${target.category}”` : null,
        target.savePath ? `folder ${target.savePath}` : null,
      ]
        .filter(Boolean)
        .join(", ");

      return {
        ok: true,
        message: where
          ? `Torrent added to qBittorrent (${where})`
          : "Torrent added to qBittorrent",
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listTorrents(config: ClientConnectionConfig): Promise<ClientTorrent[]> {
    const cookie = await this.login(config);
    const base = normalizeHost(config.host);
    const res = await fetch(`${base}/api/v2/torrents/info`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`qBittorrent list failed (${res.status})`);
    const rows = (await res.json()) as {
      hash: string;
      name: string;
      progress: number;
      size: number;
      dlspeed: number;
      upspeed: number;
      state: string;
      eta: number;
      category?: string;
      save_path?: string;
      content_path?: string;
    }[];

    return rows.map((t) => ({
      hash: t.hash,
      name: t.name,
      progress: t.progress,
      sizeBytes: t.size,
      dlspeed: t.dlspeed,
      upspeed: t.upspeed,
      state: t.state,
      eta: t.eta >= 8640000 ? undefined : t.eta,
      category: t.category,
      // Prefer save_path (dir); content_path may be a file — open-folder handles parents
      savePath: t.save_path || t.content_path || null,
    }));
  }

  async pauseTorrent(
    config: ClientConnectionConfig,
    hash: string,
  ): Promise<AddTorrentResult> {
    return this.simplePost(config, "/api/v2/torrents/pause", hash, "Paused");
  }

  async resumeTorrent(
    config: ClientConnectionConfig,
    hash: string,
  ): Promise<AddTorrentResult> {
    return this.simplePost(config, "/api/v2/torrents/resume", hash, "Resumed");
  }

  async deleteTorrent(
    config: ClientConnectionConfig,
    hash: string,
    deleteFiles = false,
  ): Promise<AddTorrentResult> {
    try {
      const cookie = await this.login(config);
      const base = normalizeHost(config.host);
      const body = new URLSearchParams({
        hashes: hash,
        deleteFiles: deleteFiles ? "true" : "false",
      });
      const res = await fetch(`${base}/api/v2/torrents/delete`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { ok: false, message: `Delete failed (${res.status})` };
      }
      return { ok: true, message: "Removed from qBittorrent" };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async simplePost(
    config: ClientConnectionConfig,
    path: string,
    hash: string,
    okMsg: string,
  ): Promise<AddTorrentResult> {
    try {
      const cookie = await this.login(config);
      const base = normalizeHost(config.host);
      const body = new URLSearchParams({ hashes: hash });
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { ok: false, message: `${okMsg} failed (${res.status})` };
      }
      return { ok: true, message: okMsg };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async login(config: ClientConnectionConfig): Promise<string> {
    const base = normalizeHost(config.host);
    if (!base) {
      throw new Error("qBittorrent host URL is empty — set it in Settings");
    }

    const body = new URLSearchParams({
      username: config.username ?? "",
      password: config.password ?? "",
    });

    let res: Response;
    try {
      res = await fetch(`${base}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && err.cause instanceof Error
          ? err.cause.message
          : "";
      throw new Error(
        `qBittorrent unreachable at ${base}${cause ? ` (${cause})` : msg.includes("fetch") ? ` (${msg})` : `: ${msg}`}`,
      );
    }

    const text = await res.text();
    if (!res.ok || text.trim().toLowerCase() === "fails.") {
      throw new Error(
        `qBittorrent login failed at ${base} — check username/password (HTTP ${res.status})`,
      );
    }

    // Prefer SID cookie; some builds return multiple Set-Cookie headers joined
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) return "";
    const parts = setCookie.split(/,(?=\s*[^;]+=)/).flatMap((c) =>
      c.split(";").map((p) => p.trim()).filter(Boolean),
    );
    const sid = parts.find((p) => /^SID=/i.test(p));
    return sid || parts[0] || "";
  }
}

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "");
}

/**
 * Build the form body for POST /api/v2/torrents/add.
 *
 * Critical layout rule: when we set a smart savepath
 * (`…/Category/Show/Season NN`), qBittorrent must NOT create an extra
 * torrent-name directory under it. Default content layout nests as:
 *   Season 24/Family.Guy.S24E11.1080p/video.mkv  ← wrong
 * With contentLayout=NoSubfolder + autoTMM=false:
 *   Season 24/video.mkv  ← correct
 *
 * Exported for unit tests (mock-free body inspection).
 */
export function buildQbittorrentAddBody(
  config: ClientConnectionConfig,
  payload: AddTorrentPayload,
):
  | {
      ok: true;
      body: URLSearchParams;
      target: { category: string | null; savePath: string | null };
    }
  | { ok: false; message: string } {
  const body = new URLSearchParams();

  if (payload.magnet) {
    body.set("urls", payload.magnet);
  } else if (payload.torrentUrl) {
    body.set("urls", payload.torrentUrl);
  } else {
    return { ok: false, message: "No magnet or torrent URL provided" };
  }

  const target = resolveDownloadTarget(config, {
    category: payload.category,
    savePath: payload.savePath,
  });

  if (target.category) body.set("category", target.category);

  if (target.savePath) {
    body.set("savepath", target.savePath);
    // Disable Automatic Torrent Management so our smart path is not overridden
    body.set("autoTMM", "false");
    // Files land directly in savepath — no extra torrent-name subfolder
    body.set("contentLayout", "NoSubfolder");
  }

  return { ok: true, body, target };
}

export const qbittorrentClient = new QBittorrentClient();
