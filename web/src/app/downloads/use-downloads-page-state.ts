import { useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useDisplayPath } from "@/lib/features";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { parseStoredBoolean, storedOneOf, usePersistedState } from "@/hooks/use-persisted-state";
import {
  DEFAULT_DOWNLOAD_SORT,
  DOWNLOAD_SORTS,
  type DownloadSort,
} from "./sort";
import { DEFAULT_DOWNLOAD_TAB, type DownloadTab } from "./media-filter";
import { downloadLinkFrom } from "./download-link";
import type { ClientTorrent } from "./types";
import type { SendError } from "@/lib/api-json";

export type StatusFilter = "all" | "active" | "downloading" | "queued" | "ready" | "paused" | "attention";

export function useDownloadsPageState() {
  const displayPath = useDisplayPath();
  const { ensureDownloadSetup } = useDownloadSetup();
  const [pendingDelete, setPendingDelete] = useState<ClientTorrent[] | null>(null);
  const [openingHash, setOpeningHash] = useState<string | null>(null);
  const [findAnotherTorrent, setFindAnotherTorrent] = useState<ClientTorrent | null>(null);
  const [findingAnother, setFindingAnother] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [mediaTab, setMediaTab] = useState<DownloadTab>(DEFAULT_DOWNLOAD_TAB);
  const [sort, setSort] = usePersistedState<DownloadSort>(
    "tf-downloads-sort",
    DEFAULT_DOWNLOAD_SORT,
    storedOneOf(DOWNLOAD_SORTS),
  );
  const [openSeriesKey, setOpenSeriesKey] = useState<string | null>(null);
  const [selectedSeasonKey, setSelectedSeasonKey] = useState<string | null>(null);
  const [rawSendValue, setRawSendValue] = useState("");
  const [sendingRaw, setSendingRaw] = useState(false);
  const [rawSendError, setRawSendError] = useState<SendError | null>(null);
  const [addPanelOpen, setAddPanelOpen] = usePersistedState(
    "tf-downloads-add-open",
    false,
    parseStoredBoolean,
  );
  const rawSendInputRef = useRef<HTMLTextAreaElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const seriesDialogOpenerRef = useRef<HTMLElement | null>(null);
  const [openGroupTitle, setOpenGroupTitle] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const downloadLink = useMemo(() => downloadLinkFrom(searchParams), [searchParams]);
  const resolvedLinkRef = useRef<string | null>(null);
  const [linkedTransferId, setLinkedTransferId] = useState<string | null>(null);

  const toggleAddPanel = useCallback((open: boolean) => {
    setAddPanelOpen(open);
    if (open) requestAnimationFrame(() => rawSendInputRef.current?.focus());
  }, [setAddPanelOpen]);

  return {
    displayPath, ensureDownloadSetup, pendingDelete, setPendingDelete,
    openingHash, setOpeningHash,
    findAnotherTorrent, setFindAnotherTorrent, findingAnother, setFindingAnother,
    selected, setSelected, filter, setFilter,
    statusFilter, setStatusFilter, mediaTab, setMediaTab, sort, setSort,
    openSeriesKey, setOpenSeriesKey, selectedSeasonKey, setSelectedSeasonKey,
    rawSendValue, setRawSendValue, sendingRaw, setSendingRaw,
    rawSendError, setRawSendError, addPanelOpen, toggleAddPanel, rawSendInputRef,
    deleting, setDeleting, announcement, setAnnouncement,
    seriesDialogOpenerRef, openGroupTitle, setOpenGroupTitle,
    setSearchParams, downloadLink, resolvedLinkRef,
    linkedTransferId, setLinkedTransferId,
  };
}
