import { HardDriveDownload } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { DownloadRecovery } from "@/components/settings/download-recovery";
import { TfEmptyState } from "@/components/tf/empty-state";
import { DownloadGroupRow } from "./download-group-row";
import { DownloadFilmRow } from "./download-film-row";
import { WantedOnlyRow } from "./wanted-only-row";
import { wantedTitleKeyForDownload } from "./wanted-groups";
import type { useDownloadsPage } from "./use-downloads-page";

type Model = ReturnType<typeof useDownloadsPage>;

export function DownloadTransferList({ page }: { page: Model }) {
  const isBuiltin = page.clientType === "builtin";
  const hasRows = page.sortedGroups.length > 0 || page.wantedOnly.length > 0;
  const hasNoDownloadsOrWanted = page.downloadable.length === 0 && page.wantedGroups.length === 0;
  return (
    <>
      {hasNoDownloadsOrWanted && !page.loading ? (
        <div className="space-y-4">
          <TfEmptyState icon={HardDriveDownload} title="No downloads yet"
            description={isBuiltin
              ? "Find a title and choose Download to see it here."
              : "Find a title and choose Download to send it to your connected client."}
            actionLabel="Open search" actionHref="/" />
          {isBuiltin && <DownloadRecovery mode="empty" onImported={() => void page.load()} />}
        </div>
      ) : (
        <>
          {isBuiltin && page.torrents.length > 0 && page.torrents.every(
            (torrent) => torrent.progress < 0.01 && (torrent.status === "waiting" || torrent.status === "queued"),
          ) ? (
            <p className="mb-2 px-1 text-[12px] text-subtle-foreground">
              These downloads have not started yet. Give them a minute to find available copies; if they stay at 0%, try another version with more sources.
            </p>
          ) : null}
          <div className="surface overflow-hidden" data-client-table>
            <div className="hidden items-center gap-3 border-b border-border px-3 py-2 text-[12px] font-medium uppercase tracking-wide text-subtle-foreground sm:grid sm:grid-cols-[auto_minmax(0,1fr)_auto]">
              {page.filtered.length > 0 ? (
                <Checkbox checked={page.allVisibleSelected} onCheckedChange={page.toggleSelectAll}
                  aria-label="Select all" data-select-all />
              ) : <span aria-hidden className="size-4" />}
              <span>Name</span>
              <span className="pr-1 text-right">Actions</span>
            </div>
            <div className="divide-y divide-border">
              {page.sortedGroups.map((group) => group.kind === "series" ? (
                <DownloadGroupRow key={group.key} group={group} selected={page.selected}
                  onToggleGroupSelect={page.toggleGroupSelect} onOpenDetails={page.openSeriesDialog}
                  onActionMany={(act, rows) => void page.actionMany(act, rows)}
                  onDeleteRequest={page.openDeleteDialog}
                  wantedGroups={page.wantedByWorkKey.get(group.key) ?? []} wantedState={page.wanted} />
              ) : (
                <DownloadFilmRow key={group.torrent.transferId} torrent={group.torrent}
                  isSelected={page.selected.has(group.torrent.transferId)}
                  highlighted={group.torrent.transferId === page.linkedTransferId}
                  openingHash={page.openingHash} onToggleSelect={page.toggleSelect}
                  onAction={(act, torrent) => void page.action(act, torrent)}
                  onOpenFolder={(torrent) => void page.openDownloadFolder(torrent)}
                  onOpenFile={(torrent, mode) => void page.openFinishedFile(torrent, mode)}
                  onCopyPath={page.copyFolderPath} onCopyMagnet={(torrent) => void page.copyMagnet(torrent)}
                  onDeleteRequest={page.openDeleteDialog}
                  wantedGroups={page.wantedByWorkKey.get(wantedTitleKeyForDownload(
                    group.torrent.groupKey,
                    group.torrent.workKey,
                  )) ?? []}
                  wantedState={page.wanted} />
              ))}
              {page.wantedOnly.map((title) => (
                <WantedOnlyRow key={title.workKey} title={title} wanted={page.wanted} />
              ))}
            </div>
            {!hasRows && (page.downloadable.length > 0 || page.wantedGroups.length > 0) ? (
              <p className="px-4 py-8 text-center text-[13px] text-subtle-foreground">No torrents match this filter.</p>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}
