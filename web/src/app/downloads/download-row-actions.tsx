import { Download, Search, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TfOpenFileButton } from "@/components/tf/open-file-button";
import { FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import { canDownloadNow, canFindAnotherSourceFor } from "./release-display";
import { rowAttr, type TransferRowKind } from "./row-menu";
import type { OpenDownloadMode } from "@/lib/open-download";
import type { ClientTorrent, TorrentRowAction } from "./types";

export function DownloadRowActions({
  torrent,
  title,
  kind,
  busy,
  canOpen,
  onAction,
  onOpenFile,
}: {
  torrent: ClientTorrent;
  title: string;
  kind: TransferRowKind;
  busy: boolean;
  canOpen: boolean;
  onAction: (action: TorrentRowAction, torrent: ClientTorrent) => void;
  onOpenFile: (torrent: ClientTorrent, mode: OpenDownloadMode) => void;
}) {
  return (
    <>
      {canDownloadNow(torrent) ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => onAction("force", torrent)}
          aria-label={`Download ${title} now`} {...rowAttr(kind, "force-now")}>
          <Zap className="h-3.5 w-3.5" />Download now
        </Button>
      ) : null}
      {torrent.actions.resume && torrent.status === "error" ? (
        <Button type="button" variant="default" size="sm" onClick={() => onAction("resume", torrent)}
          aria-label={`Retry ${title}`} {...rowAttr(kind, "retry")} {...rowAttr(kind, "resume")}>
          <Download className="h-3.5 w-3.5" />Retry
        </Button>
      ) : torrent.actions.resume && torrent.status === "paused" ? (
        <Button type="button" variant="default" size="sm" onClick={() => onAction("resume", torrent)}
          aria-label={`Resume ${title}`} {...rowAttr(kind, "resume")}>
          <Download className="h-3.5 w-3.5" />Resume
        </Button>
      ) : null}
      {canFindAnotherSourceFor(torrent) ? (
        <Button type="button" variant="secondary" size="sm"
          onClick={() => onAction("find-another-release", torrent)}
          aria-label={`${FIND_ANOTHER_SOURCE_LABEL} for ${title}`} {...rowAttr(kind, "find-release")}>
          <Search className="h-3.5 w-3.5" />{FIND_ANOTHER_SOURCE_LABEL}
        </Button>
      ) : null}
      {canOpen ? <TfOpenFileButton name={title} busy={busy} onClick={() => onOpenFile(torrent, "open")} /> : null}
    </>
  );
}
