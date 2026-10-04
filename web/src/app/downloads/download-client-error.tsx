import { TfErrorState } from "@/components/tf/error-state";
import type { useDownloadsPage } from "./use-downloads-page";

type Model = ReturnType<typeof useDownloadsPage>;

export function DownloadClientError({ page }: { page: Model }) {
  if (!page.error) return null;
  return (
    <TfErrorState title="Couldn't load downloads" onRetry={() => void page.load()} retrying={page.loading} />
  );
}
