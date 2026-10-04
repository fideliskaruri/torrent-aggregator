import { send } from "@/lib/api";
import { toast } from "@/lib/toast";
import { copyDownloadPath,openDownload,type OpenDownloadMode } from "@/lib/open-download";
import { transfersLabel } from "./release-display";
import type { ClientTorrent } from "./types";
import type { useDownloads } from "./use-downloads";
import type { useDownloadsPageState } from "./use-downloads-page-state";

type Ui = ReturnType<typeof useDownloadsPageState>;
type Data = ReturnType<typeof useDownloads>;
type TidyResult = { checked: number; tidied: number; filesMoved: number; stillNested: number; skipped: number };

const SHARE_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
];

function magnetFor(torrent: ClientTorrent): string {
  if (torrent.magnet?.trim()) return torrent.magnet.trim();
  const params = [
    `xt=urn:btih:${torrent.hash.trim().toLowerCase()}`,
    `dn=${encodeURIComponent(torrent.name)}`,
    ...SHARE_TRACKERS.map((tracker) => `tr=${encodeURIComponent(tracker)}`),
  ];
  return `magnet:?${params.join("&")}`;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function useDownloadManagementActions(ui: Ui, data: Data) {
  async function confirmDelete(deleteFiles: boolean) {
    if (!ui.pendingDelete?.length) return;
    const what = transfersLabel(ui.pendingDelete);
    const their = ui.pendingDelete.length === 1 ? "its" : "their";
    ui.setDeleting(true);
    data.invalidateInFlight();
    try {
      type DeleteResult = { ok: boolean; name: string; msg?: string };
      const post = async (payload: Record<string, unknown>) => {
        const response = await send("/api/client/torrents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete", deleteFiles, ...payload }),
        });
        const text = await response.text();
        try {
          return {
            response,
            body: text ? JSON.parse(text) as {
              ok?: boolean;
              message?: string;
              error?: string;
              results?: { hash: string; ok: boolean; message?: string }[];
            } : {},
          };
        } catch {
          return { response, body: null };
        }
      };
      const builtin = ui.pendingDelete.filter((torrent) => torrent.ownerClientType === "builtin");
      const external = ui.pendingDelete.filter((torrent) => torrent.ownerClientType !== "builtin");
      const results: DeleteResult[] = [];
      if (builtin.length) {
        const { response, body } = await post({
          hashes: builtin.map((torrent) => torrent.hash),
          ownerClientType: "builtin",
        });
        for (const torrent of builtin) {
          const row = body?.results?.find((result) => result.hash.toLowerCase() === torrent.hash.toLowerCase());
          results.push(row
            ? { ok: row.ok, name: torrent.name, msg: row.message }
            : {
                ok: false,
                name: torrent.name,
                msg: body?.message || body?.error || `TorrentFlow answered HTTP ${response.status}. Try again.`,
              });
        }
      }
      for (const torrent of external) {
        const { response, body } = await post({ hash: torrent.hash, ownerClientType: torrent.ownerClientType });
        results.push(body
          ? { ok: response.ok && body.ok !== false, name: torrent.name, msg: body.message || body.error }
          : { ok: false, name: torrent.name, msg: `TorrentFlow answered HTTP ${response.status}. Try again.` });
      }
      const failed = results.filter((result) => !result.ok);
      const removed = results.length - failed.length;
      if (!failed.length) {
        const summary = deleteFiles ? `Removed ${what} and ${their} files` : `Removed ${what} but kept ${their} files`;
        toast.success(summary);
        ui.setAnnouncement(`${summary}.`);
      } else {
        const reason = failed[0].msg?.trim() || "TorrentFlow couldn't remove it. Try again.";
        const summary = removed ? `Removed ${removed} of ${results.length} downloads` : `Couldn't remove ${what}`;
        if (removed) toast.warning(summary, {
          description: `${plural(failed.length, "download")} couldn't be removed: ${reason}`,
        });
        else toast.error(summary, { description: reason });
        ui.setAnnouncement(`${summary}.`);
      }
      ui.setSelected(new Set());
      ui.setPendingDelete(null);
      void data.load();
    } catch {
      toast.error(`Couldn't remove ${what}`, { description: "Couldn't reach TorrentFlow. Try again." });
      ui.setAnnouncement(`Couldn't remove ${what}.`);
    } finally {
      ui.setDeleting(false);
    }
  }

  async function tidyFolders() {
    ui.setTidying(true);
    try {
      const response = await send("/api/client/torrents/tidy", { method: "POST" });
      const body = await response.json().catch(() => null) as TidyResult | null;
      if (!response.ok || !body) {
        toast.error("Could not tidy folders. Try again.");
        return;
      }
      const notes = [
        body.stillNested > 0
          ? `${plural(body.stillNested, "video")} kept in a release folder because another download already has that name`
          : "",
        body.skipped > 0 ? `${plural(body.skipped, "download")} in use, try again later` : "",
      ].filter(Boolean);
      const description = notes.length ? { description: notes.join(". ") } : undefined;
      if (body.filesMoved === 0) toast.success("Folders are already tidy", description);
      else toast.success(`Moved ${plural(body.filesMoved, "file")} from ${plural(body.tidied, "download")}`, description);
      void data.load();
    } catch {
      toast.error("Network error tidying folders");
    } finally {
      ui.setTidying(false);
    }
  }

  async function openDownloadFolder(torrent: ClientTorrent) {
    ui.setOpeningHash(torrent.transferId);
    try {
      const response = await send("/api/settings/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: torrent.savePath?.trim() || null, category: torrent.category || null }),
      });
      const text = await response.text();
      let body: { ok?: boolean; message?: string; error?: string; path?: string; pathOnly?: string } = {};
      try {
        body = text ? JSON.parse(text) as typeof body : {};
      } catch {
        toast.error("Empty response opening folder");
        return;
      }
      if (body.ok) {
        toast.success(body.message || "Opened folder");
        return;
      }
      const path = body.path || body.pathOnly || torrent.savePath || "";
      if (path) {
        try {
          await navigator.clipboard.writeText(path);
          toast.message(body.message || "Could not open", { description: "Path copied to clipboard" });
          return;
        } catch {
          // Use the visible error if clipboard access is unavailable.
        }
      }
      toast.error(body.message || body.error || "Could not open folder");
    } catch {
      toast.error("Network error opening folder");
    } finally {
      ui.setOpeningHash(null);
    }
  }

  async function openFinishedFile(torrent: ClientTorrent, mode: OpenDownloadMode) {
    ui.setOpeningHash(torrent.transferId);
    try {
      await openDownload(torrent.transferId, mode, torrent.savePath ? ui.displayPath(torrent.savePath) : null);
    } finally {
      ui.setOpeningHash(null);
    }
  }

  function copyFolderPath(torrent: ClientTorrent) {
    if (torrent.savePath) void copyDownloadPath(ui.displayPath(torrent.savePath));
  }

  async function copyMagnet(torrent: ClientTorrent) {
    if (torrent.imported) {
      toast.info("Imported local files have no torrent metadata or magnet link.");
      return;
    }
    const magnet = magnetFor(torrent);
    try {
      await navigator.clipboard.writeText(magnet);
      toast.success("Magnet link copied");
    } catch {
      toast.error("Could not copy magnet link", { description: magnet });
    }
  }

  return { confirmDelete, tidyFolders, openDownloadFolder, openFinishedFile, copyFolderPath, copyMagnet };
}
