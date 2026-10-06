import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { SeriesDownloadDialog } from "./series-download-dialog";
import { downloadTitleHref } from "./download-links";
import { transferLabel, transfersLabel } from "./release-display";
import type { useDownloadsPage } from "./use-downloads-page";

type Model = ReturnType<typeof useDownloadsPage>;

export function DownloadDialogs({ page }: { page: Model }) {
  return (
    <>
      {page.openGroup ? (
        <SeriesDownloadDialog group={page.openGroup} open
          onOpenChange={(next) => { if (!next) page.closeSeriesDialog(); }}
          titleHref={downloadTitleHref(page.openGroup.torrents[0])}
          selectedSeasonKey={page.selectedSeasonKey} onSelectSeason={page.setSelectedSeasonKey}
          selected={page.selected} onToggleSelect={page.toggleSelect}
          onToggleManySelect={page.toggleGroupSelect} highlightedTransferId={page.linkedTransferId}
          openingHash={page.openingHash}
          onAction={(act, torrent) => void page.action(act, torrent)}
          onActionMany={(act, rows) => void page.actionMany(act, rows)}
          onOpenFolder={(torrent) => void page.openDownloadFolder(torrent)}
          onOpenFile={(torrent, mode) => void page.openFinishedFile(torrent, mode)}
          onCopyPath={page.copyFolderPath} onCopyMagnet={(torrent) => void page.copyMagnet(torrent)}
          onDeleteRequest={page.openDeleteDialog}
          wantedGroups={page.wantedByWorkKey.get(page.openGroup.key) ?? []}
          wantedState={page.wanted} />
      ) : null}
      {page.findAnotherTorrent ? (
        <ConfirmDialog open onOpenChange={(open) => {
          if (!open && !page.findingAnother) page.setFindAnotherTorrent(null);
        }}
          title={page.findAnotherTorrent.packed && page.findAnotherTorrent.season != null
            ? `Find another release for ${page.findAnotherTorrent.workTitle ?? "this show"} Season ${String(page.findAnotherTorrent.season).padStart(2, "0")}?`
            : `Find another release for ${transferLabel(page.findAnotherTorrent)}?`}
          description={page.findAnotherTorrent.packed
            ? "This release is a season pack. Every episode downloading from it will search again, and their partial files will be removed."
            : "The current download and its partial files will be removed. TorrentFlow will search again."}
          variant="destructive" busy={page.findingAnother} confirmLabel="Find another"
          confirmData={{ "data-find-another-confirm": true }}
          onConfirm={() => void page.confirmFindAnother()} />
      ) : null}
      <ConfirmDialog open={!!page.pendingDelete}
        onOpenChange={(open) => { if (!open) page.setPendingDelete(null); }}
        contentData={{ "data-delete-dialog": true }} cancelData={{ "data-delete-cancel": true }}
        confirmData={{ "data-delete-with-files": true }}
        title={page.pendingDelete ? `Delete ${transfersLabel(page.pendingDelete)}?` : "Delete download?"}
        variant="destructive" busy={page.deleting} icon={<Trash2 className="h-3.5 w-3.5" />}
        confirmLabel="Delete with files" onConfirm={() => void page.confirmDelete(true)}
        secondaryAction={
          <Button type="button" variant="outline" disabled={page.deleting}
            onClick={() => void page.confirmDelete(false)}
            className="max-md:min-h-11 pointer-coarse:min-h-11" data-delete-keep-files>
            Remove, keep files
          </Button>
        }
        description={(
          <>
            <p>This removes {page.pendingDelete && page.pendingDelete.length > 1 ? "them" : "it"} from your downloads.</p>
            {page.pendingDelete?.[0] ? (
              <div className="space-y-1 rounded-lg border border-border bg-muted p-3">
                <p className="line-clamp-2 text-sm font-medium text-foreground">
                  {page.pendingDelete.length === 1 ? page.pendingDelete[0].name
                    : `${transferLabel(page.pendingDelete[0])} and ${page.pendingDelete.length - 1} more`}
                </p>
                {page.pendingDelete[0].savePath ? (
                  <p className="break-all text-[12px] font-mono text-subtle-foreground">
                    {page.displayPath(page.pendingDelete[0].savePath)}
                  </p>
                ) : null}
              </div>
            ) : null}
            <p className="text-[13px] text-muted-foreground">
              <strong className="font-medium text-destructive">Delete with files</strong> also removes the downloaded data from your disk. This cannot be undone.
            </p>
          </>
        )} />
    </>
  );
}
