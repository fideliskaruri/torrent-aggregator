import { Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pauseResumeTargets } from "./release-display";
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
      <Button size="sm" variant="secondary" aria-disabled={!targets.pause.length || undefined}
        onClick={() => targets.pause.length && onActionMany("pause", targets.pause)} data-dialog-bulk-pause>
        <Pause className="h-3.5 w-3.5" />Pause
      </Button>
      <Button size="sm" variant="secondary" aria-disabled={!targets.resume.length || undefined}
        onClick={() => targets.resume.length && onActionMany("resume", targets.resume)} data-dialog-bulk-resume>
        <Play className="h-3.5 w-3.5" />Resume
      </Button>
      <Button size="sm" variant="destructive" onClick={() => onDeleteRequest(torrents)}>
        <Trash2 className="h-3.5 w-3.5" />Delete
      </Button>
    </div>
  );
}
