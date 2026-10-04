import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { LoadingGlyph } from "@/components/ui/loading";
import { DownloadsErrorDetails } from "./download-page-states";
import type { useDownloadsPage } from "./use-downloads-page";

type Model = ReturnType<typeof useDownloadsPage>;

export function DownloadClientError({ page }: { page: Model }) {
  if (!page.error) return null;
  const isBuiltin = page.clientType === "builtin";
  if (page.torrents.length > 0) {
    return (
      <div className="surface flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-[12px]"
        role="status" data-client-stale>
        <span className="font-medium text-foreground">
          {page.offline && !isBuiltin ? "Torrent client unavailable" : "Could not refresh downloads"}
        </span>
        <span className="min-w-0 flex-1 text-muted-foreground">
          Showing the last known state. Your downloads are unchanged.
        </span>
        <DownloadsErrorDetails>{page.error}</DownloadsErrorDetails>
        <Button type="button" variant="secondary" size="sm" onClick={() => void page.load()} className="shrink-0">
          Retry now
        </Button>
      </div>
    );
  }
  return (
    <div className="surface p-5 space-y-3 text-sm" role="alert"
      data-client-offline={page.offline && !isBuiltin ? "true" : undefined}
      data-client-engine-error={isBuiltin || !page.offline ? "true" : undefined}>
      <div className="space-y-1">
        <p className="font-medium text-foreground">
          {isBuiltin ? "Downloads are temporarily unavailable" : page.offline ? "Torrent client unavailable" : "Downloads could not load"}
        </p>
        <p className="text-muted-foreground leading-relaxed">
          {isBuiltin ? "Retry now. If this keeps happening, check the download connection settings."
            : page.offline ? "Reconnect the client, or switch to the built-in downloader."
              : "Retry now, or check the download connection settings."}
        </p>
        <DownloadsErrorDetails>{page.error}</DownloadsErrorDetails>
      </div>
      <div className="flex flex-wrap gap-2">
        {!isBuiltin ? (
          <Button type="button" size="sm" onClick={() => void page.switchToBuiltin()}
            disabled={page.switchingBuiltin} data-switch-to-builtin>
            {page.switchingBuiltin ? <LoadingGlyph className="h-3.5 w-3.5" /> : null}
            Use built-in downloader
          </Button>
        ) : null}
        <Button asChild size="sm" variant={!isBuiltin ? "secondary" : "default"}>
          <Link to="/settings?tab=connection">Open connection settings</Link>
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => void page.load()}>Retry now</Button>
      </div>
      <p className="text-[12px] text-subtle-foreground">
        {isBuiltin ? "Check that the saved download folder is available, then retry."
          : "Switch to the built-in downloader, or reconnect your external client and retry."}
      </p>
    </div>
  );
}
