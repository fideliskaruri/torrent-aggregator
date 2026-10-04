import { pauseResumeTargets } from "./release-display";
import { DownloadLifecycleActions } from "./download-lifecycle-actions";
import type { ClientTorrent } from "./types";

export function SeriesDownloadBulkBar({
  torrents,
  onActionMany,
  onDeleteRequest,
}: {
  torrents: ClientTorrent[];
  onActionMany: (action: "pause" | "resume", torrents: ClientTorrent[]) => void;
  onDeleteRequest: (torrents: ClientTorrent[]) => void;
}) {
  if (!torrents.length) return null;
  const targets = pauseResumeTargets(torrents);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-card px-4 pb-[calc(0.5rem+var(--safe-bottom))] pt-2 shadow-[var(--shadow-md)] sm:px-5 sm:pb-2 sm:shadow-none"
      data-dialog-bulk-bar>
      <span className="mr-1 text-[12px] text-muted-foreground">{torrents.length} selected</span>
      <DownloadLifecycleActions mode="bulk"
        canPause={targets.pause.length > 0}
        canResume={targets.resume.length > 0}
        onPause={() => onActionMany("pause", targets.pause)}
        onResume={() => onActionMany("resume", targets.resume)}
        onDelete={() => onDeleteRequest(torrents)}
        pauseData={{ "data-dialog-bulk-pause": "" }}
        resumeData={{ "data-dialog-bulk-resume": "" }} />
    </div>
  );
}
