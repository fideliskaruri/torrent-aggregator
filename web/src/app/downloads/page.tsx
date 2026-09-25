import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFeatures, useDisplayPath } from "@/lib/features";
import { DownloadRecovery } from "@/components/settings/download-recovery";
import { Link } from "react-router";
import { toast } from "@/lib/toast";
import {
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
} from "lucide-react";
import { formatBytes, formatDuration, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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
import { TfStatStrip } from "@/components/tf/stat-strip";
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
  canStreamTransfer,
  isDownloading,
  isPaused,
  isQueued,
  isDownloaded,
  leadQueuePosition,
  type SeriesGroup,
} from "./grouping";
import {
  DEFAULT_DOWNLOAD_TAB,
  DOWNLOAD_TABS,
  DOWNLOAD_TAB_LABELS,
  filterDownloadsByTab,
  type DownloadTab,
} from "./media-filter";
import { releaseDisplayFacts, sourceTierChip, stateLabel, waitReasonLabel } from "./release-display";
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

type StatusFilter = "all" | "active" | "downloading" | "ready" | "paused";

function parseRawTorrentInput(
  raw: string,
): { magnet?: string; torrentUrl?: string; name?: string } | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^magnet:\?/i.test(value)) {
    const dn = (() => {
      try {
        const url = new URL(value);
        return url.searchParams.get("dn")?.trim() || undefined;
      } catch {
        const match = /(?:^|[?&])dn=([^&]+)/i.exec(value)?.[1];
        if (!match) return undefined;
        try {
          return decodeURIComponent(match).trim() || undefined;
        } catch {
          return match.trim() || undefined;
        }
      }
    })();
    return dn ? { magnet: value, name: dn } : { magnet: value };
  }
  if (/^https?:\/\//i.test(value) && /\.torrent(?:[?#]|$)/i.test(value)) {
    const tail = value.split("/").pop() ?? "";
    const name = tail.replace(/\.torrent(?:[?#].*)?$/i, "").trim();
    return name ? { torrentUrl: value, name: decodeURIComponent(name) } : { torrentUrl: value };
  }
  return null;
}

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
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
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
    let dlspeed = 0;
    let upspeed = 0;
    let total = 0;
    for (const t of downloadable) {
      total += 1;
      if (isDownloading(t.state)) downloading += 1;
      else if (isDownloaded(t.state)) ready += 1;
      else if (isPaused(t.state)) paused += 1;
      dlspeed += t.dlspeed || 0;
      upspeed += t.upspeed || 0;
    }
    return { downloading, ready, paused, dlspeed, upspeed, total };
  }, [downloadable]);

  async function action(act: TorrentRowAction, torrent: ClientTorrent) {
    // Any read already in flight answers from before this change; drop it so
    // its older snapshot cannot land on top of the refresh below.
    invalidateInFlight();
    const res = await fetch("/api/client/torrents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: act,
        hash: torrent.hash,
        ownerClientType: torrent.ownerClientType,
      }),
    }).catch(() => null);
    void load();
    if (act === "force") {
      if (!res?.ok) {
        const data = (await res?.json().catch(() => null)) as { message?: string } | null;
        toast.error(data?.message || "Could not start this download now.");
        setAnnouncement("Could not start the download.");
        return;
      }
      setAnnouncement("Download starting now.");
      return;
    }
    setAnnouncement(act === "pause" ? "Download paused." : "Download resumed.");
  }

  async function sendRawTorrent() {
    const parsed = parseRawTorrentInput(rawSendValue);
    if (!parsed) {
      toast.error("Paste a magnet link or a direct .torrent URL.");
      return;
    }
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
      const text = await res.text();
      let data: { ok?: boolean; message?: string; error?: string } = {};
      try {
        data = text ? (JSON.parse(text) as typeof data) : {};
      } catch {
        toast.error("Bad response from torrent send");
        return;
      }
      if (res.ok && data.ok !== false) {
        toast.success(data.message || "Added to downloads");
        setRawSendValue("");
        void load();
      } else {
        toast.error(data.message || data.error || "Could not add torrent");
      }
    } catch {
      toast.error("Network error adding torrent");
    } finally {
      setSendingRaw(false);
    }
  }

  async function actionMany(
    act: "pause" | "resume",
    transfers: ClientTorrent[],
  ) {
    if (!transfers.length) return;
    invalidateInFlight();
    await Promise.all(
      transfers.map((torrent) =>
        fetch("/api/client/torrents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: act,
            hash: torrent.hash,
            ownerClientType: torrent.ownerClientType,
          }),
        }),
      ),
    );
    toast.success(
      act === "pause"
        ? `Paused ${transfers.length} torrent(s)`
        : `Resumed ${transfers.length} torrent(s)`,
    );
    setAnnouncement(
      `${act === "pause" ? "Paused" : "Resumed"} ${transfers.length} downloads.`,
    );
    void load();
  }

  async function bulkAction(act: "pause" | "resume") {
    await actionMany(
      act,
      torrents.filter((torrent) => selected.has(torrent.transferId)),
    );
  }

  async function confirmDelete(deleteFiles: boolean) {
    if (!pendingDelete?.length) return;
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
                  msg: data
                    ? data.message || data.error || `HTTP ${res.status}`
                    : "Bad response",
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
            : { ok: false, name: t.name, msg: "Bad response" },
        );
      }
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        toast.error(
          `Failed to delete ${failed.length}: ${failed[0].msg || "error"}`,
        );
      } else {
        toast.success(
          deleteFiles
            ? `Removed ${results.length} torrent(s) and files`
            : `Removed ${results.length} from client (files kept)`,
        );
      }
      setSelected(new Set());
      setPendingDelete(null);
      setAnnouncement(
        deleteFiles
          ? `Removed ${results.length} downloads and their files.`
          : `Removed ${results.length} downloads; files were kept.`,
      );
      const opener = deleteOpenerRef.current;
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
      void load();
    } catch {
      toast.error("Network error deleting torrent(s)");
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
          ? `${plural(data.stillNested, "video")} kept in a release folder — another download already has that name`
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

  function openDeleteDialog(
    torrentsToDelete: ClientTorrent[],
    opener?: EventTarget | null,
  ) {
    if (opener instanceof HTMLElement) deleteOpenerRef.current = opener;
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
  ];

  return (
    <div className="container-app max-w-5xl py-6 sm:py-8 space-y-4 min-w-0">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <TfPageHeader
        title="Downloads"
        description={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <Badge
              variant={offline && !isBuiltin ? "danger" : "accent"}
              className="capitalize"
            >
              {offline && !isBuiltin ? "Unavailable" : "Connected"}
            </Badge>
            <span className="text-[var(--text-tertiary)]">
              {offline && !isBuiltin ? "Retrying automatically" : "Updates automatically"}
            </span>
            <details
              className="text-[11px] text-[var(--text-tertiary)]"
              data-client-connection-details
            >
              <summary className="cursor-pointer font-medium text-[var(--text-secondary)]">
                Details
              </summary>
              <div className="mt-1 space-y-0.5">
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
              </div>
            </details>
          </span>
        }
        actions={
          <>
            {isBuiltin ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={tidying}
                onClick={() => void tidyFolders()}
                title="Move finished episodes out of their release folders"
                data-tidy-folders
              >
                <FolderTree className={cn("h-3.5 w-3.5", tidying && "animate-pulse")} />
                {tidying ? "Tidying…" : "Tidy folders"}
              </Button>
            ) : null}
            <Button asChild variant="ghost" size="sm">
              <Link to="/settings?tab=connection">Settings</Link>
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void load()}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
          </>
        }
      />

      <div className="surface space-y-3 p-4" data-raw-torrent-send>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="text-[13px] font-medium text-[var(--text)]">
              Add a magnet or .torrent URL
            </p>
            <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
              Paste a magnet link or a direct .torrent URL, then add it to your downloads.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => void sendRawTorrent()}
            disabled={sendingRaw || !rawSendValue.trim()}
            className="shrink-0"
            data-raw-torrent-send-button
          >
            {sendingRaw ? <LoadingGlyph className="h-3.5 w-3.5" /> : null}
            Add torrent
          </Button>
        </div>
        <textarea
          className="min-h-24 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)] focus:ring-2 focus:ring-[var(--accent)]"
          value={rawSendValue}
          onChange={(event) => setRawSendValue(event.target.value)}
          placeholder="magnet:?xt=urn:btih:… or https://example.com/release.torrent"
          aria-label="Paste a magnet link or .torrent URL"
          data-raw-torrent-send-input
        />
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
          <span className="font-medium text-[var(--text)]">
            {offline && !isBuiltin
              ? "Torrent client unavailable"
              : "Could not refresh downloads"}
          </span>
          <span className="min-w-0 flex-1 text-[var(--text-secondary)]">
            Showing the last known state. Your downloads are unchanged.
          </span>
          <details className="min-w-0 text-[var(--text-tertiary)]" data-client-error-details>
            <summary className="cursor-pointer font-medium text-[var(--text-secondary)]">
              Details
            </summary>
            <p className="mt-1 break-words font-mono text-[11px]">{error}</p>
          </details>
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
            <p className="font-medium text-[var(--text)]">
              {isBuiltin
                ? "Downloads are temporarily unavailable"
                : offline
                  ? "Torrent client unavailable"
                  : "Downloads could not load"}
            </p>
            <p className="text-[var(--text-secondary)] leading-relaxed">
              {isBuiltin
                ? "Retry now. If this keeps happening, check the download connection settings."
                : offline
                  ? "Reconnect the client, or switch to the built-in downloader."
                  : "Retry now, or check the download connection settings."}
            </p>
            <details className="text-[var(--text-tertiary)]" data-client-error-details>
              <summary className="cursor-pointer font-medium text-[var(--text-secondary)]">
                Details
              </summary>
              <p className="mt-1 break-words font-mono text-[11px]">{error}</p>
            </details>
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
          <p className="text-[12px] text-[var(--text-tertiary)]">
            {isBuiltin
              ? "Check that the saved download folder is available, then retry."
              : "Switch to the built-in downloader, or reconnect your external client and retry."}
          </p>
        </div>
      ) : (
        <>
          <TfStatStrip
            items={[
              {
                label: "Downloading",
                value: stats.downloading,
                tone: stats.downloading ? "accent" : "muted",
                statValueHook: true,
              },
              {
                label: "Ready",
                value: stats.ready,
                tone: stats.ready ? "success" : "muted",
              },
              {
                label: "Download",
                value: `${formatBytes(stats.dlspeed)}/s`,
                tone: "accent",
                mono: true,
              },
              {
                label: "Paused",
                value: stats.paused,
                tone: stats.paused ? "muted" : "muted",
              },
              {
                label: "Total",
                value: stats.total,
                tone: "muted",
              },
            ]}
          />

          {/*
            Two filters, two questions. The tab bar asks what kind of thing you
            are after and sits above; the status chips ask what a transfer is
            doing and stay beside the search box. They compose — Series +
            Downloading is a real thing to want — so neither clears the other.
            Neither reaches into the series dialog: it always shows every
            season and episode of the show it was opened for, regardless of
            what these narrow the main list down to (see `allGroups` above).
          */}
          <div
            className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] pb-1"
            role="tablist"
            aria-label="Media type"
            data-media-tabs
          >
            {DOWNLOAD_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                onClick={() => setMediaTab(tab)}
                aria-selected={mediaTab === tab}
                data-media-tab={tab}
                className={cn(
                  "inline-flex items-center justify-center min-h-[44px] rounded-md px-3 py-1 text-[12px] font-medium transition-colors lg:min-h-0 lg:py-1.5",
                  mediaTab === tab
                    ? "bg-[var(--bg-muted)] text-[var(--text)]"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                )}
              >
                {DOWNLOAD_TAB_LABELS[tab]}
              </button>
            ))}
          </div>

          {/* Toolbar */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter torrents…"
                className="pl-8 h-8 text-[13px]"
                data-client-filter
              />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {statusChips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setStatusFilter(c.id)}
                  aria-pressed={statusFilter === c.id}
                  className={cn(
                    "inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md px-2 py-1 text-[11px] font-medium transition-colors lg:min-h-0 lg:min-w-0",
                    statusFilter === c.id
                      ? "bg-[var(--bg-muted)] text-[var(--text)]"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {selected.size > 0 ? (
            <div
              className="surface flex flex-wrap items-center gap-2 px-3 py-2"
              data-bulk-bar
            >
              <span className="text-[12px] text-[var(--text-secondary)] mr-1">
                {selected.size} selected
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void bulkAction("pause")}
              >
                <Pause className="h-3.5 w-3.5" />
                Pause
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void bulkAction("resume")}
              >
                <Play className="h-3.5 w-3.5" />
                Resume
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={(event) =>
                  openDeleteDialog(
                    torrents.filter((t) => selected.has(t.transferId)),
                    event.currentTarget,
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
              <p className="text-[12px] text-[var(--text-tertiary)] px-1 mb-2">
                These downloads have not started yet. Give them a minute to find
                available copies; if they stay at 0%, try another version with
                more sources.
              </p>
            ) : null}
            <div className="surface overflow-hidden" data-client-table>
              {/* Header row */}
              <div className="hidden sm:grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 items-center px-3 py-2 border-b border-[var(--border)] text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
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
              <div className="divide-y divide-[var(--border)]">
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
                <p className="px-4 py-8 text-center text-[13px] text-[var(--text-tertiary)]">
                  No torrents match this filter.
                </p>
              ) : null}
            </div>
            </>
          )}
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
          if (!open && !deleting) {
            setPendingDelete(null);
            const opener = deleteOpenerRef.current;
            if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
          }
        }}
      >
        <AlertDialogContent data-delete-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle id="delete-dialog-title">
              Delete{" "}
              {pendingDelete && pendingDelete.length > 1
                ? `${pendingDelete.length} torrents`
                : "torrent"}
              ?
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
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-muted)] p-3 space-y-1">
                    <p className="text-sm text-[var(--text)] font-medium line-clamp-2">
                      {pendingDelete.length === 1
                        ? pendingDelete[0].name
                        : `${pendingDelete[0].name} and ${pendingDelete.length - 1} more`}
                    </p>
                    {pendingDelete[0].savePath ? (
                      <p className="text-[11px] font-mono text-[var(--text-tertiary)] break-all">
                        {displayPath(pendingDelete[0].savePath)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <p className="text-[13px] text-[var(--text-secondary)]">
                  <strong className="font-medium text-[var(--danger)]">
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
              className="bg-[var(--destructive)] text-white hover:bg-[#e85d66]"
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
  onDeleteRequest: (torrents: ClientTorrent[], opener?: EventTarget | null) => void;
}) {
  const pct = progressPercent(group.progress);
  const head = group.torrents[0];
  const query = artworkQueryForRelease(head.name, head.category);
  const art = artwork[query.key];
  const transferIds = group.torrents.map((t) => t.transferId);
  const allSelected =
    transferIds.length > 0 &&
    transferIds.every((transferId) => selected.has(transferId));
  const barTone = isDownloaded(group.state)
    ? "bg-[var(--success)]"
    : isPaused(group.state) || isQueued(group.state)
      ? "bg-[var(--text-tertiary)]"
      : "bg-[var(--primary)]";
  const titleHref = downloadTitleHref(head);

  return (
    <div
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 sm:gap-3 items-start sm:items-center px-3 py-2.5 transition-colors",
        allSelected ? "bg-[var(--accent-dim)]" : "hover:bg-[var(--bg-muted)]/60",
      )}
      data-download-group
      data-group-key={group.key}
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
                className="flex items-center min-h-[44px] rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] lg:block lg:min-h-0"
              >
                <p className="text-[13px] font-medium text-[var(--text)] line-clamp-2 leading-snug hover:text-[var(--accent-text)]">
                  {group.title}
                </p>
              </Link>
            ) : (
              <p className="text-[13px] font-medium text-[var(--text)] line-clamp-2 leading-snug">
                {group.title}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                variant={
                  isDownloading(group.state)
                    ? "accent"
                    : isDownloaded(group.state)
                      ? "success"
                      : "default"
                }
                data-group-state
              >
                {stateLabel(group.state, leadQueuePosition(group.torrents))}
              </Badge>
              <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                {group.releaseCount} {group.releaseCount === 1 ? "release" : "releases"}
                {" · "}
                {group.seasonCount} {group.seasonCount === 1 ? "season" : "seasons"}
                {" · "}
                {formatBytes(group.sizeBytes)}
              </span>
            </div>
            <div className="flex items-center gap-2 pt-0.5">
              <Progress
                value={pct}
                aria-label={`${group.title} combined download progress`}
                className="h-1.5 flex-1 max-w-[18rem]"
                indicatorClassName={barTone}
              />
              <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">
                {pct}%
              </span>
              {isDownloading(group.state) && speedLabel(group.dlspeed) ? (
                <span className="shrink-0 text-[11px] tabular-nums font-mono text-[var(--accent-text)]">
                  ↓ {speedLabel(group.dlspeed)}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 lg:gap-1">
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
            <DropdownMenuItem
              onClick={() => onActionMany("pause", group.torrents)}
              className="min-h-[44px] lg:min-h-0"
            >
              <Pause />
              Pause all
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onActionMany("resume", group.torrents)}
              className="min-h-[44px] lg:min-h-0"
            >
              <Play />
              Resume all
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="min-h-[44px] text-[var(--danger)] focus:text-[var(--danger)] lg:min-h-0"
              onClick={(event) => onDeleteRequest([...group.torrents], event.currentTarget)}
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
  onDeleteRequest: (torrents: ClientTorrent[], opener?: EventTarget | null) => void;
}) {
  const pct = progressPercent(t.progress);
  const query = artworkQueryForRelease(t.name, t.category);
  const { streaming, openFolder } = useFeatures();
  const displayPath = useDisplayPath();
  const display = releaseDisplayFacts(t, query);
  const parsedEpisode = parseEpisode(t.name);
  const art = artwork[query.key];
  const barTone = isDownloaded(t.state)
    ? "bg-[var(--success)]"
    : isPaused(t.state) || isQueued(t.state)
      ? "bg-[var(--text-tertiary)]"
      : "bg-[var(--primary)]";
  const titleHref = downloadTitleHref(t);
  const isBuiltin = t.ownerClientType === "builtin";

  return (
    <div
      className={cn(
        "group grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)_auto] gap-2 sm:gap-3 items-center px-3 py-2.5 transition-colors",
        isSelected ? "bg-[var(--accent-dim)]" : "hover:bg-[var(--bg-muted)]/60",
      )}
      data-client-torrent
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`${isSelected ? "Deselect" : "Select"} ${display.title}`}
      data-hash={t.hash}
      data-owner-client={t.ownerClientType}
      data-retention={t.retentionState}
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
                  className="flex items-center min-h-[44px] rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] lg:block lg:min-h-0"
                >
                  <p className="text-[13px] font-medium text-[var(--text)] line-clamp-2 leading-snug hover:text-[var(--accent-text)]">
                    {display.title}
                  </p>
                </Link>
              ) : (
                <p className="text-[13px] font-medium text-[var(--text)] line-clamp-2 leading-snug">
                  {display.title}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant={
                    isDownloaded(t.state)
                      ? "success"
                      : isPaused(t.state) || isQueued(t.state)
                        ? "default"
                        : "accent"
                  }
                  data-torrent-state
                >
                  {stateLabel(t.state, t.queuePosition)}
                </Badge>
                {t.imported && <Badge variant="outline">Imported</Badge>}
                {waitReasonLabel(t.state, t.waitReason) ? (
                  <span
                    className="text-[11px] text-[var(--text-tertiary)]"
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
                <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                  {formatBytes(t.sizeBytes)}
                  {isDownloading(t.state) && t.eta != null && t.eta > 0
                    ? ` · ETA ${formatDuration(t.eta)}`
                    : ""}
                </span>
              </div>
              <div className="flex items-center gap-2 pt-0.5">
                <Progress
                  value={pct}
                  aria-label={`${display.title} download progress`}
                  className="h-1.5 flex-1 max-w-[18rem]"
                  indicatorClassName={barTone}
                />
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">
                  {pct}%
                </span>
                {isDownloading(t.state) && speedLabel(t.dlspeed) ? (
                  <span className="shrink-0 text-[11px] tabular-nums font-mono text-[var(--accent-text)]">
                    ↓ {speedLabel(t.dlspeed)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 lg:gap-0.5">
        {isPaused(t.state) && t.progress < 1 ? (
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
              aria-label={`Play ${display.title} — nothing to play yet`}
              title="Nothing to play yet — waiting for data"
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
              className="px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]"
              data-torrent-details
            >
              <p className="font-medium text-[var(--text-secondary)]">Details</p>
              {(() => {
                const facts = [
                  sourceTierChip(t.name),
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
              className="min-h-[44px] lg:min-h-0"
            >
              <Magnet />
              Copy magnet link
            </DropdownMenuItem>
            {streaming && isBuiltin ? (
              <>
                <DropdownMenuItem
                  onClick={() => onCopyStreamUrl(t)}
                  data-copy-stream-url
                  className="min-h-[44px] lg:min-h-0"
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
              className="min-h-[44px] lg:min-h-0"
            >
              {openingHash === t.transferId ? <LoadingGlyph className="h-4 w-4" /> : <FolderOpen />}
              Open folder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {isQueued(t.state) ? (
              <DropdownMenuItem
                onClick={() => onAction("force", t)}
                className="min-h-[44px] lg:min-h-0"
                data-torrent-force
              >
                <Zap />
                Download now
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() => onAction("pause", t)}
              className="min-h-[44px] lg:min-h-0"
            >
              <Pause />
              Pause
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onAction("resume", t)}
              className="min-h-[44px] lg:min-h-0"
            >
              <Play />
              Resume
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="min-h-[44px] text-[var(--danger)] focus:text-[var(--danger)] lg:min-h-0"
              onClick={(event) => onDeleteRequest([t], event.currentTarget)}
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
