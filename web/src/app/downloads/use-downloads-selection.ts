import { useCallback, useEffect } from "react";
import { toggleVisibleSelection } from "./snapshot-sync";
import type { useDownloads } from "./use-downloads";
import type { useDownloadsPageState } from "./use-downloads-page-state";
import type { useDownloadsPageView } from "./use-downloads-page-view";

type Ui = ReturnType<typeof useDownloadsPageState>;
type Data = ReturnType<typeof useDownloads>;
type View = ReturnType<typeof useDownloadsPageView>;

export function useDownloadsSelection(ui: Ui, data: Data, view: View) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") ui.setSelected(new Set());
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        ui.selected.size > 0 &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        const targets = data.torrents.filter((row) => ui.selected.has(row.transferId));
        if (targets.length) ui.setPendingDelete(targets);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        ui.setSelected((previous) => {
          const next = new Set(previous);
          for (const row of view.filtered) next.add(row.transferId);
          return next;
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui.selected, ui.setSelected, ui.setPendingDelete, data.torrents, view.filtered]);

  const toggleSelect = useCallback((transferId: string, additive: boolean) => {
    ui.setSelected((previous) => {
      const next = new Set(additive ? previous : []);
      if (previous.has(transferId) && additive) next.delete(transferId);
      else next.add(transferId);
      return next;
    });
  }, [ui.setSelected]);

  const toggleGroupSelect = useCallback((transferIds: string[]) => {
    ui.setSelected((previous) => {
      const next = new Set(previous);
      const all = transferIds.every((id) => next.has(id));
      for (const id of transferIds) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [ui.setSelected]);

  const openDeleteDialog = useCallback((rows: typeof data.torrents) => {
    ui.setPendingDelete(rows);
  }, [ui.setPendingDelete]);

  const toggleSelectAll = useCallback(() => {
    ui.setSelected((previous) => toggleVisibleSelection(
      view.filtered.map((row) => row.transferId),
      previous,
    ));
  }, [ui.setSelected, view.filtered]);

  const openSeriesDialog = useCallback((key: string, opener?: EventTarget | null) => {
    if (opener instanceof HTMLElement) ui.seriesDialogOpenerRef.current = opener;
    ui.setOpenSeriesKey(key);
  }, [ui.seriesDialogOpenerRef, ui.setOpenSeriesKey]);

  const closeSeriesDialog = useCallback(() => {
    const key = ui.openSeriesKey;
    ui.setOpenSeriesKey(null);
    ui.setSelectedSeasonKey(null);
    const opener = ui.seriesDialogOpenerRef.current?.isConnected
      ? ui.seriesDialogOpenerRef.current
      : key
        ? document.querySelector<HTMLElement>(`[data-group-key="${CSS.escape(key)}"] [data-group-details]`)
        : null;
    if (opener) requestAnimationFrame(() => opener.focus());
  }, [ui.openSeriesKey, ui.setOpenSeriesKey, ui.setSelectedSeasonKey, ui.seriesDialogOpenerRef]);

  return {
    toggleSelect, toggleGroupSelect, openDeleteDialog, toggleSelectAll,
    openSeriesDialog, closeSeriesDialog,
  };
}
