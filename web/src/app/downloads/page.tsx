import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFeatures, useDisplayPath } from "@/lib/features";
import { DownloadRecovery } from "@/components/settings/download-recovery";
import { Link } from "react-router";
import { toast } from "@/lib/toast";
import {
  Check,
  ChevronRight,
  Download,
  FolderOpen,
  FolderTree,
  HardDriveDownload,
  Magnet,
  MoreHorizontal,
  Pause,
  Play,
  Copy,
  RefreshCw,
  Search,
  Trash2,
  Zap,
  ChevronDown,
} from "lucide-react";
import { formatBytes, formatDuration, cn } from "@/lib/utils";
import { readJsonBody, sendErrorFromBody, type SendError } from "@/lib/api-json";
import { Button } from "@/components/ui/button";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfWorkThumb } from "@/components/tf/work-thumb";
import {
  encodeKeySegment,
  titleHrefForName,
  titlePath,
} from "@/components/title/work-key";
import {
  episodeTitleMap,
  type TitleExtrasPayload,
} from "@/components/title/types";
import { useReleaseArtwork } from "@/hooks/use-release-artwork";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import { parseEpisode } from "@/lib/torrents/episodes";
import { PlayOverlay } from "@/components/browse/play-overlay";
import { progressPercent, speedLabel } from "@/components/tf/active-row-state";
import { startVisiblePoller } from "./polling";
import {
  groupDownloads,
  seriesEpisodeTally,
  canStreamTransfer,
  isDownloading,
  isError,
  isPaused,
  isQueued,
  isDownloaded,
  type SeriesGroup,
} from "./grouping";
import {
  DEFAULT_DOWNLOAD_TAB,
  DOWNLOAD_TABS,
  DOWNLOAD_TAB_LABELS,
  filterDownloadsByTab,
  type DownloadTab,
} from "./media-filter";
import {
  releaseDisplayFacts,
  sourceChip,
  canDownloadNow,
  forcedStartLabel,
  isVerifiedDownload,
  pauseResumeAction,
  pauseResumeTargets,
  stateBadgeVariant,
  stateLabel,
  rollupChip,
  transferErrorMessage,
  transferLabel,
  transfersLabel,
  waitReasonLabel,
} from "./release-display";
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
import { ReleaseSwapDialog, canFindAnotherRelease } from "./release-swap-dialog";
import { isDownloadRow, type ClientTorrent, type NowPlaying, type StreamManifestFile, type TorrentRowAction } from "./types";
import {
  LoadingGlyph,
  PageSkeletonFrame,
  SkeletonBlock,
} from "@/components/ui/loading";
import { useStableLoading } from "@/components/ui/use-stable-loading";
import {
  mergeOwnedTransferSnapshots,
} from "@/lib/clients/transfer-ownership";
import type { TorrentClientType } from "@/lib/clients";

type StatusFilter = "all" | "active" | "downloading" | "ready" | "paused" | "attention";

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

async function loadDownloadEpisodeTitle(payload: {
  workKey: string;
  title: string;
  mediaType: string | null;
  year: number | null;
  season: number;
  episode: number;
}): Promise<{
  episodeTitle: string | null;
  episodeTitles: Readonly<Record<string, string>>;
} | null> {
  const search = new URLSearchParams({
    t: payload.title,
    s: String(payload.season),
  });
  if (payload.mediaType) search.set("type", payload.mediaType);
  if (payload.year) search.set("y", String(payload.year));

  try {
    const response = await fetch(
      `/api/title/${encodeKeySegment(payload.workKey)}/extras?${search.toString()}`,
      { cache: "no-store" },
    );
    if (!response.ok) {
      console.warn(
        `[downloads] Episode metadata failed with HTTP ${response.status}`,
      );
      return null;
    }
    const extras = (await response.json()) as TitleExtrasPayload;
    if (extras.season !== payload.season) return null;
    const episodeTitles = episodeTitleMap(payload.season, extras.episodes);
    return {
      episodeTitle:
        extras.episodes.find(
          (episode) => episode.episode === payload.episode,
        )?.name ?? null,
      episodeTitles,
    };
  } catch (error) {
    console.warn("[downloads] Episode metadata request failed", error);
    return null;
  }
}

/** Result of POST /api/client/torrents/tidy (LayoutTidyResult). */
type TidyResult = {
  checked: number;
  tidied: number;
  filesMoved: number;
  stillNested: number;
  skipped: number;
};

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
  const { streaming } = useFeatures();
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
  // Which series' dialog is open, by the group's own identity key — and which
  // of its seasons is showing. Both live here, not inside the dialog
  // component, because Play has to unmount the dialog entirely while
  // `PlayOverlay` is up and remount it afterward on the same series and season;
  // state owned by the dialog would not survive that round trip.
  const [openSeriesKey, setOpenSeriesKey] = useState<string | null>(null);
  const [selectedSeasonKey, setSelectedSeasonKey] = useState<string | null>(null);
  const [rawSendValue, setRawSendValue] = useState("");
  const [sendingRaw, setSendingRaw] = useState(false);
  const [rawSendError, setRawSendError] = useState<SendError | null>(null);
  const { ensureDownloadSetup } = useDownloadSetup();
  const [pendingDelete, setPendingDelete] = useState<ClientTorrent[] | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [clientHost, setClientHost] = useState("");
  const [hasExternal, setHasExternal] = useState(false);
  const [externalClientType, setExternalClientType] = useState<string | null>(
    null,
  );
  const [switchingBuiltin, setSwitchingBuiltin] = useState(false);
  const [playing, setPlaying] = useState<NowPlaying | null>(null);
  useEffect(() => {
    if (!streaming) setPlaying(null);
  }, [streaming]);
  const [announcement, setAnnouncement] = useState("");
  // The series dialog also remounts when playback ends, and nothing on the
  // page has focus then; this is the row its close still belongs to.
  const seriesDialogOpenerRef = useRef<HTMLElement | null>(null);
  const [openGroupTitle, setOpenGroupTitle] = useState("");
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
      setHasExternal(Boolean(data.hasExternal));
      setExternalClientType(data.externalClientType ?? null);
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
  useEffect(() => {
    return startVisiblePoller({
      poll: () => load({ quiet: true }),
      intervalMs: () => (offline ? 20_000 : 5_000),
      isPaused: () => Boolean(pendingDelete),
    });
  }, [offline, load, pendingDelete]);

  // Every download row this app tracks, excluding the engine's own ephemeral
  // stream/prewarm cache — the base both the main list and the series dialog
  // are built from.
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

  const stats = useMemo(() => {
    let downloading = 0;
    let ready = 0;
    let paused = 0;
    let errored = 0;
    let dlspeed = 0;
    let upspeed = 0;
    let total = 0;
    for (const t of downloadable) {
      total += 1;
      if (isDownloading(t.state)) downloading += 1;
      else if (isDownloaded(t.state)) ready += 1;
      else if (isError(t.state)) errored += 1;
      else if (isPaused(t.state)) paused += 1;
      dlspeed += t.dlspeed || 0;
      upspeed += t.upspeed || 0;
    }
    return { downloading, ready, paused, errored, dlspeed, upspeed, total };
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

  async function copyStreamUrl(t: ClientTorrent) {
    if (!streaming) return;
    try {
      const res = await fetch(`/api/stream/${encodeURIComponent(t.hash)}`);
      const body = (await res.json().catch(() => null)) as {
        files?: StreamManifestFile[];
        error?: string;
      } | null;
      if (!res.ok || !body?.files?.length) {
        throw new Error(body?.error ?? "No streamable file found");
      }
      const file = [...body.files].sort((a, b) => b.length - a.length)[0];
      const encodedPath = file.path
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
      const url = new URL(
        `/api/stream/${encodeURIComponent(t.hash)}/${encodedPath}`,
        window.location.origin,
      );
      await navigator.clipboard.writeText(url.toString());
      toast.success("Stream URL copied");
    } catch (err) {
      toast.error("Could not copy stream URL", {
        description: err instanceof Error ? err.message : undefined,
      });
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
   * A group's checkbox selects everything under it.
   *
   * All-or-nothing rather than a tri-state: the checkbox exists so the bulk
   * bar's Pause, Resume and Delete can act on a whole show at once, and a
   * half-selected show would make "Delete" ambiguous about what it is deleting.
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
    setOpenSeriesKey(null);
    setSelectedSeasonKey(null);
    const opener = seriesDialogOpenerRef.current;
    if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
  }

  function playFromDialog(payload: {
    hash: string;
    title: string;
    workKey: string | null;
    mediaType: string | null;
    year: number | null;
    season: number | null;
    episode: number | null;
  }) {
    // Deliberately does not touch `openSeriesKey`/`selectedSeasonKey`: the
    // dialog below stops rendering while `playing` is set (see the JSX), which
    // unmounts its Radix focus trap so only `PlayOverlay`'s is active, and
    // remounts on the same series and season the instant playback closes.
    setPlaying({
      infoHash: payload.hash,
      title: payload.title,
      episodeTitle: null,
      season: payload.season,
      episode: payload.episode,
    });
    if (
      payload.workKey
      && payload.season != null
      && payload.episode != null
    ) {
      const metadataRequest = {
        workKey: payload.workKey,
        title: payload.title,
        mediaType: payload.mediaType,
        year: payload.year,
        season: payload.season,
        episode: payload.episode,
      };
      void loadDownloadEpisodeTitle(metadataRequest).then((metadata) => {
        if (!metadata) return;
        setPlaying((current) =>
          current?.infoHash === payload.hash
            && current.season === payload.season
            && current.episode === payload.episode
            ? { ...current, ...metadata }
            : current
        );
      });
    }
  }

  if (loading && !torrents.length && !error) {
    return <ClientSkeleton visible={showLoading} />;
  }

  const isBuiltin = clientType === "builtin";

  const statusChips: { id: StatusFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "downloading", label: "Downloading" },
    { id: "ready", label: "Ready" },
    { id: "paused", label: "Paused" },
    ...(stats.errored > 0 || statusFilter === "attention"
      ? [{ id: "attention" as const, label: "Needs attention" }]
      : []),
  ];

  const summaryParts: { id: StatusFilter; label: string; hook: string }[] = [
    { id: "all", label: `${stats.total} ${stats.total === 1 ? "download" : "downloads"}`, hook: "total" },
    ...(stats.downloading > 0 ? [{ id: "downloading" as const, label: `${stats.downloading} downloading`, hook: "downloading" }] : []),
    ...(stats.ready > 0 ? [{ id: "ready" as const, label: `${stats.ready} ready`, hook: "ready" }] : []),
    ...(stats.paused > 0 ? [{ id: "paused" as const, label: `${stats.paused} paused`, hook: "paused" }] : []),
    ...(stats.errored > 0
      ? [{ id: "attention" as const, label: `${stats.errored} ${stats.errored === 1 ? "needs" : "need"} attention`, hook: "attention" }]
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
          clientUnavailable ? null : (
            <p
              className="flex flex-wrap items-center gap-x-3 text-[13px] tabular-nums text-muted-foreground sm:gap-x-1"
              data-downloads-summary
            >
              {summaryParts.map((part, index) => (
                <span key={part.id} className="inline-flex items-center">
                  {index > 0 ? <span aria-hidden className="hidden px-1 text-subtle-foreground sm:inline">·</span> : null}
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
                    data-stat-value={part.hook === "downloading" ? stats.downloading : undefined}
                  >
                    {part.label}
                  </Button>
                </span>
              ))}
              {liveSpeed ? (
                <span className="inline-flex items-center font-mono text-brand-foreground" data-summary-speed>
                  <span aria-hidden className="hidden px-1 font-sans text-subtle-foreground sm:inline">·</span>
                  {liveSpeed}
                </span>
              ) : null}
            </p>
          )
        }
        description={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <Badge
              variant={offline && !isBuiltin ? "danger" : "accent"}
              className="capitalize"
            >
              {offline && !isBuiltin ? "Unavailable" : "Connected"}
            </Badge>
            <span className="text-subtle-foreground">
              {offline && !isBuiltin ? "Retrying automatically" : "Updates automatically"}
            </span>
            <DetailsDisclosure
              className="text-xs text-subtle-foreground"
              contentClassName="mt-1 space-y-0.5"
              data-client-connection-details
            >
                <p>
                  {isBuiltin
                    ? "Built-in downloader"
                    : clientType || "External downloader"}
                  {isBuiltin && hasExternal
                    ? ` · ${
                        externalClientType === "transmission"
                          ? "Transmission"
                          : "qBittorrent"
                      } available`
                    : ""}
                </p>
                {!isBuiltin && clientHost ? (
                  <p className="break-all font-mono">{clientHost}</p>
                ) : null}
                <DownloadRecovery mode="paths" />
            </DetailsDisclosure>
          </span>
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

      <div className="surface space-y-3 p-4" data-raw-torrent-send>
        <div className="min-w-0 space-y-1">
          <p className="text-[13px] font-medium text-foreground">
            Add a magnet or .torrent URL
          </p>
          <p className="text-[12px] leading-relaxed text-subtle-foreground">
            Paste a magnet link or a direct .torrent URL, then add it to your downloads.
          </p>
        </div>
        <Textarea
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
      </div>

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
            <InputGroup className="h-auto max-w-sm flex-1">
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
          {!torrents.length && !loading ? (
            <div className="space-y-4">
            <TfEmptyState
              icon={HardDriveDownload}
              title="No downloads yet"
              description={
                isBuiltin
                 ? "Find a title and choose Download to start watching here."
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
                and an explicit way in (Details), or a film row with its usual
                direct Play. Neither ever grows an inline season or episode
                list here — that disclosure lives entirely in
                `SeriesDownloadDialog` now.
              */}
              <div className="divide-y divide-border">
                {grouped.map((group) => {
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
                      openingHash={openingHash}
                      artwork={artwork}
                      onToggleSelect={toggleSelect}
                      onPlay={(payload) =>
                        setPlaying({
                          infoHash: payload.hash,
                          title: payload.title,
                          season: payload.season,
                          episode: payload.episode,
                        })
                      }
                      onAction={(act, torrent) => void action(act, torrent)}
                      onOpenFolder={(torrent) => void openDownloadFolder(torrent)}
                      onCopyStreamUrl={(torrent) => void copyStreamUrl(torrent)}
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

      {openGroup && !playing ? (
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
          openingHash={openingHash}
          onPlay={playFromDialog}
          onAction={(act, torrent) => void action(act, torrent)}
          onActionMany={(act, transfers) => void actionMany(act, transfers)}
          onOpenFolder={(t) => void openDownloadFolder(t)}
          onCopyStreamUrl={(t) => void copyStreamUrl(t)}
          onCopyMagnet={(t) => void copyMagnet(t)}
          onDeleteRequest={openDeleteDialog}
        />
      ) : null}

      {swapTorrent && !playing ? (
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

      {playing ? (
        <PlayOverlay
          infoHash={playing.infoHash}
          title={playing.title}
          episodeTitle={playing.episodeTitle}
          episodeTitles={playing.episodeTitles}
          season={playing.season}
          episode={playing.episode}
          onClose={() => setPlaying(null)}
        />
      ) : null}

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogContent data-delete-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle id="delete-dialog-title">
              {pendingDelete ? `Delete ${transfersLabel(pendingDelete)}?` : "Delete download?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This removes{" "}
                  {pendingDelete && pendingDelete.length > 1
                    ? "them"
                    : "it"}{" "}
                  from{" "}
                  {pendingDelete
                    ? [...new Set(pendingDelete.map((t) => t.ownerClientLabel))].join(
                        " and ",
                      )
                    : "its client"}.
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
                    Delete + files
                  </strong>{" "}
                  permanently removes the downloaded data from disk. This cannot
                  be undone.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} data-delete-cancel>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => void confirmDelete(false)}
              data-delete-keep-files
            >
              Remove only
            </Button>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete(true);
              }}
              data-delete-with-files
            >
              {deleting ? (
                <LoadingGlyph className="h-4 w-4" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete + files
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const pct = progressPercent(group.progress);
  const head = group.torrents[0];
  const query = artworkQueryForRelease(head.name, head.category);
  const art = artwork[query.key];
  const transferIds = group.torrents.map((t) => t.transferId);
  const allSelected =
    transferIds.length > 0 &&
    transferIds.every((transferId) => selected.has(transferId));
  const chip = rollupChip(group);
  const tally = seriesEpisodeTally(group);
  const barTone = isDownloaded(group.state)
    ? "bg-success"
    : isError(group.state) || chip.failing
      ? "bg-destructive"
      : isPaused(group.state) || isQueued(group.state)
        ? "bg-subtle-foreground"
        : "bg-primary";
  const titleHref = downloadTitleHref(head);
  // Once several members failed the chip carries the count; repeating one
  // member's error text would read as if it were the whole series' story.
  const groupErrorMessage =
    group.counts.error === 1
      ? transferErrorMessage(group.torrents.find((t) => isError(t.state)) ?? { state: group.state })
      : null;
  const targets = pauseResumeTargets(group.torrents);

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
        checked={allSelected}
        onCheckedChange={() => onToggleGroupSelect(transferIds)}
        aria-label={`Select all of ${group.title}`}
        className="shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start gap-2.5">
          {titleHref ? (
            <Link to={titleHref} tabIndex={-1} aria-hidden data-dense-ui className="shrink-0">
              <TfWorkThumb title={group.title} posterUrl={art?.posterUrl} sizePx={40} />
            </Link>
          ) : (
            <TfWorkThumb title={group.title} posterUrl={art?.posterUrl} sizePx={40} />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            {titleHref ? (
              <Link
                to={titleHref}
                className="flex items-center min-h-[44px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring lg:block lg:min-h-0"
              >
                <p className="text-[13px] font-medium text-foreground line-clamp-2 leading-snug hover:text-brand-foreground">
                  {group.title}
                </p>
              </Link>
            ) : (
              <p className="text-[13px] font-medium text-foreground line-clamp-2 leading-snug">
                {group.title}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={chip.variant} data-group-state>
                {chip.label}
              </Badge>
              <span className="text-[12px] text-subtle-foreground tabular-nums">
                {group.releaseCount} {group.releaseCount === 1 ? "release" : "releases"}
                {" · "}
                {group.seasonCount} {group.seasonCount === 1 ? "season" : "seasons"}
                {group.sizeBytes > 0 ? ` · ${formatBytes(group.sizeBytes)}` : null}
              </span>
            </div>
            {tally.downloaded > 0 || tally.downloading > 0 ? (
              <p
                data-group-episodes
                className="flex flex-wrap items-center gap-x-1 text-[12px] tabular-nums text-muted-foreground"
              >
                {tally.downloaded > 0 ? (
                  <>
                    <span>
                      {tally.downloaded} {tally.downloaded === 1 ? "episode" : "episodes"} downloaded
                    </span>
                    {tally.downloading > 0 ? (
                      <span className="text-subtle-foreground">+{tally.downloading} downloading</span>
                    ) : null}
                  </>
                ) : (
                  <span>
                    {tally.downloading} {tally.downloading === 1 ? "episode" : "episodes"} downloading
                  </span>
                )}
              </p>
            ) : null}
            {groupErrorMessage ? (
              <p
                className="text-[12px] leading-snug text-destructive"
                data-group-error-message
              >
                {groupErrorMessage}
              </p>
            ) : null}
            {pct > 0 || tally.downloaded > 0 ? (
            <div className="flex items-center gap-2 pt-0.5">
              <Progress
                value={pct}
                aria-label={`${group.title} combined download progress`}
                className="h-1.5 flex-1 max-w-[18rem]"
                indicatorClassName={barTone}
              />
              <span className="shrink-0 text-[12px] tabular-nums text-subtle-foreground">
                {pct}%
              </span>
              {isDownloading(group.state) && speedLabel(group.dlspeed) ? (
                <span className="shrink-0 text-[12px] tabular-nums font-mono text-brand-foreground">
                  ↓ {speedLabel(group.dlspeed)}
                </span>
              ) : null}
            </div>
            ) : null}
          </div>
        </div>
      </div>

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`More actions for ${group.title}`}
              data-group-more
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {targets.pause.length ? (
              <DropdownMenuItem
                onClick={() => onActionMany("pause", targets.pause)}
              >
                <Pause />
                Pause all
              </DropdownMenuItem>
            ) : null}
            {targets.resume.length ? (
              <DropdownMenuItem
                onClick={() => onActionMany("resume", targets.resume)}
              >
                <Play />
                Resume all
              </DropdownMenuItem>
            ) : null}
            {targets.pause.length || targets.resume.length ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onDeleteRequest([...group.torrents])}
              data-group-delete
            >
              <Trash2 />
              Delete all…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * A film's row: unchanged from before this redesign. A film was already one
 * row with a direct Play button, and grouping it would only add a disclosure
 * triangle that reveals itself — so it keeps its own identity, its own poster
 * and its own controls rather than routing through the series dialog.
 */
function FilmRow({
  torrent: t,
  isSelected,
  openingHash,
  artwork,
  onToggleSelect,
  onPlay,
  onAction,
  onOpenFolder,
  onCopyStreamUrl,
  onCopyMagnet,
  onDeleteRequest,
}: {
  torrent: ClientTorrent;
  isSelected: boolean;
  openingHash: string | null;
  artwork: ReturnType<typeof useReleaseArtwork>;
  onToggleSelect: (hash: string, additive: boolean) => void;
  onPlay: (payload: {
    hash: string;
    title: string;
    season: number | null;
    episode: number | null;
  }) => void;
  onAction: (act: TorrentRowAction, torrent: ClientTorrent) => void;
  onOpenFolder: (t: ClientTorrent) => void;
  onCopyStreamUrl: (t: ClientTorrent) => void;
  onCopyMagnet: (t: ClientTorrent) => void;
  onDeleteRequest: (torrents: ClientTorrent[]) => void;
}) {
  const pct = progressPercent(t.progress);
  const query = artworkQueryForRelease(t.name, t.category);
  const { streaming, openFolder } = useFeatures();
  const displayPath = useDisplayPath();
  const display = releaseDisplayFacts(t, query);
  const parsedEpisode = parseEpisode(t.name);
  const art = artwork[query.key];
  const barTone = isDownloaded(t.state)
    ? "bg-success"
    : isError(t.state)
      ? "bg-destructive"
      : isPaused(t.state) || isQueued(t.state)
        ? "bg-subtle-foreground"
        : "bg-primary";
  const titleHref = downloadTitleHref(t);
  const isBuiltin = t.ownerClientType === "builtin";
  const errorMessage = transferErrorMessage(t);
  const pauseResume = pauseResumeAction(t);
  const hasLifecycleItems = canDownloadNow(t) || canFindAnotherRelease(t) || pauseResume !== null;

  return (
    <div
      className={cn(
        "group grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)_auto] gap-2 sm:gap-3 items-center px-3 py-2.5 transition-colors",
        isSelected ? "bg-brand-dim" : "hover:bg-muted/60",
      )}
      data-client-torrent
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`${isSelected ? "Deselect" : "Select"} ${display.title}`}
      data-hash={t.hash}
      data-owner-client={t.ownerClientType}
      data-retention={t.retentionState}
      data-torrent-error={isError(t.state) ? "true" : undefined}
      onClick={(e) => {
        if (
          e.target instanceof HTMLElement &&
          (e.target.closest("button") ||
            e.target.closest("select") ||
            e.target.closest('[role="checkbox"]') ||
            e.target.closest("a"))
        ) {
          return;
        }
        onToggleSelect(t.transferId, e.ctrlKey || e.metaKey || e.shiftKey);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleSelect(t.transferId, e.ctrlKey || e.metaKey || e.shiftKey);
        }
      }}
    >
      <div className="flex items-center gap-2 sm:contents">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect(t.transferId, true)}
          aria-label={`Select ${display.title}`}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start gap-2.5" title={t.name}>
            {titleHref ? (
              <Link to={titleHref} tabIndex={-1} aria-hidden data-dense-ui className="shrink-0">
                <TfWorkThumb title={display.title} posterUrl={art?.posterUrl} sizePx={40} />
              </Link>
            ) : (
              <TfWorkThumb title={display.title} posterUrl={art?.posterUrl} sizePx={40} />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              {titleHref ? (
                <Link
                  to={titleHref}
                  className="flex items-center min-h-[44px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring lg:block lg:min-h-0"
                >
                  <p className="text-[13px] font-medium text-foreground line-clamp-2 leading-snug hover:text-brand-foreground">
                    {display.title}
                  </p>
                </Link>
              ) : (
                <p className="text-[13px] font-medium text-foreground line-clamp-2 leading-snug">
                  {display.title}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={stateBadgeVariant(t.state)} data-torrent-state>
                  {stateLabel(t.state, t.queuePosition)}
                </Badge>
                {isVerifiedDownload(t) ? (
                  <Badge variant="success" title="Checked on disk" data-torrent-verified>
                    <Check className="h-3 w-3" aria-hidden />
                    Verified
                  </Badge>
                ) : null}
                {t.imported && <Badge variant="outline">Imported</Badge>}
                {forcedStartLabel(t) ? (
                  <span className="text-[12px] text-muted-foreground" data-torrent-forced>
                    {forcedStartLabel(t)}
                  </span>
                ) : waitReasonLabel(t.state, t.waitReason) ? (
                  <span
                    className="text-[12px] text-subtle-foreground"
                    data-wait-reason={t.waitReason ?? undefined}
                  >
                    {waitReasonLabel(t.state, t.waitReason)}
                  </span>
                ) : null}
                {/*
                  One quality tag at most (resolution). Source tags (WEB-DL),
                  scene/tracker chips, peer counts and the folder path are
                  torrent mechanics — they leave the row and live in the
                  overflow's Details.
                */}
                {display.qualityChip ? <Badge variant="outline">{display.qualityChip}</Badge> : null}
                {t.sizeBytes > 0 || (isDownloading(t.state) && t.eta != null && t.eta > 0) ? (
                  <span className="text-[12px] text-subtle-foreground tabular-nums">
                    {t.sizeBytes > 0 ? formatBytes(t.sizeBytes) : null}
                    {t.sizeBytes > 0 && isDownloading(t.state) && t.eta != null && t.eta > 0 ? " · " : ""}
                    {isDownloading(t.state) && t.eta != null && t.eta > 0
                      ? `ETA ${formatDuration(t.eta)}`
                      : ""}
                  </span>
                ) : null}
              </div>
              {errorMessage ? (
                <p
                  className="text-[12px] leading-snug text-destructive"
                  data-torrent-error-message
                >
                  {errorMessage}
                </p>
              ) : null}
              <div className="flex items-center gap-2 pt-0.5">
                <Progress
                  value={pct}
                  aria-label={`${display.title} download progress`}
                  className="h-1.5 flex-1 max-w-[18rem]"
                  indicatorClassName={barTone}
                />
                <span className="shrink-0 text-[12px] tabular-nums text-subtle-foreground">
                  {pct}%
                </span>
                {isDownloading(t.state) && speedLabel(t.dlspeed) ? (
                  <span className="shrink-0 text-[12px] tabular-nums font-mono text-brand-foreground">
                    ↓ {speedLabel(t.dlspeed)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 lg:gap-0.5">
        {canDownloadNow(t) && isBuiltin ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="lg:mr-1.5"
            onClick={() => onAction("force", t)}
            aria-label={`Download ${display.title} now`}
            data-torrent-force-now
          >
            <Zap className="h-3.5 w-3.5" />
            Download now
          </Button>
        ) : null}
        {isError(t.state) ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="lg:mr-1.5"
            onClick={() => onAction("resume", t)}
            aria-label={`Retry ${display.title}`}
            data-torrent-retry
            data-torrent-resume
          >
            <Download className="h-3.5 w-3.5" />
            Retry
          </Button>
        ) : isPaused(t.state) && t.progress < 1 ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="lg:mr-1.5"
            onClick={() => onAction("resume", t)}
            aria-label={`Resume ${display.title}`}
            data-torrent-resume
          >
            <Download className="h-3.5 w-3.5" />
            Resume
          </Button>
        ) : null}
        {streaming && isBuiltin ? (
          canStreamTransfer(t) ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                onPlay({
                  hash: t.hash,
                  title: display.title,
                  season: parsedEpisode.season ?? null,
                  episode: parsedEpisode.episode ?? null,
                })
              }
              aria-label={`Play ${display.title}`}
              data-client-play
            >
              <Play className="h-3.5 w-3.5" />
              Play
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled
              aria-label={`Play ${display.title}, nothing to play yet`}
              title="Nothing to play yet. Waiting for data."
              data-client-play-disabled
            >
              <Play className="h-3.5 w-3.5" />
              Play
            </Button>
          )
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="More actions"
              data-torrent-more
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/*
              Details is where the torrent mechanics went: the raw release
              name, the source tag (WEB-DL), the category, the live peer count
              and the folder path. None of it belongs in the default row, but
              it is real information a power user occasionally wants, so it is
              one keystroke away rather than gone.
            */}
            <div
              className="px-2 py-1.5 text-[12px] leading-relaxed text-subtle-foreground"
              data-torrent-details
            >
              <p className="font-medium text-muted-foreground">Details</p>
              {(() => {
                const facts = [
                  sourceChip(t.name),
                  t.ownerClientLabel,
                  t.category,
                  t.peers != null ? `${t.peers} ${t.peers === 1 ? "peer" : "peers"}` : null,
                ].filter(Boolean);
                return facts.length ? <p className="tabular-nums">{facts.join(" · ")}</p> : null;
              })()}
              {t.savePath ? <p className="break-all font-mono">{displayPath(t.savePath)}</p> : null}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onCopyMagnet(t)}
              disabled={t.imported}
              data-copy-magnet
            >
              <Magnet />
              Copy magnet link
            </DropdownMenuItem>
            {streaming && isBuiltin ? (
              <>
                <DropdownMenuItem
                  onClick={() => onCopyStreamUrl(t)}
                  data-copy-stream-url
                >
                  <Copy />
                  Copy stream URL
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onOpenFolder(t)}
              disabled={!openFolder || openingHash === t.transferId}
              data-open-folder
            >
              {openingHash === t.transferId ? <LoadingGlyph className="h-4 w-4" /> : <FolderOpen />}
              Open folder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {canDownloadNow(t) ? (
              <DropdownMenuItem
                onClick={() => onAction("force", t)}
                data-torrent-force
              >
                <Zap />
                Download now
              </DropdownMenuItem>
            ) : null}
            {canFindAnotherRelease(t) ? (
              <DropdownMenuItem
                onClick={() => onAction("swap", t)}
                data-find-release
              >
                <Search />
                Find another release
              </DropdownMenuItem>
            ) : null}
            {pauseResume === "pause" ? (
              <DropdownMenuItem
                onClick={() => onAction("pause", t)}
              >
                <Pause />
                Pause
              </DropdownMenuItem>
            ) : pauseResume === "resume" ? (
              <DropdownMenuItem
                onClick={() => onAction("resume", t)}
              >
                <Play />
                {isError(t.state) ? "Retry" : "Resume"}
              </DropdownMenuItem>
            ) : null}
            {hasLifecycleItems ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onDeleteRequest([t])}
              data-delete-torrent
            >
              <Trash2 />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
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
