import { BulkBar } from "@/components/tf/bulk-bar";
import { DownloadLifecycleActions } from "./download-lifecycle-actions";
import type { useDownloadsPage } from "./use-downloads-page";

type Model = ReturnType<typeof useDownloadsPage>;

export function DownloadBulkActions({ page }: { page: Model }) {
  if (!page.selected.size) return null;
  return (
    <div data-bulk-bar>
      <BulkBar count={page.selected.size} onClear={() => page.setSelected(new Set())} actions={
        <DownloadLifecycleActions mode="bulk"
          canPause={page.selectedTargets.pause.length > 0}
          canResume={page.selectedTargets.resume.length > 0}
          onPause={() => void page.actionMany("pause", page.selectedTargets.pause)}
          onResume={() => void page.actionMany("resume", page.selectedTargets.resume)}
          onDelete={page.openBulkDelete}
          pauseData={{ "data-bulk-pause": "" }}
          resumeData={{ "data-bulk-resume": "" }}
          deleteData={{ "data-bulk-delete": "" }} />
      } />
    </div>
  );
}
