import { useDownloads } from "./use-downloads";
import { useDownloadsPageState } from "./use-downloads-page-state";
import { useDownloadsPageView } from "./use-downloads-page-view";
import { useDownloadsSelection } from "./use-downloads-selection";
import { useDownloadRowActions } from "./use-download-row-actions";
import { useDownloadManagementActions } from "./use-download-management-actions";

export function useDownloadsPage() {
  const ui = useDownloadsPageState();
  const data = useDownloads(Boolean(ui.pendingDelete));
  const view = useDownloadsPageView(ui, data);
  const selection = useDownloadsSelection(ui, data, view);
  const rowActions = useDownloadRowActions(ui, data, view, selection);
  const management = useDownloadManagementActions(ui, data);
  return { ...ui, ...data, ...view, ...selection, ...rowActions, ...management };
}
