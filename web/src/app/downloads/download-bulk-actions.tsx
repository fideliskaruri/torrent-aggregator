import { Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BulkBar } from "@/components/tf/bulk-bar";
import type { useDownloadsPage } from "./use-downloads-page";

type Model = ReturnType<typeof useDownloadsPage>;

export function DownloadBulkActions({ page }: { page: Model }) {
  if (!page.selected.size) return null;
  return (
    <div data-bulk-bar>
      <BulkBar count={page.selected.size} onClear={() => page.setSelected(new Set())} actions={
        <>
          <Button size="sm" variant="secondary" aria-disabled={!page.selectedTargets.pause.length || undefined}
            onClick={() => page.selectedTargets.pause.length && void page.bulkAction("pause")} data-bulk-pause>
            <Pause className="h-3.5 w-3.5" />Pause
          </Button>
          <Button size="sm" variant="secondary" aria-disabled={!page.selectedTargets.resume.length || undefined}
            onClick={() => page.selectedTargets.resume.length && void page.bulkAction("resume")} data-bulk-resume>
            <Play className="h-3.5 w-3.5" />Resume
          </Button>
          <Button size="sm" variant="destructive" onClick={page.openBulkDelete} data-bulk-delete>
            <Trash2 className="h-3.5 w-3.5" />Delete
          </Button>
        </>
      } />
    </div>
  );
}
