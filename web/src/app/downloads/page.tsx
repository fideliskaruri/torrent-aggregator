import { ClientSkeleton } from "./download-page-states";
import { DownloadAddPanel } from "./download-add-panel";
import { DownloadBulkActions } from "./download-bulk-actions";
import { DownloadClientError } from "./download-client-error";
import { DownloadDialogs } from "./download-dialogs";
import { DownloadFilters } from "./download-filters";
import { DownloadPageHeader } from "./download-page-header";
import { DownloadTransferList } from "./download-transfer-list";
import { useDownloadsPage } from "./use-downloads-page";

export default function DownloadsPage() {
  const page = useDownloadsPage();
  if (page.loading && !page.torrents.length && !page.error) {
    return <ClientSkeleton visible={page.showLoading} />;
  }
  return (
    <div className="container-app max-w-5xl min-w-0 space-y-4 py-6 sm:py-8">
      <p className="sr-only" role="status" aria-live="polite">{page.announcement}</p>
      <DownloadPageHeader page={page} />
      {page.error ? <DownloadClientError page={page} /> : (
        <>
          <DownloadAddPanel page={page} />
        <DownloadFilters page={page}>
          <DownloadBulkActions page={page} />
          <DownloadTransferList page={page} />
        </DownloadFilters>
        </>
      )}
      {!page.error ? <DownloadDialogs page={page} /> : null}
    </div>
  );
}
