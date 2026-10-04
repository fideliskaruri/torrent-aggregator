import { send } from "@/lib/api";
import { toast } from "@/lib/toast";
import { copyDownloadPath,openDownload,type OpenDownloadMode } from "@/lib/open-download";
import type { ClientTorrent } from "./types";
import type { useDownloadsPageState } from "./use-downloads-page-state";

type Ui = ReturnType<typeof useDownloadsPageState>;
type DeleteMany = (action: "delete", transfers: ClientTorrent[], deleteFiles: boolean) => Promise<void>;

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

export function useDownloadManagementActions(ui: Ui, actionMany: DeleteMany) {
  async function confirmDelete(deleteFiles: boolean) {
    if (!ui.pendingDelete?.length || ui.deleting) return;
    ui.setDeleting(true);
    try {
      await actionMany("delete", ui.pendingDelete, deleteFiles);
    } finally {
      ui.setDeleting(false);
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
    const magnet = magnetFor(torrent);
    try {
      await navigator.clipboard.writeText(magnet);
      toast.success("Magnet link copied");
    } catch {
      toast.error("Could not copy magnet link", { description: magnet });
    }
  }

  return { confirmDelete, openDownloadFolder, openFinishedFile, copyFolderPath, copyMagnet };
}
