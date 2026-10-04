import type { ReactNode } from "react";
import { Magnet, MoreHorizontal, Search, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { OpenDownloadMode } from "@/lib/open-download";
import {
  pauseResumeAction,
  pauseResumeTargets,
} from "./release-display";
import { FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import { DownloadLifecycleActions } from "./download-lifecycle-actions";
import { FolderMenuItem } from "./folder-menu-item";
import type { ClientTorrent, TorrentRowAction } from "./types";

/** The "..." button every download row and header uses, and its menu. */
export function IconMenuButton({
  label,
  triggerProps,
  children,
  after,
}: {
  label: string;
  /** Extra attributes for the trigger, such as `data-*` hooks. */
  triggerProps?: Record<string, string | undefined>;
  children: ReactNode;
  after?: ReactNode;
}) {
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={label} {...triggerProps}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{children}</DropdownMenuContent>
      </DropdownMenu>
      {after}
    </>
  );
}

/** `data-torrent-*` on the page's film rows, `data-episode-*` in the series dialog. */
export type TransferRowKind = "torrent" | "episode";

export function rowAttr(kind: TransferRowKind, name: string, value = ""): Record<string, string> {
  return { [`data-${kind}-${name}`]: value };
}

export interface TorrentRowMenuHandlers {
  onAction: (act: TorrentRowAction, torrent: ClientTorrent) => void;
  onOpenFolder: (torrent: ClientTorrent) => void;
  onOpenFile: (torrent: ClientTorrent, mode: OpenDownloadMode) => void;
  onCopyPath: (torrent: ClientTorrent) => void;
  onCopyMagnet: (torrent: ClientTorrent) => void;
  onDeleteRequest: (torrents: ClientTorrent[]) => void;
}

/**
 * One download's menu, the same on the page and in the series dialog: the
 * torrent mechanics (source tag, client, category, peers, release name and
 * folder) under Details, then copy and folder, then the lifecycle actions,
 * then Delete.
 */
export function torrentRowMenuItems({
  torrent: t,
  kind,
  busy,
  displayPath,
  handlers,
}: {
  torrent: ClientTorrent;
  kind: TransferRowKind;
  busy: boolean;
  displayPath: (path: string) => string;
  handlers: TorrentRowMenuHandlers;
}): ReactNode {
  const pauseResume = pauseResumeAction(t);
  const facts = [
    t.category,
    t.peers != null ? `${t.peers} ${t.peers === 1 ? "peer" : "peers"}` : null,
  ].filter(Boolean);
  const hasLifecycleItems = t.actions.downloadNow || t.actions.findAnother || pauseResume !== null;
  return (
    <>
      <div
        className="px-2 py-1.5 text-[12px] leading-relaxed text-subtle-foreground"
        data-torrent-details
      >
        <p className="font-medium text-muted-foreground">Details</p>
        {facts.length ? <p className="tabular-nums">{facts.join(" · ")}</p> : null}
        <p className="break-all font-mono">{t.name}</p>
        {t.savePath ? <p className="break-all font-mono">{displayPath(t.savePath)}</p> : null}
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => handlers.onCopyMagnet(t)}
        data-copy-magnet
      >
        <Magnet />
        Copy magnet link
      </DropdownMenuItem>
      <FolderMenuItem
        torrent={t}
        busy={busy}
        onOpenFolder={handlers.onOpenFolder}
        onOpenFile={handlers.onOpenFile}
        onCopyPath={handlers.onCopyPath}
      />
      <DropdownMenuSeparator />
      {t.actions.downloadNow ? (
        <DropdownMenuItem onClick={() => handlers.onAction("force", t)} {...rowAttr(kind, "force")}>
          <Zap />
          Download now
        </DropdownMenuItem>
      ) : null}
      {t.actions.findAnother ? (
        <DropdownMenuItem onClick={() => handlers.onAction("find-another-release", t)} data-find-release>
          <Search />
          {FIND_ANOTHER_SOURCE_LABEL}
        </DropdownMenuItem>
      ) : null}
      {hasLifecycleItems ? <DropdownMenuSeparator /> : null}
      <DownloadLifecycleActions mode="menu"
        onPause={pauseResume === "pause" ? () => handlers.onAction("pause", t) : undefined}
        onResume={pauseResume === "resume" ? () => handlers.onAction("resume", t) : undefined}
        onDelete={() => handlers.onDeleteRequest([t])}
        showPause={pauseResume === "pause"}
        showResume={pauseResume === "resume"}
        deleteLabel="Delete…"
        deleteData={{ ...rowAttr(kind, "delete"), ...(kind === "torrent" ? { "data-delete-torrent": "" } : {}) }} />
    </>
  );
}

/** A series' menu, the same on its page row and in its dialog header. */
export function groupMenuItems({
  torrents,
  onActionMany,
  onDeleteRequest,
}: {
  torrents: readonly ClientTorrent[];
  onActionMany: (act: "pause" | "resume", torrents: ClientTorrent[]) => void;
  onDeleteRequest: (torrents: ClientTorrent[]) => void;
}): ReactNode {
  const targets = pauseResumeTargets(torrents);
  return (
    <>
      <DownloadLifecycleActions mode="menu"
        onPause={() => onActionMany("pause", targets.pause)}
        onResume={() => onActionMany("resume", targets.resume)}
        onDelete={() => onDeleteRequest([...torrents])}
        showPause={targets.pause.length > 0}
        showResume={targets.resume.length > 0}
        pauseLabel="Pause all"
        resumeLabel="Resume all"
        deleteLabel="Delete all…"
        deleteData={{ "data-group-delete": "" }} />
    </>
  );
}
