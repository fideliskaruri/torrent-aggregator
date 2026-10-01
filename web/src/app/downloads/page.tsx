import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDisplayPath } from "@/lib/features";
import { DownloadRecovery } from "@/components/settings/download-recovery";
import { MaxActiveDownloadsControl } from "@/components/settings/max-active-downloads";
import { Link, useSearchParams } from "react-router";
import { toast } from "@/lib/toast";
import { copyDownloadPath, openDownload, type OpenDownloadMode } from "@/lib/open-download";
import {
  ArrowDownUp,
  ChevronRight,  FolderTree,
  HardDriveDownload,
  Magnet,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { readJsonBody, sendErrorFromBody, type SendError } from "@/lib/api-json";
import { Button } from "@/components/ui/button";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";
import {
  titleHrefForName,
  titlePath,
} from "@/components/title/work-key";
import { useReleaseArtwork } from "@/hooks/use-release-artwork";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import { speedLabel } from "@/components/tf/active-row-state";
import { useVisiblePoll } from "@/hooks/use-visible-poll";
import { LookingSection } from "./looking-section";
import { useMaxActiveDownloads } from "./use-max-active";
import {
  groupDownloads,  statusCounts,
  isDownloading,
  isError,
  isPaused,
  isQueued,
  isDownloaded,
  type SeriesGroup,
} from "./grouping";
import { needsAttentionLabel } from "./status-rollup";
import {
  DEFAULT_DOWNLOAD_TAB,
  DOWNLOAD_TABS,
  DOWNLOAD_TAB_LABELS,
  filterDownloadsByTab,
  type DownloadTab,
} from "./media-filter";
import {
  releaseDisplayFacts,  pauseResumeTargets,
  rollupChip,  transferLabel,
  transfersLabel,} from "./release-display";
import {
  isValidTorrentSourceInput,
  parseTorrentSourceInput,
  TORRENT_SOURCE_INPUT_HINT,
} from "@/lib/torrents/magnet-input";
import { resolveSelectedSeasonKey, seriesGroupByKey } from "./season-selection";
import {
  applySnapshot,
  areAllVisibleSelected,
  emptySnapshotState,
  shouldApplySnapshot,
  shouldCloseMissingGroup,
  toggleVisibleSelection,
  type SnapshotState,
} from "./snapshot-sync";
import { SeriesDownloadDialog } from "./series-download-dialog";
import {
  DownloadGroupSummary,
  DownloadTransferRow,
  type DownloadTransferRowProps,
} from "./download-transfer-row";
import { IconMenuButton, groupMenuItems } from "./row-menu";
import {
  downloadLinkFrom,
  downloadLinkKey,
  findLinkedDownload,
  withoutDownloadLink,
} from "./download-link";
import { ReleaseSwapDialog } from "./release-swap-dialog";
import { isDownloadRow, type ClientTorrent, type TorrentRowAction } from "./types";
import {
  LoadingGlyph,
  PageSkeletonFrame,
  SkeletonBlock,
} from "@/components/ui/loading";
import { useStableLoading } from "@/components/ui/use-stable-loading";
import { parseStoredBoolean, storedOneOf, usePersistedState } from "@/hooks/use-persisted-state";
import {
  DEFAULT_DOWNLOAD_SORT,
  DOWNLOAD_SORT_LABELS,
  DOWNLOAD_SORTS,
  downloadSortShortLabel,
  sortDownloadGroups,
  type DownloadSort,
} from "./sort";
import {
  mergeOwnedTransferSnapshots,
} from "@/lib/clients/transfer-ownership";
import type { TorrentClientType } from "@/lib/clients";

type StatusFilter = "all" | "active" | "downloading" | "queued" | "ready" | "paused" | "attention";

const SHARE_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
];

/** A magnet any torrent client can open: the server-built one when present, else hash + name + a few public trackers. */
function magnetFor(torrent: ClientTorrent): string {
  if (torrent.magnet?.trim()) return torrent.magnet.trim();
  const params = [
    `xt=urn:btih:${torrent.hash.trim().toLowerCase()}`,
    `dn=${encodeURIComponent(torrent.name)}`,
    ...SHARE_TRACKERS.map((tr) => `tr=${encodeURIComponent(tr)}`),
  ];
  return `magnet:?${params.join("&")}`;
}

function downloadTitleHref(torrent: ClientTorrent): string | null {
  const workKey = torrent.workKey?.trim();
  const workTitle = torrent.workTitle?.trim();
  if (workKey && workTitle) {
    return titlePath(workKey, {
      title: workTitle,
      year: torrent.workYear ?? null,
      mediaType: torrent.workMediaType ?? torrent.category ?? null,
      season: torrent.season ?? null,
    });
  }
  return titleHrefForName(torrent.name, {
    mediaType: torrent.category,
    season: torrent.season ?? null,
  });
}

/** Result of POST /api/client/torrents/tidy (LayoutTidyResult). */
type TidyResult = {
  checked: number;
  tidied: number;
  filesMoved: number;
  stillNested: number;
  skipped: number;
};

/** The external client's product name, for the status line. */
function clientLabel(type: string): string {
  if (type === "transmission") return "Transmission";
  if (type === "qbittorrent") return "qBittorrent";
  return "your torrent client";
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

type RowActionOutcome = { ok: true } | { ok: false; reason: string };

/**
 * One pause/resume/start, read to the end. A refusal comes back as an error
 * status: the built-in engine says why in `detail` ("Downloaded files cannot be
 * paused."), an external client only in a generic `message`, and a dropped
 * connection not at all, so the reason falls back in that order.
 */
async function postRowAction(
  act: "pause" | "resume" | "force",
  torrent: ClientTorrent,
): Promise<RowActionOutcome> {
  const res = await fetch("/api/client/torrents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: act,
      hash: torrent.hash,
      ownerClientType: torrent.ownerClientType,
    }),
  }).catch(() => null);
  if (!res) return { ok: false, reason: "Couldn't reach TorrentFlow. Try again." };
  const data = await readJsonBody<{ ok?: boolean; message?: string; detail?: string; error?: string }>(res);
  if (res.ok && data?.ok !== false) return { ok: true };
  return {
    ok: false,
    reason:
      data?.detail?.trim() ||
      data?.message?.trim() ||
      data?.error?.trim() ||
      `TorrentFlow answered HTTP ${res.status}. Try again.`,
  };
}
export default function ClientPage() {
  const displayPath = useDisplayPath();
  // Rows, error, offline and "was that read authoritative" move together: a
  // failed poll must never be able to leave the rows blanked but the error
  // stale, or vice versa. `snapshot-sync.ts` owns the folding rules.
  const [snapshot, setSnapshot] = useState<SnapshotState<ClientTorrent>>(() =>
    emptySnapshotState<ClientTorrent>(),
  );
  const { torrents, error, offline, authoritative } = snapshot;
  const [clientType, setClientType] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [openingHash, setOpeningHash] = useState<string | null>(null);
  const [tidying, setTidying] = useState(false);
  const [swapTorrent, setSwapTorrent] = useState<ClientTorrent | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [mediaTab, setMediaTab] = useState<DownloadTab>(DEFAULT_DOWNLOAD_TAB);
  const [sort, setSort] = usePersistedState<DownloadSort>(
    "tf-downloads-sort",
    DEFAULT_DOWNLOAD_SORT,
    storedOneOf(DOWNLOAD_SORTS),
  );
  // Which series' dialog is open, by the group's own identity key — and which
  // of its seasons is showing. Both live here, not inside the dialog
  // component, so a notification link can open the dialog on its season and a
  // snapshot that drops the series can close it.
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
  const toggleAddPanel = useCallback(
    (open: boolean) => {
      setAddPanelOpen(open);
      // Opening it is asking to paste something, so the box takes focus.
      if (open) requestAnimationFrame(() => rawSendInputRef.current?.focus());
    },
    [setAddPanelOpen],
  );
  const { ensureDownloadSetup } = useDownloadSetup();
  const [pendingDelete, setPendingDelete] = useState<ClientTorrent[] | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [clientHost, setClientHost] = useState("");
  const [switchingBuiltin, setSwitchingBuiltin] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // The row that opened the series dialog, so closing it hands focus back.
  const seriesDialogOpenerRef = useRef<HTMLElement | null>(null);
  const [openGroupTitle, setOpenGroupTitle] = useState("");
  // A notification's "View details" names one download (see `download-link.ts`);
  // this is the row it pointed at, ringed until the user moves on.
  const [searchParams, setSearchParams] = useSearchParams();
  const downloadLink = useMemo(() => downloadLinkFrom(searchParams), [searchParams]);
  const resolvedLinkRef = useRef<string | null>(null);
  const [linkedTransferId, setLinkedTransferId] = useState<string | null>(null);
  const showLoading = useStableLoading(loading && !torrents.length && !error);

  // Every read of the client takes a generation, and a response may only be
  // applied if it is at least as new as the newest already applied. Loads, the
  // 5s poll and post-action refreshes all race each other: without this, a
  // poll that started before a delete can answer from a pre-delete snapshot
  // *after* the refresh that followed the delete and resurrect the rows the
  // user just removed. Mutations bump the counter first (`invalidateInFlight`)
  // so anything already in flight is discarded outright — the cheap,
  // dependency-free equivalent of aborting them.
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  const invalidateInFlight = useCallback(() => {
    requestSeqRef.current += 1;
    appliedSeqRef.current = requestSeqRef.current;
  }, []);

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
    const seq = ++requestSeqRef.current;
    /** Commit only if nothing newer has already landed. */
    const commit = (apply: () => void) => {
      if (!shouldApplySnapshot(seq, appliedSeqRef.current)) return false;
      appliedSeqRef.current = seq;
      apply();
      return true;
    };
    try {
      const res = await fetch("/api/client/torrents");
      const text = await res.text();
      let data: {
        torrents?: ClientTorrent[];
        clientType?: string;
        message?: string;
        error?: string;
        offline?: boolean;
        host?: string;
        hasExternal?: boolean;
        externalClientType?: string | null;
        partial?: boolean;
        clientIssues?: Array<{
          clientType: TorrentClientType;
          label: string;
          message: string;
          offline: boolean;
        }>;
      } = {};
      try {
        data = text ? (JSON.parse(text) as typeof data) : {};
      } catch {
        throw new Error(
          text?.trim()
            ? `Bad response: ${text.slice(0, 120)}`
            : "Empty response from client API",
        );
      }
      if (!shouldApplySnapshot(seq, appliedSeqRef.current)) return;
      if (data.clientType) setClientType(data.clientType);
      const type = data.clientType || "";
      // Never show a qBit-style host for built-in (avoids implying port 8080 is required)
      if (type === "builtin") {
        setClientHost("");
      } else if (data.host) {
        setClientHost(data.host);
      } else {
        setClientHost("");
      }

      const isBuiltin = type === "builtin";

      if (data.partial && data.clientIssues?.length) {
        const unavailable = data.clientIssues.map((issue) => issue.clientType);
        const warning = data.clientIssues
          .map((issue) => issue.message)
          .join(" ");
        commit(() =>
          setSnapshot((prev) =>
            applySnapshot(prev, {
              ok: false,
              offline: false,
              torrents: mergeOwnedTransferSnapshots(
                prev.torrents,
                data.torrents ?? [],
                unavailable,
              ),
              error: warning,
            }),
          ),
        );
        return;
      }

      if (!res.ok || data.offline) {
        // Offline framing is only for external clients (qBit/Transmission down).
        // Built-in failures are engine errors — not "client unreachable".
        commit(() =>
          setSnapshot((prev) =>
            applySnapshot(prev, {
              ok: false,
              offline: !isBuiltin && Boolean(data.offline || !res.ok),
              torrents: data.torrents,
              error:
                data.message ||
                data.error ||
                (isBuiltin
                  ? "Built-in engine failed to respond"
                  : "Torrent client is offline or unreachable"),
            }),
          ),
        );
        return;
      }
      commit(() =>
        setSnapshot((prev) => applySnapshot(prev, { ok: true, torrents: data.torrents ?? [] })),
      );
    } catch (err) {
      // Failure talking to our own Next API — a dev server restart, a sleeping
      // laptop, a dropped Wi-Fi. That is "we could not look", not "your
      // downloads are gone": the last good rows stay on screen and the state
      // stays non-authoritative so nothing auto-closes or announces a
      // disappearance that never happened.
      commit(() =>
        setSnapshot((prev) =>
          applySnapshot(prev, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  async function switchToBuiltin() {
    setSwitchingBuiltin(true);
    try {
      const res = await fetch("/api/settings/client", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ switchToBuiltin: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message || data.error || "Could not switch");
        return;
      }
      toast.success(
        data.message ||
          "Switched to the built-in downloader. Your external client connection is still saved.",
      );
      setSnapshot((prev) => ({ ...prev, error: null, offline: false }));
      await load();
    } catch {
      toast.error("Could not switch to the built-in downloader. Try again.");
    } finally {
      setSwitchingBuiltin(false);
    }
  }

  // First read on mount. Deliberately the same `load` the poll and every
  // post-action refresh use: a second hand-inlined copy of this fetch drifted
  // from the real one and had its own failure handling. Staleness is handled
  // by the generation counter inside `load`, not a local `cancelled` flag.
  useEffect(() => {
    void load();
  }, [load]);

  // Healthy: 5s poll. Offline: 20s (avoid 502 spam while client is down).
  //
  // Self-scheduling rather than `setInterval`, for two reasons. An interval
  // keeps firing while a request is still in flight, so a slow or hanging
  // client stacks up overlapping polls; chaining the next timer to the end of
  // the previous request cannot. And a background tab has nobody looking at
  // it — polling a torrent client every 5s from a tab left open overnight is
  // pure load on the engine for no one's benefit, so it pauses when hidden and
  // refreshes immediately on return.
  useVisiblePoll(() => load({ quiet: true }), {
    intervalMs: offline ? 20_000 : 5_000,
    paused: Boolean(pendingDelete),
  });

  // A built-in engine limit: an external client keeps its own queue.
  const maxActive = useMaxActiveDownloads({
    enabled: clientType === "builtin",
    onSaved: () => void load({ quiet: true }),
  });

  // Every download row this app tracks: the base both the main list and the
  // series dialog are built from.
  const downloadable = useMemo(() => torrents.filter(isDownloadRow), [torrents]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byStatus = downloadable.filter((t) => {
      const display = releaseDisplayFacts(t);
      if (
        q &&
        !t.name.toLowerCase().includes(q) &&
        !display.title.toLowerCase().includes(q) &&
        !(display.episodeLabel?.toLowerCase().includes(q) ?? false)
      ) {
        return false;
      }
      if (statusFilter === "downloading") return isDownloading(t.state);
      if (statusFilter === "queued") return isQueued(t.state);
      if (statusFilter === "ready") return isDownloaded(t.state);
      if (statusFilter === "paused") return isPaused(t.state);
      if (statusFilter === "attention") return isError(t.state);
      if (statusFilter === "active")
        return isDownloading(t.state) || isQueued(t.state);
      return true;
    });
    // Media type last, and through the shared rule: status answers "what is
    // this transfer doing", the tab answers "what kind of thing is it", and
    // they compose rather than override each other.
    return filterDownloadsByTab(byStatus, mediaTab);
  }, [downloadable, filter, statusFilter, mediaTab]);

  // One row per work, built from the search/status/tab-narrowed list — this is
  // what the compact main list actually draws.
  const grouped = useMemo(() => groupDownloads(filtered), [filtered]);
  const sortedGroups = useMemo(() => sortDownloadGroups(grouped, sort), [grouped, sort]);

  // Select-all is about the rows on screen. The dialog shares this one
  // `selected` set and can check episodes the page's filters hide, so counting
  // is not membership — see `snapshot-sync.ts`.
  const allVisibleSelected = useMemo(
    () => areAllVisibleSelected(filtered.map((t) => t.transferId), selected),
    [filtered, selected],
  );

  // The *same* grouping, but over every download row this app has regardless
  // of what the search box or the status/media-tab chips currently hide. The
  // series dialog's data contract requires it: opening "Details" on a show
  // must show every season and episode of that show even if, say, the status
  // filter is narrowed to "Paused" and only one stray episode matches it.
  const allGroups = useMemo(() => groupDownloads(downloadable), [downloadable]);

  const openGroup = useMemo(() => {
    if (!openSeriesKey) return null;
    return seriesGroupByKey(allGroups, openSeriesKey);
  }, [allGroups, openSeriesKey]);

  // Remember the last known title so the "closed" announcement can still name
  // the show after its group has already vanished from `allGroups`. Render-time
  // state adjustment (not an effect or a ref-during-render read/write, both of
  // which React disallows here) — guarded so it only fires when the title
  // actually changes.
  if (openGroup && openGroup.title !== openGroupTitle) setOpenGroupTitle(openGroup.title);

  // If the series this dialog is open for really disappears — every one of its
  // torrents deleted — close cleanly rather than keep showing a dialog for a
  // group that no longer exists, and say so for anyone using a screen reader.
  // Gated on `authoritative`: a quiet poll that failed (Wi-Fi drop, dev server
  // restart, sleeping laptop) is not evidence of a deletion, and must never be
  // allowed to yank an open dialog shut or announce that downloads are gone.
  // `openGroup` is already a pure derivation of state available this render, so
  // this is React's documented "adjust state during render" alternative to a
  // synchronizing effect: it self-guards because clearing `openSeriesKey` makes
  // the condition false on the very next render.
  if (
    shouldCloseMissingGroup({
      openKey: openSeriesKey,
      groupFound: Boolean(openGroup),
      authoritative,
    })
  ) {
    setOpenSeriesKey(null);
    setSelectedSeasonKey(null);
    setAnnouncement(`${openGroupTitle || "This show"}’s downloads are gone. Closed details.`);
  }

  // The default season is the one the user is waiting on; an already-picked
  // season survives every poll where it still exists, so the dialog's body
  // does not jump around under someone mid-read. See `season-selection.ts`.
  // Same render-time adjustment pattern: guarded by equality with the state
  // it's adjusting, so it converges after at most one extra render.
  if (openGroup) {
    const resolvedSeasonKey = resolveSelectedSeasonKey(openGroup.seasons, selectedSeasonKey);
    if (resolvedSeasonKey !== selectedSeasonKey) setSelectedSeasonKey(resolvedSeasonKey);
  }

  // Arriving from a notification's "View details": find that download in a
  // real read of the client (a failed poll proves nothing about what is gone),
  // show it, then take the link out of the address so a refresh doesn't replay it.
  useEffect(() => {
    if (!downloadLink) {
      resolvedLinkRef.current = null;
      return;
    }
    if (!authoritative) return;
    const key = downloadLinkKey(downloadLink);
    if (resolvedLinkRef.current === key) return;
    resolvedLinkRef.current = key;
    setSearchParams(withoutDownloadLink, { replace: true, preventScrollReset: true });
    const target = findLinkedDownload(downloadable, downloadLink);
    if (!target) {
      toast.info("That download was removed");
      setAnnouncement("That download was removed.");
      return;
    }
    if (!filtered.includes(target)) {
      setFilter("");
      setStatusFilter("all");
      setMediaTab(DEFAULT_DOWNLOAD_TAB);
    }
    setLinkedTransferId(target.transferId);
    setAnnouncement(`Showing ${transferLabel(target)}.`);
    const series = allGroups.find(
      (group): group is SeriesGroup<ClientTorrent> =>
        group.kind === "series" && group.torrents.includes(target),
    );
    if (series) {
      // Nothing on this page opened the dialog; closing it returns focus to the show's row.
      seriesDialogOpenerRef.current = null;
      setOpenSeriesKey(series.key);
      setSelectedSeasonKey(
        series.seasons.find((season) => season.entries.some((entry) => entry.torrent === target))
          ?.key ?? null,
      );
    }
  }, [downloadLink, authoritative, downloadable, filtered, allGroups, setSearchParams]);

  // The ring says "this is the one you came for"; it goes once the user does anything else.
  useEffect(() => {
    if (!linkedTransferId) return;
    const clear = () => setLinkedTransferId(null);
    const options = { capture: true, once: true } as const;
    window.addEventListener("pointerdown", clear, options);
    window.addEventListener("keydown", clear, options);
    return () => {
      window.removeEventListener("pointerdown", clear, options);
      window.removeEventListener("keydown", clear, options);
    };
  }, [linkedTransferId]);

  // Artwork is looked up for the whole table at once, keyed by work — the poll
  // runs every five seconds and three episodes of one show are one lookup.
  // Deliberately driven by `torrents`, not `filtered`: typing in the filter box
  // must not re-ask for what is already known.
  const artwork = useReleaseArtwork(torrents);

  // Keyboard: Escape clears selection; Delete opens confirm; Ctrl/Cmd-A select all
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelected(new Set());
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selected.size > 0 &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        const targets = torrents.filter((t) => selected.has(t.transferId));
        if (targets.length) setPendingDelete(targets);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (e.target instanceof HTMLInputElement) return;
        e.preventDefault();
        setSelected((prev) => {
          const next = new Set(prev);
          for (const t of filtered) next.add(t.transferId);
          return next;
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, torrents, filtered]);

  // The same per-state counts every group rollup uses, so the summary line and
  // the rows can never disagree about what "downloading" or "queued" means.
  const stats = useMemo(() => {
    let dlspeed = 0;
    let upspeed = 0;
    for (const t of downloadable) {
      dlspeed += t.dlspeed || 0;
      upspeed += t.upspeed || 0;
    }
    return { ...statusCounts(downloadable), dlspeed, upspeed };
  }, [downloadable]);

  // What the bulk bar's Pause and Resume would act on: only the selected rows each one applies to.
  const selectedTargets = useMemo(
    () => pauseResumeTargets(torrents.filter((torrent) => selected.has(torrent.transferId))),
    [torrents, selected],
  );

  const rawSendTrimmed = rawSendValue.trim();
  const rawSendInvalid =
    rawSendTrimmed.length > 0 && !isValidTorrentSourceInput(rawSendValue);
  const rawSendClientError = rawSendInvalid
    ? TORRENT_SOURCE_INPUT_HINT
    : rawSendError?.field === "source"
      ? rawSendError.message
      : null;
  const rawSendAnyError = rawSendClientError || rawSendError?.message || null;

  async function action(act: TorrentRowAction, torrent: ClientTorrent) {
    if (act === "swap") { setSwapTorrent(torrent); return; }
    // Any read already in flight answers from before this change; drop it so
    // its older snapshot cannot land on top of the refresh below.
    invalidateInFlight();
    const label = transferLabel(torrent);
    // Resume on a failed row is the row's "Retry".
    const verb =
      act === "force" ? "start" : act === "resume" && isError(torrent.state) ? "retry" : act;
    const outcome = await postRowAction(act, torrent);
    void load();
    if (!outcome.ok) {
      toast.error(`Couldn't ${verb} ${label}`, { description: outcome.reason });
      setAnnouncement(`Couldn't ${verb} ${label}.`);
      return;
    }
    if (act === "force") {
      toast.success(`Started ${label}`);
      setAnnouncement(`Started ${label}.`);
      return;
    }
    setAnnouncement(
      `${act === "pause" ? "Paused" : verb === "retry" ? "Retrying" : "Resumed"} ${label}.`,
    );
  }

  async function sendRawTorrent() {
    const parsed = parseTorrentSourceInput(rawSendValue);
    if (!parsed) {
      setRawSendError({ message: TORRENT_SOURCE_INPUT_HINT, field: "source" });
      return;
    }
    setRawSendError(null);
    invalidateInFlight();
    if (!(await ensureDownloadSetup())) return;
    setSendingRaw(true);
    try {
      const res = await fetch("/api/torrent/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...parsed,
          source: "manual",
          target: "primary",
          retention: "keep",
        }),
      });
      const data = await readJsonBody<{ ok?: boolean; message?: string; error?: string }>(res);
      if (res.ok && data && data.ok !== false) {
        toast.success(data.message || "Added to downloads");
        setRawSendValue("");
      } else {
        setRawSendError(sendErrorFromBody(data, res.status));
      }
    } catch (err) {
      setRawSendError({
        message: err instanceof Error && err.message ? err.message : "Couldn't reach TorrentFlow. Try again.",
        field: null,
      });
    } finally {
      setSendingRaw(false);
      // Refresh either way: a failed send must not leave a half-added row on screen.
      void load();
    }
  }

  async function actionMany(
    act: "pause" | "resume",
    transfers: ClientTorrent[],
  ) {
    if (!transfers.length) return;
    invalidateInFlight();
    const outcomes = await Promise.all(
      transfers.map((torrent) => postRowAction(act, torrent)),
    );
    void load();
    const reasons = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.reason]));
    const done = transfers.length - reasons.length;
    const verbed = act === "pause" ? "Paused" : "Resumed";
    const what = transfersLabel(transfers);
    if (!reasons.length) {
      toast.success(`${verbed} ${what}`);
      setAnnouncement(`${verbed} ${what}.`);
    } else if (done > 0) {
      const summary = `${verbed} ${done} of ${transfers.length} downloads`;
      toast.warning(summary, {
        description: `${plural(reasons.length, "download")} couldn't ${act}: ${reasons[0]}`,
      });
      setAnnouncement(`${summary}.`);
    } else {
      toast.error(`Couldn't ${act} ${what}`, { description: reasons[0] });
      setAnnouncement(`Couldn't ${act} ${what}.`);
    }
  }

  async function bulkAction(act: "pause" | "resume") {
    await actionMany(act, selectedTargets[act]);
  }

  async function confirmDelete(deleteFiles: boolean) {
    if (!pendingDelete?.length) return;
    const what = transfersLabel(pendingDelete);
    const their = pendingDelete.length === 1 ? "its" : "their";
    setDeleting(true);
    // A poll that started before this delete would answer from a pre-delete
    // snapshot and resurrect the rows; discard anything already in flight.
    invalidateInFlight();
    try {
      type DeleteResult = { ok: boolean; name: string; msg?: string };
      const post = async (payload: Record<string, unknown>) => {
        const res = await fetch("/api/client/torrents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete", deleteFiles, ...payload }),
        });
        const text = await res.text();
        try {
          return {
            res,
            data: (text ? JSON.parse(text) : {}) as {
              ok?: boolean;
              message?: string;
              error?: string;
              results?: { hash: string; ok: boolean; message?: string }[];
            },
          };
        } catch {
          return { res, data: null };
        }
      };
      // Built-in downloads go in one request: the server removes every row
      // before any file, so a whole season takes its season folder with it.
      const builtin = pendingDelete.filter(
        (t) => t.ownerClientType === "builtin",
      );
      const external = pendingDelete.filter(
        (t) => t.ownerClientType !== "builtin",
      );
      const results: DeleteResult[] = [];
      if (builtin.length) {
        const { res, data } = await post({
          hashes: builtin.map((t) => t.hash),
          ownerClientType: "builtin",
        });
        for (const t of builtin) {
          const row = data?.results?.find(
            (r) => r.hash.toLowerCase() === t.hash.toLowerCase(),
          );
          results.push(
            row
              ? { ok: row.ok, name: t.name, msg: row.message }
              : {
                  ok: false,
                  name: t.name,
                  msg:
                    data?.message ||
                    data?.error ||
                    `TorrentFlow answered HTTP ${res.status}. Try again.`,
                },
          );
        }
      }
      for (const t of external) {
        const { res, data } = await post({
          hash: t.hash,
          ownerClientType: t.ownerClientType,
        });
        results.push(
          data
            ? {
                ok: res.ok && data.ok !== false,
                name: t.name,
                msg: data.message || data.error,
              }
            : {
                ok: false,
                name: t.name,
                msg: `TorrentFlow answered HTTP ${res.status}. Try again.`,
              },
        );
      }
      const failed = results.filter((r) => !r.ok);
      const removed = results.length - failed.length;
      if (!failed.length) {
        const summary = deleteFiles
          ? `Removed ${what} and ${their} files`
          : `Removed ${what} but kept ${their} files`;
        toast.success(summary);
        setAnnouncement(`${summary}.`);
      } else {
        const reason = failed[0].msg?.trim() || "TorrentFlow couldn't remove it. Try again.";
        const summary = removed
          ? `Removed ${removed} of ${results.length} downloads`
          : `Couldn't remove ${what}`;
        if (removed) {
          toast.warning(summary, {
            description: `${plural(failed.length, "download")} couldn't be removed: ${reason}`,
          });
        } else {
          toast.error(summary, { description: reason });
        }
        setAnnouncement(`${summary}.`);
      }
      setSelected(new Set());
      setPendingDelete(null);
      void load();
    } catch {
      toast.error(`Couldn't remove ${what}`, {
        description: "Couldn't reach TorrentFlow. Try again.",
      });
      setAnnouncement(`Couldn't remove ${what}.`);
    } finally {
      setDeleting(false);
    }
  }

  async function tidyFolders() {
    setTidying(true);
    try {
      const res = await fetch("/api/client/torrents/tidy", { method: "POST" });
      const data = (await res.json().catch(() => null)) as TidyResult | null;
      if (!res.ok || !data) {
        toast.error("Could not tidy folders. Try again.");
        return;
      }
      const notes = [
        data.stillNested > 0
          ? `${plural(data.stillNested, "video")} kept in a release folder because another download already has that name`
          : "",
        data.skipped > 0 ? `${plural(data.skipped, "download")} in use, try again later` : "",
      ].filter(Boolean);
      const description = notes.length ? { description: notes.join(". ") } : undefined;
      if (data.filesMoved === 0) toast.success("Folders are already tidy", description);
      else
        toast.success(
          `Moved ${plural(data.filesMoved, "file")} from ${plural(data.tidied, "download")}`,
          description,
        );
      void load();
    } catch {
      toast.error("Network error tidying folders");
    } finally {
      setTidying(false);
    }
  }

  async function openDownloadFolder(t: ClientTorrent) {
    setOpeningHash(t.transferId);
    try {
      const res = await fetch("/api/settings/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: t.savePath?.trim() || null,
          category: t.category || null,
        }),
      });
      const text = await res.text();
      let data: {
        ok?: boolean;
        message?: string;
        error?: string;
        path?: string;
        pathOnly?: string;
      } = {};
      try {
        data = text ? (JSON.parse(text) as typeof data) : {};
      } catch {
        toast.error("Empty response opening folder");
        return;
      }
      if (data.ok) {
        toast.success(data.message || "Opened folder");
        return;
      }
      const p = data.path || data.pathOnly || t.savePath || "";
      if (p) {
        try {
          await navigator.clipboard.writeText(p);
          toast.message(data.message || "Could not open", {
            description: "Path copied to clipboard",
          });
          return;
        } catch {
          /* fall through */
        }
      }
      toast.error(data.message || data.error || "Could not open folder");
    } catch {
      toast.error("Network error opening folder");
    } finally {
      setOpeningHash(null);
    }
  }

  /** Open in the owner's own player, or Show in folder (docs/api-open-file.md). */
  async function openFinishedFile(t: ClientTorrent, mode: OpenDownloadMode) {
    setOpeningHash(t.transferId);
    try {
      await openDownload(t.transferId, mode, t.savePath ? displayPath(t.savePath) : null);
    } finally {
      setOpeningHash(null);
    }
  }

  /** The folder fallback when this computer can't open folders (remote access, a container). */
  function copyFolderPath(t: ClientTorrent) {
    if (t.savePath) void copyDownloadPath(displayPath(t.savePath));
  }

  async function copyMagnet(t: ClientTorrent) {
    if (t.imported) { toast.info("Imported local files have no torrent metadata or magnet link."); return; }
    const magnet = magnetFor(t);
    try {
      await navigator.clipboard.writeText(magnet);
      toast.success("Magnet link copied");
    } catch {
      toast.error("Could not copy magnet link", { description: magnet });
    }
  }

  function toggleSelect(transferId: string, additive: boolean) {
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      if (prev.has(transferId) && additive) next.delete(transferId);
      else next.add(transferId);
      return next;
    });
  }

  /**
   * Checks every one of these, or clears them when all are already checked:
   * a series row's checkbox and a season's "Select all" in the series dialog.
   * Both show a dash while only some are checked, and a click then checks the
   * rest. The bulk bar counts what is checked and Delete still confirms it.
   */
  function toggleGroupSelect(transferIds: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      const all = transferIds.every((transferId) => next.has(transferId));
      for (const transferId of transferIds) {
        if (all) next.delete(transferId);
        else next.add(transferId);
      }
      return next;
    });
  }

  function openDeleteDialog(torrentsToDelete: ClientTorrent[]) {
    setPendingDelete(torrentsToDelete);
  }

  function toggleSelectAll() {
    // Visible-row membership, not a count comparison against `filtered`: the
    // series dialog writes into this same set from rows the page's filters
    // hide, so equal counts prove nothing about what is checked on screen.
    setSelected((prev) =>
      toggleVisibleSelection(
        filtered.map((t) => t.transferId),
        prev,
      ),
    );
  }

  function openSeriesDialog(key: string, opener?: EventTarget | null) {
    if (opener instanceof HTMLElement) seriesDialogOpenerRef.current = opener;
    setOpenSeriesKey(key);
  }

  function closeSeriesDialog() {
    const key = openSeriesKey;
    setOpenSeriesKey(null);
    setSelectedSeasonKey(null);
    // A dialog a notification link opened has no opener; the show's own Details button stands in.
    const opener = seriesDialogOpenerRef.current?.isConnected
      ? seriesDialogOpenerRef.current
      : key
        ? document.querySelector<HTMLElement>(`[data-group-key="${CSS.escape(key)}"] [data-group-details]`)
        : null;
    if (opener) requestAnimationFrame(() => opener.focus());
  }

  if (loading && !torrents.length && !error) {
    return <ClientSkeleton visible={showLoading} />;
  }

  const isBuiltin = clientType === "builtin";

  const statusChips: { id: StatusFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "downloading", label: "Downloading" },
    // Only while something waits its turn, the same way Needs attention
    // appears: an always-empty chip is one more thing to read.
    ...(stats.queued > 0 || statusFilter === "queued"
      ? [{ id: "queued" as const, label: "Queued" }]
      : []),
    { id: "ready", label: "Ready" },
    { id: "paused", label: "Paused" },
    ...(stats.error > 0 || statusFilter === "attention"
      ? [{ id: "attention" as const, label: "Needs attention" }]
      : []),
  ];

  const summaryParts: { id: StatusFilter; label: string; hook: string }[] = [
    { id: "all", label: `${stats.total} ${stats.total === 1 ? "download" : "downloads"}`, hook: "total" },
    ...(stats.downloading > 0 ? [{ id: "downloading" as const, label: `${stats.downloading} downloading`, hook: "downloading" }] : []),
    ...(stats.queued > 0 ? [{ id: "queued" as const, label: `${stats.queued} queued`, hook: "queued" }] : []),
    ...(stats.done > 0 ? [{ id: "ready" as const, label: `${stats.done} ready`, hook: "ready" }] : []),
    ...(stats.paused > 0 ? [{ id: "paused" as const, label: `${stats.paused} paused`, hook: "paused" }] : []),
    ...(stats.error > 0
      ? [{ id: "attention" as const, label: needsAttentionLabel(stats.error), hook: "attention" }]
      : []),
  ];
  const liveSpeed = stats.downloading > 0 ? speedLabel(stats.dlspeed) : null;
  const clientUnavailable = offline && !isBuiltin;

  return (
    <div className="container-app max-w-5xl py-6 sm:py-8 space-y-4 min-w-0">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <TfPageHeader
        title="Downloads"
        meta={
          clientUnavailable ? (
            <p
              className="flex items-center gap-2 text-[13px] text-destructive"
              data-client-status="offline"
            >
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
              Can&apos;t reach {clientLabel(clientType)}. Retrying automatically.
            </p>
          ) : (
            // Dots only from lg, where the line fits on one row: below that it
            // wraps, and a wrapped row must not start with a stray dot.
            <div
              className="flex flex-wrap items-center gap-x-3 text-[13px] tabular-nums text-muted-foreground lg:gap-x-1"
              data-client-status="connected"
              data-downloads-summary
            >
              <span
                className="inline-flex items-center gap-2 text-foreground"
                title={!isBuiltin && clientHost ? `${clientLabel(clientType)} at ${clientHost}` : undefined}
                data-client-connection
              >
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
                {isBuiltin ? "Connected" : `Connected to ${clientLabel(clientType)}`}
              </span>
              {summaryParts.map((part) => (
                <span key={part.id} className="inline-flex items-center">
                  <span aria-hidden className="hidden px-1 text-subtle-foreground lg:inline">·</span>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className={cn(
                      "h-auto px-0 text-[13px] font-normal tabular-nums max-md:min-h-11 pointer-coarse:min-h-11",
                      part.id === "attention" ? "text-destructive" : "text-muted-foreground",
                      statusFilter === part.id && part.id !== "all" && "font-medium text-foreground underline",
                    )}
                    aria-pressed={statusFilter === part.id}
                    onClick={() => setStatusFilter(part.id)}
                    data-summary-part={part.hook}
                    data-stat-value={
                      part.hook === "downloading" ? stats.downloading : part.hook === "queued" ? stats.queued : undefined
                    }
                  >
                    {part.label}
                  </Button>
                </span>
              ))}
              {liveSpeed ? (
                <span className="inline-flex items-center font-mono text-brand-foreground" data-summary-speed>
                  <span aria-hidden className="hidden px-1 font-sans text-subtle-foreground lg:inline">·</span>
                  ↓ {liveSpeed}
                </span>
              ) : null}
              {isBuiltin && ((maxActive.limits && maxActive.value != null) || !maxActive.settled) ? (
                <span
                  className={cn(
                    "inline-flex items-center whitespace-nowrap",
                    // Held, invisible, until the limit is read: the stepper
                    // can wrap the line on a phone, so it must not arrive late.
                    !maxActive.settled && "invisible",
                  )}
                  aria-hidden={!maxActive.settled || undefined}
                  inert={!maxActive.settled}
                  data-max-active-inline={maxActive.limits?.source ?? "pending"}
                >
                  <span aria-hidden className="hidden px-1 text-subtle-foreground lg:inline">·</span>
                  {maxActive.limits?.source === "schedule" ? (
                    // Open download hours set their own cap, so a stepper here would do nothing.
                    <>
                      up to {maxActive.limits?.effective} at once (
                      <Button
                        asChild
                        variant="link"
                        size="sm"
                        className="h-auto px-0 text-[13px] font-normal text-muted-foreground underline max-md:min-h-11 pointer-coarse:min-h-11"
                      >
                        <Link to="/settings?tab=folders" data-max-active-schedule>
                          download hours
                        </Link>
                      </Button>
                      )
                    </>
                  ) : (
                    <>
                      up to
                      <MaxActiveDownloadsControl
                        variant="inline"
                        value={maxActive.value ?? 1}
                        onChange={maxActive.change}
                        className="mx-1.5"
                      />
                      at once
                    </>
                  )}
                </span>
              ) : null}
            </div>
          )
        }
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void load()}
              aria-label="Refresh downloads"
              data-downloads-refresh
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
            {/* Secondary actions live in overflow on phone so the toolbar
                stays ≥44px and doesn't cram three labeled buttons at 390. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="More download actions"
                  data-downloads-more
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sm:inline">More</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[12rem]">
                {isBuiltin ? (
                  <DropdownMenuItem
                    disabled={tidying}
                    onClick={() => void tidyFolders()}
                    data-tidy-folders
                  >
                    <FolderTree className={cn("h-3.5 w-3.5", tidying && "animate-pulse")} />
                    {tidying ? "Tidying…" : "Tidy folders"}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <Link to="/settings?tab=connection">Settings</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <Collapsible
        open={addPanelOpen}
        onOpenChange={toggleAddPanel}
        className="surface group/add"
        data-raw-torrent-send
      >
        <CollapsibleTrigger
          className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-[inherit] px-4 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
          data-raw-torrent-toggle
        >
          <Magnet aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">Add torrent</span>
          <span className="hidden min-w-0 truncate text-[12px] text-subtle-foreground sm:inline">
            Magnet link or .torrent URL
          </span>
          <ChevronDown
            aria-hidden
            className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/add:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 px-4 pb-4 pt-1">
          <p className="text-[12px] leading-relaxed text-subtle-foreground">
            Paste a magnet link or a direct .torrent URL, then add it to your downloads.
          </p>
          <Textarea
            ref={rawSendInputRef}
            className="min-h-24"
            value={rawSendValue}
            onChange={(event) => {
              setRawSendValue(event.target.value);
              if (rawSendError) setRawSendError(null);
            }}
            placeholder="magnet:?xt=urn:btih:… or https://example.com/release.torrent"
            aria-label="Paste a magnet link or .torrent URL"
            aria-invalid={rawSendInvalid || rawSendError?.field === "source" || undefined}
            aria-describedby={rawSendAnyError ? "raw-torrent-send-error" : undefined}
            data-raw-torrent-send-input
          />
          {rawSendInvalid ? (
            <p
              id="raw-torrent-send-error"
              className="text-[12px] leading-relaxed text-destructive"
              data-raw-torrent-send-error="source"
              data-raw-torrent-invalid
            >
              {TORRENT_SOURCE_INPUT_HINT}
            </p>
          ) : rawSendError ? (
            <p
              id="raw-torrent-send-error"
              role="alert"
              className="text-[12px] leading-relaxed text-destructive"
              data-raw-torrent-send-error={rawSendError.field ?? "send"}
            >
              {rawSendError.message}
              {rawSendError.field === "savePath" ? (
                <>
                  {" "}
                  <Link
                    to="/settings"
                    className="inline-flex min-h-[44px] items-center font-medium text-brand-foreground underline underline-offset-2 lg:min-h-0"
                  >
                    Open Settings
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              onClick={() => void sendRawTorrent()}
              disabled={sendingRaw || !rawSendTrimmed || rawSendInvalid}
              className="w-full shrink-0 sm:w-auto"
              data-raw-torrent-send-button
            >
              {sendingRaw ? <LoadingGlyph className="h-3.5 w-3.5" /> : <Magnet aria-hidden />}
              Add torrent
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/*
        The full error panel replaces the page only when there is nothing left
        to show. With last-good rows preserved through a failed poll (see
        `snapshot-sync.ts`), blanking the list would tell the user their
        downloads vanished when all that happened is one read failed — so the
        rows stay and the failure is reported as a strip above them.
      */}
      {error && torrents.length > 0 ? (
        <div
          className="surface flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-[12px]"
          role="status"
          data-client-stale
        >
          <span className="font-medium text-foreground">
            {offline && !isBuiltin
              ? "Torrent client unavailable"
              : "Could not refresh downloads"}
          </span>
          <span className="min-w-0 flex-1 text-muted-foreground">
            Showing the last known state. Your downloads are unchanged.
          </span>
          <DetailsDisclosure className="min-w-0 text-subtle-foreground" data-client-error-details>
            <p className="mt-1 break-words font-mono text-[12px]">{error}</p>
          </DetailsDisclosure>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void load()}
            className="shrink-0"
          >
            Retry now
          </Button>
        </div>
      ) : null}

      {error && !torrents.length ? (
        <div
          className="surface p-5 space-y-3 text-sm"
          role="alert"
          data-client-offline={offline && !isBuiltin ? "true" : undefined}
          data-client-engine-error={isBuiltin || !offline ? "true" : undefined}
        >
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {isBuiltin
                ? "Downloads are temporarily unavailable"
                : offline
                  ? "Torrent client unavailable"
                  : "Downloads could not load"}
            </p>
            <p className="text-muted-foreground leading-relaxed">
              {isBuiltin
                ? "Retry now. If this keeps happening, check the download connection settings."
                : offline
                  ? "Reconnect the client, or switch to the built-in downloader."
                  : "Retry now, or check the download connection settings."}
            </p>
            <DetailsDisclosure className="text-subtle-foreground" data-client-error-details>
              <p className="mt-1 break-words font-mono text-[12px]">{error}</p>
            </DetailsDisclosure>
          </div>
          <div className="flex flex-wrap gap-2">
            {!isBuiltin ? (
              <Button
                type="button"
                size="sm"
                onClick={() => void switchToBuiltin()}
                disabled={switchingBuiltin}
                data-switch-to-builtin
              >
                {switchingBuiltin ? (
                  <LoadingGlyph className="h-3.5 w-3.5" />
                ) : null}
                Use built-in downloader
              </Button>
            ) : null}
            <Button asChild size="sm" variant={!isBuiltin ? "secondary" : "default"}>
              <Link to="/settings?tab=connection">Open connection settings</Link>
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void load()}
            >
              Retry now
            </Button>
          </div>
          <p className="text-[12px] text-subtle-foreground">
            {isBuiltin
              ? "Check that the saved download folder is available, then retry."
              : "Switch to the built-in downloader, or reconnect your external client and retry."}
          </p>
        </div>
      ) : (
        <>
          {/*
            Two filters, two questions. The tab bar asks what kind of thing you
            are after and sits above; the status chips ask what a transfer is
            doing and stay beside the search box. They compose — Series +
            Downloading is a real thing to want — so neither clears the other.
            Neither reaches into the series dialog: it always shows every
            season and episode of the show it was opened for, regardless of
            what these narrow the main list down to (see `allGroups` above).
          */}
          <Tabs
            value={mediaTab}
            onValueChange={(value) => setMediaTab(value as DownloadTab)}
            className="min-w-0 gap-4"
          >
          <ScrollArea className="min-w-0">
            <TabsList aria-label="Media type" className="group-data-horizontal/tabs:h-auto" data-media-tabs>
              {DOWNLOAD_TABS.map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  data-media-tab={tab}
                  className="h-8 flex-none px-3 text-[13px] max-md:h-11 pointer-coarse:h-11"
                >
                  {DOWNLOAD_TAB_LABELS[tab]}
                </TabsTrigger>
              ))}
            </TabsList>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>

          <TabsContent value={mediaTab} className="min-w-0 space-y-4">
          {/* Toolbar */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2 sm:max-w-md sm:flex-1">
              <InputGroup className="h-auto min-w-0 flex-1">
                <InputGroupAddon>
                  <Search aria-hidden className="size-3.5" />
                </InputGroupAddon>
                <InputGroupInput
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter torrents…"
                  aria-label="Filter downloads"
                  data-client-filter
                />
              </InputGroup>
              <Select value={sort} onValueChange={(value) => setSort(value as DownloadSort)}>
                <SelectTrigger
                  size="sm"
                  aria-label="Sort downloads"
                  title="Sort"
                  className="shrink-0 text-[13px]"
                  data-downloads-sort
                >
                  <ArrowDownUp aria-hidden className="size-3.5 text-muted-foreground" />
                  <SelectValue>{downloadSortShortLabel(sort)}</SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  {DOWNLOAD_SORTS.map((option) => (
                    <SelectItem
                      key={option}
                      value={option}
                      className="min-h-11 sm:min-h-0"
                      data-downloads-sort-option={option}
                    >
                      {DOWNLOAD_SORT_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ScrollArea className="min-w-0 sm:shrink-0">
            <ToggleGroup
              type="single"
              value={statusFilter}
              onValueChange={(value) => {
                if (value) setStatusFilter(value as StatusFilter);
              }}
              aria-label="Status"
              spacing={1}
              className="flex-nowrap"
              data-status-filters
            >
              {statusChips.map((c) => (
                <ToggleGroupItem
                  key={c.id}
                  value={c.id}
                  size="sm"
                  data-status-filter={c.id}
                  className="px-2.5 text-xs text-subtle-foreground hover:text-muted-foreground data-[state=on]:text-foreground max-md:h-11 max-md:min-w-11 pointer-coarse:h-11 pointer-coarse:min-w-11"
                >
                  {c.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </div>

          {selected.size > 0 ? (
            <div
              className="surface flex flex-wrap items-center gap-2 px-3 py-2"
              data-bulk-bar
            >
              <span className="text-[12px] text-muted-foreground mr-1">
                {selected.size} selected
              </span>
              {/*
                aria-disabled, not disabled, when nothing selected applies:
                Pause stops applying the moment it has worked, while it still
                has focus, and a disabled button drops focus to <body>.
              */}
              <Button
                size="sm"
                variant="secondary"
                aria-disabled={!selectedTargets.pause.length || undefined}
                onClick={() => {
                  if (selectedTargets.pause.length) void bulkAction("pause");
                }}
                data-bulk-pause
              >
                <Pause className="h-3.5 w-3.5" />
                Pause
              </Button>
              <Button
                size="sm"
                variant="secondary"
                aria-disabled={!selectedTargets.resume.length || undefined}
                onClick={() => {
                  if (selectedTargets.resume.length) void bulkAction("resume");
                }}
                data-bulk-resume
              >
                <Play className="h-3.5 w-3.5" />
                Resume
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() =>
                  openDeleteDialog(
                    torrents.filter((t) => selected.has(t.transferId)),
                  )
                }
                data-bulk-delete
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            </div>
          ) : null}

          {/*
            No `!error` guard is needed here: this branch is the `else` of the
            "errored with nothing to show" panel above, so an errored *empty*
            page never reaches the empty state (an errored page that still has
            last-good rows fails `!torrents.length` anyway). Verified by
            `npm run test:errors`, which forces /api/client/torrents to 500 and
            asserts "No downloads yet" stays hidden — keep that structure if
            this section is ever flattened.
          */}
          <LookingSection />
          {!torrents.length && !loading ? (
            <div className="space-y-4">
            <TfEmptyState
              icon={HardDriveDownload}
              title="No downloads yet"
              description={
                isBuiltin
                 ? "Find a title and choose Download to see it here."
                 : "Find a title and choose Download to send it to your connected client."
              }
              actionLabel="Open search"
              actionHref="/"
            />
            {isBuiltin && <DownloadRecovery mode="empty" onImported={() => void load()} />}
            </div>
          ) : (
            <>
            {isBuiltin &&
            torrents.length > 0 &&
            torrents.every(
              (t) => t.progress < 0.01 && /meta|stall/i.test(t.state),
            ) ? (
              <p className="text-[12px] text-subtle-foreground px-1 mb-2">
                These downloads have not started yet. Give them a minute to find
                available copies; if they stay at 0%, try another version with
                more sources.
              </p>
            ) : null}
            <div className="surface overflow-hidden" data-client-table>
              {/* Header row */}
              <div className="hidden sm:grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 items-center px-3 py-2 border-b border-border text-[12px] font-medium uppercase tracking-wide text-subtle-foreground">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={() => toggleSelectAll()}
                  aria-label="Select all"
                  data-select-all
                />
                <span>Name</span>
                <span className="text-right pr-1">Actions</span>
              </div>

              {/*
                One compact row per work: a series card with its overall state
                and an explicit way in (Details), or a film row with its own
                controls. Neither ever grows an inline season or episode
                list here — that disclosure lives entirely in
                `SeriesDownloadDialog` now.
              */}
              <div className="divide-y divide-border">
                {sortedGroups.map((group) => {
                  if (group.kind === "series") {
                    return (
                      <SeriesOverviewRow
                        key={group.key}
                        group={group}
                        artwork={artwork}
                        selected={selected}
                        onToggleGroupSelect={toggleGroupSelect}
                        onOpenDetails={openSeriesDialog}
                        onActionMany={(act, transfers) =>
                          void actionMany(act, transfers)
                        }
                        onDeleteRequest={openDeleteDialog}
                      />
                    );
                  }
                  const t = group.torrent;
                  return (
                    <FilmRow
                      key={t.transferId}
                      torrent={t}
                      isSelected={selected.has(t.transferId)}
                      highlighted={t.transferId === linkedTransferId}
                      openingHash={openingHash}
                      artwork={artwork}
                      onToggleSelect={toggleSelect}
                      onAction={(act, torrent) => void action(act, torrent)}
                      onOpenFolder={(torrent) => void openDownloadFolder(torrent)}
                      onOpenFile={(torrent, mode) => void openFinishedFile(torrent, mode)}
                      onCopyPath={copyFolderPath}
                      onCopyMagnet={(torrent) => void copyMagnet(torrent)}
                      onDeleteRequest={openDeleteDialog}
                    />
                  );
                })}
              </div>

              {filtered.length === 0 && torrents.length > 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-subtle-foreground">
                  No torrents match this filter.
                </p>
              ) : null}
            </div>
            </>
          )}
          </TabsContent>
          </Tabs>
        </>
      )}

      {openGroup ? (
        <SeriesDownloadDialog
          group={openGroup}
          open
          onOpenChange={(next) => {
            if (!next) closeSeriesDialog();
          }}
          titleHref={downloadTitleHref(openGroup.torrents[0])}
          artwork={artwork}
          selectedSeasonKey={selectedSeasonKey}
          onSelectSeason={setSelectedSeasonKey}
          selected={selected}
          onToggleSelect={toggleSelect}
          onToggleManySelect={toggleGroupSelect}
          highlightedTransferId={linkedTransferId}
          openingHash={openingHash}
          onAction={(act, torrent) => void action(act, torrent)}
          onActionMany={(act, transfers) => void actionMany(act, transfers)}
          onOpenFolder={(t) => void openDownloadFolder(t)}
          onOpenFile={(t, mode) => void openFinishedFile(t, mode)}
          onCopyPath={copyFolderPath}
          onCopyMagnet={(t) => void copyMagnet(t)}
          onDeleteRequest={openDeleteDialog}
        />
      ) : null}

      {swapTorrent ? (
        <ReleaseSwapDialog
          torrent={swapTorrent}
          onClose={() => setSwapTorrent(null)}
          onSwapped={(releaseName) => {
            invalidateInFlight();
            const swapped = swapTorrent;
            setSelected((previous) => {
              if (!previous.has(swapped.transferId)) return previous;
              const next = new Set(previous);
              next.delete(swapped.transferId);
              return next;
            });
            setSwapTorrent(null);
            setAnnouncement(`Switched to ${releaseName}.`);
            void load();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        contentData={{ "data-delete-dialog": true }}
        cancelData={{ "data-delete-cancel": true }}
        confirmData={{ "data-delete-with-files": true }}
        title={pendingDelete ? `Delete ${transfersLabel(pendingDelete)}?` : "Delete download?"}
        variant="destructive"
        busy={deleting}
        icon={<Trash2 className="h-3.5 w-3.5" />}
        confirmLabel="Delete with files"
        onConfirm={() => void confirmDelete(true)}
        secondaryAction={
          <Button
            type="button"
            variant="outline"
            disabled={deleting}
            onClick={() => void confirmDelete(false)}
            className="max-md:min-h-11 pointer-coarse:min-h-11"
            data-delete-keep-files
          >
            Remove, keep files
          </Button>
        }
        description={
              <>
                <p>
                  This removes{" "}
                  {pendingDelete && pendingDelete.length > 1
                    ? "them"
                    : "it"}{" "}
                  from your downloads.
                </p>
                {pendingDelete?.[0] ? (
                  <div className="rounded-lg border border-border bg-muted p-3 space-y-1">
                    <p className="text-sm text-foreground font-medium line-clamp-2">
                      {pendingDelete.length === 1
                        ? pendingDelete[0].name
                        : `${transferLabel(pendingDelete[0])} and ${pendingDelete.length - 1} more`}
                    </p>
                    {pendingDelete[0].savePath ? (
                      <p className="text-[12px] font-mono text-subtle-foreground break-all">
                        {displayPath(pendingDelete[0].savePath)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <p className="text-[13px] text-muted-foreground">
                  <strong className="font-medium text-destructive">
                    Delete with files
                  </strong>{" "}
                  also removes the downloaded data from your disk. This cannot
                  be undone.
                </p>
              </>
        }
      />
    </div>
  );
}

/**
 * A whole series, collapsed to one row: poster, title, the honest combined
 * state/progress/counts/size, a selection checkbox, an explicit way into its
 * seasons and episodes (Details), and an overflow for acting on every release
 * in the show at once. This is the entire on-page footprint of a series now —
 * no inline season or episode rows; those live in `SeriesDownloadDialog`.
 */
function SeriesOverviewRow({
  group,
  artwork,
  selected,
  onToggleGroupSelect,
  onOpenDetails,
  onActionMany,
  onDeleteRequest,
}: {
  group: SeriesGroup<ClientTorrent>;
  artwork: ReturnType<typeof useReleaseArtwork>;
  selected: Set<string>;
  onToggleGroupSelect: (transferIds: string[]) => void;
  onOpenDetails: (key: string, opener?: EventTarget | null) => void;
  onActionMany: (act: "pause" | "resume", transfers: ClientTorrent[]) => void;
  onDeleteRequest: (torrents: ClientTorrent[]) => void;
}) {
  const head = group.torrents[0];
  const query = artworkQueryForRelease(head.name, head.category);
  const art = artwork[query.key];
  const transferIds = group.torrents.map((t) => t.transferId);
  const checkedCount = transferIds.filter((transferId) => selected.has(transferId)).length;
  const allSelected = transferIds.length > 0 && checkedCount === transferIds.length;
  const chip = rollupChip(group);

  return (
    <div
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto] gap-2 sm:gap-3 items-start sm:items-center px-3 py-2.5 transition-colors",
        allSelected ? "bg-brand-dim" : "hover:bg-muted/60",
      )}
      data-download-group
      data-group-key={group.key}
      data-group-error={isError(group.state) || chip.failing ? "true" : undefined}
    >
      <Checkbox
        checked={allSelected ? true : checkedCount > 0 ? "indeterminate" : false}
        onCheckedChange={() => onToggleGroupSelect(transferIds)}
        aria-label={`Select all of ${group.title}`}
        className="shrink-0"
      />
      <DownloadGroupSummary group={group} titleHref={downloadTitleHref(head)} posterUrl={art?.posterUrl} />

      <div className="col-start-2 flex items-center justify-end gap-2 sm:col-start-auto lg:gap-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={(event) => onOpenDetails(group.key, event.currentTarget)}
          aria-label={`Open downloads for ${group.title}`}
          data-group-details
        >
          Details
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <IconMenuButton label={`More actions for ${group.title}`} triggerProps={{ "data-group-more": "" }}>
          {groupMenuItems({ torrents: group.torrents, onActionMany, onDeleteRequest })}
        </IconMenuButton>
      </div>
    </div>
  );
}

/**
 * A film's row. A film is one download, and grouping it would only add a
 * disclosure triangle that reveals itself, so it keeps its own identity, its
 * own poster and its own controls rather than routing through the series
 * dialog.
 */
function FilmRow({
  torrent: t,
  artwork,
  ...rest
}: Omit<DownloadTransferRowProps, "kind" | "title" | "titleHref" | "posterUrl" | "showThumb"> & {
  artwork: ReturnType<typeof useReleaseArtwork>;
}) {
  const query = artworkQueryForRelease(t.name, t.category);
  const display = releaseDisplayFacts(t, query);
  return (
    <DownloadTransferRow
      torrent={t}
      kind="torrent"
      title={display.title}
      titleHref={downloadTitleHref(t)}
      posterUrl={artwork[query.key]?.posterUrl}
      showThumb
      {...rest}
    />
  );
}

/** "Details" disclosure for connection and error facts; closed by default. */
function DetailsDisclosure({
  className,
  contentClassName,
  children,
  ...props
}: React.ComponentProps<typeof Collapsible> & { contentClassName?: string }) {
  return (
    <Collapsible className={cn("group/details", className)} {...props}>
      <CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 pointer-coarse:min-h-11">
        Details
        <ChevronDown
          aria-hidden
          className="h-3.5 w-3.5 transition-transform group-data-[state=open]/details:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className={contentClassName}>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function ClientSkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading client"
      className={cn(
        "container-app max-w-5xl py-6 sm:py-8 space-y-4 min-w-0 transition-opacity duration-150",
        !visible && "opacity-0",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <SkeletonBlock className="h-8 w-24" />
          <SkeletonBlock className="h-4 w-80 max-w-full" />
        </div>
        <div className="flex flex-wrap gap-2">
          <SkeletonBlock className="h-8 w-20" />
          <SkeletonBlock className="h-8 w-24" />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <SkeletonBlock key={i} className="h-16 w-full" />
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SkeletonBlock className="h-8 w-full max-w-sm" />
        <div className="flex gap-1">
          {Array.from({ length: 5 }, (_, i) => (
            <SkeletonBlock key={i} className="h-7 w-20" />
          ))}
        </div>
      </div>
      <div className="surface overflow-hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="grid grid-cols-1 gap-2 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-3"
          >
            <SkeletonBlock className="h-4 w-4" />
            <div className="flex gap-2.5">
              <SkeletonBlock className="h-10 w-10 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <SkeletonBlock className="h-4 w-4/5" />
                <SkeletonBlock className="h-3 w-2/3" />
                <SkeletonBlock className="h-3 w-1/2" />
              </div>
            </div>
            <SkeletonBlock className="h-8 w-24 justify-self-end" />
          </div>
        ))}
      </div>
    </PageSkeletonFrame>
  );
}
