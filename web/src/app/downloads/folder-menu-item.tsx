import { Copy, FolderOpen } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { LoadingGlyph } from "@/components/ui/loading";
import { useFeatures } from "@/lib/features";
import type { OpenDownloadMode } from "@/lib/open-download";
import type { ClientTorrent } from "./types";

/**
 * The one folder action in a download's overflow menu, shared by the page row
 * and the series dialog's episode cards. A finished built-in download shows
 * its file in the file manager; any other row opens its folder; and when this
 * computer can't open anything (remote access, a container) the folder path
 * is copied instead.
 */
export function FolderMenuItem({
  torrent: t,
  busy,
  onOpenFolder,
  onOpenFile,
  onCopyPath,
}: {
  torrent: ClientTorrent;
  busy: boolean;
  onOpenFolder: (t: ClientTorrent) => void;
  onOpenFile: (t: ClientTorrent, mode: OpenDownloadMode) => void;
  onCopyPath: (t: ClientTorrent) => void;
}) {
  const { openFolder } = useFeatures();
  if (openFolder) {
    const reveal = t.actions.open;
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => (reveal ? onOpenFile(t, "reveal") : onOpenFolder(t))}
          disabled={busy}
          data-reveal-file={reveal || undefined}
          data-open-folder={reveal ? undefined : true}
        >
          {busy ? <LoadingGlyph className="h-4 w-4" /> : <FolderOpen />}
          {reveal ? "Show in folder" : "Open folder"}
        </DropdownMenuItem>
      </>
    );
  }
  if (!t.savePath) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => onCopyPath(t)} data-copy-path>
        <Copy />
        Copy folder path
      </DropdownMenuItem>
    </>
  );
}
