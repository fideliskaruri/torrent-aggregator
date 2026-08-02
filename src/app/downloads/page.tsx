"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ChevronRight,
  FolderOpen,
  HardDriveDownload,
  MoreHorizontal,
  Pause,
  Play,
  Copy,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { formatBytes, formatDuration, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
import { titleHrefForName } from "@/components/title/work-key";
import { useReleaseArtwork } from "@/hooks/use-release-artwork";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import { parseEpisode } from "@/lib/torrents/episodes";
import { parseResolution, parseSourceTier, SOURCE_TIER } from "@/lib/torrents/quality";
import { PlayOverlay } from "@/components/browse/play-overlay";
import { progressPercent, speedLabel } from "@/components/tf/active-row-state";
import { startVisiblePoller } from "./polling";
import {
  groupDownloads,
  isDownloading,
  isPaused,
  isSeeding,
  type DownloadGroup,
  type SeasonBucket,
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
  LoadingGlyph,
  PageSkeletonFrame,
  SkeletonBlock,
} from "@/components/ui/loading";
import { useStableLoading } from "@/components/ui/use-stable-loading";

interface ClientTorrent {
  hash: string;
  name: string;
  progress: number;
  sizeBytes: number;
  dlspeed: number;
  upspeed: number;
  state: string;
  eta?: number;
  peers?: number;
  category?: string;
  savePath?: string | null;
  retentionState?: "kept" | "stream" | "prewarm" | "unknown";
}

// A stream (or prewarm) torrent is an ephemeral playback cache — the engine
// only ever holds the pieces needed to watch, and it is evicted like a cache.
// It is not a download the user chose to keep, so it must never appear in the
// downloads list or be counted in its stats. `retentionState` is annotated by
// /api/client/torrents from EngineTorrent.origin.
function isDownloadRow(t: ClientTorrent): boolean {
  return t.retentionState !== "stream" && t.retentionState !== "prewarm";
}

interface NowPlaying {
  infoHash: string;
  title: string;
}

type StreamManifestFile = {
  path: string;
  length: number;
};

type StatusFilter = "all" | "active" | "downloading" | "seeding" | "paused";
type ReleaseDisplayFacts = {
  /** The work's display title (show or film name), never a raw release string. */
  title: string;
  /** `S09E01`, `S01 pack`, … or null when the name states no episode. */
  episodeLabel: string | null;
  /**
   * The one quality tag worth showing in the row — resolution only.
   *
   * Source/scene tags (WEB-DL, HDTV) are torrent mechanics the product rule
   * hides; they are kept out of the row and surfaced only in the overflow's
   * Details, via `sourceTierChip`.
   */
  qualityChip: string | null;
};

/**
 * Both engines report qBittorrent's state vocabulary, which is precise but not
 * English. "stalledDL" in particular reads like an error when it only means
 * "connected to nobody yet", so say that instead.
 */
const STATE_LABELS: Record<string, string> = {
  metaDL: "Finding files",
  checkingDL: "Verifying",
  checkingUP: "Verifying",
  checkingResumeData: "Verifying",
  downloading: "Downloading",
  forcedDL: "Downloading",
  stalledDL: "Looking for peers",
  queuedDL: "Queued",
  allocating: "Allocating",
  uploading: "Seeding",
  forcedUP: "Seeding",
  stalledUP: "Seeding · idle",
  queuedUP: "Queued",
  seeding: "Seeding",
  paused: "Paused",
  pausedDL: "Paused",
  pausedUP: "Paused",
  stoppedDL: "Stopped",
  stoppedUP: "Stopped",
  error: "Error",
  missingFiles: "Files missing",
};

function stateLabel(state: string) {
  return STATE_LABELS[state] ?? state;
}

const CONTAINER_EXT = /\.(mkv|mp4|avi|m4v|mov|ts|webm|wmv|flv|mpg|mpeg)$/i;
const BRACKET_GROUP = /^\s*(?:\[[^\]]{2,40}\]\s*)+/;

function resolutionChip(raw: string): string | null {
  const resolution = parseResolution(raw);
  return resolution ? `${resolution}p` : null;
}

function sourceTierChip(raw: string): string | null {
  const tier = parseSourceTier(raw);
  if (tier === SOURCE_TIER.WEBDL) return "WEB-DL";
  if (tier === SOURCE_TIER.HDTV) return "HDTV";
  if (tier === SOURCE_TIER.BLURAY) return "Blu-ray";
  return null;
}

function releaseDisplayFacts(
  torrent: ClientTorrent,
  query = artworkQueryForRelease(torrent.name, torrent.category),
): ReleaseDisplayFacts {
  const fallback = torrent.name
    .replace(CONTAINER_EXT, "")
    .replace(BRACKET_GROUP, "")
    .replace(/\s+/g, " ")
    .trim();
  const title = query.title || fallback || torrent.name;
  return {
    title,
    episodeLabel: parseEpisode(torrent.name).label,
    qualityChip: resolutionChip(torrent.name),
  };
}

export default function ClientPage() {
  const [torrents, setTorrents] = useState<ClientTorrent[]>([]);
  const [clientType, setClientType] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingHash, setOpeningHash] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [mediaTab, setMediaTab] = useState<DownloadTab>(DEFAULT_DOWNLOAD_TAB);
  // Collapsed by default: one row per show is the point. Keyed by the group's
  // own identity key rather than by index, so a group keeps its open state
  // across a poll that adds or removes an unrelated download.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Seasons are open once their group is, so seeing an episode is one click and
  // not three. This holds only the seasons the user has explicitly folded away.
  const [collapsedSeasons, setCollapsedSeasons] = useState<Set<string>>(
    new Set(),
  );
  const [pendingDelete, setPendingDelete] = useState<ClientTorrent[] | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [offline, setOffline] = useState(false);
  const [clientHost, setClientHost] = useState("");
  const [hasExternal, setHasExternal] = useState(false);
  const [externalClientType, setExternalClientType] = useState<string | null>(
    null,
  );
  const [switchingBuiltin, setSwitchingBuiltin] = useState(false);
  const [playing, setPlaying] = useState<NowPlaying | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
  const showLoading = useStableLoading(loading && !torrents.length && !error);

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
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

      if (!res.ok || data.offline) {
        // Offline framing is only for external clients (qBit/Transmission down).
        // Built-in failures are engine errors — not "client unreachable".
        setOffline(!isBuiltin && Boolean(data.offline || !res.ok));
        setTorrents(data.torrents ?? []);
        setError(
          data.message ||
            data.error ||
            (isBuiltin
              ? "Built-in engine failed to respond"
              : "Torrent client is offline or unreachable"),
        );
        return;
      }
      setOffline(false);
      setError(null);
      setTorrents(data.torrents ?? []);
    } catch (err) {
      // Failure talking to our own Next API — not external client offline
      setOffline(false);
      setError(err instanceof Error ? err.message : String(err));
      setTorrents([]);
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
          "Switched to built-in. Your qBit/Transmission login is kept for optional Send to my client.",
      );
      setOffline(false);
      setError(null);
      await load();
    } catch {
      toast.error("Network error switching to built-in");
    } finally {
      setSwitchingBuiltin(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
        if (cancelled) return;
        if (data.clientType) setClientType(data.clientType);
        setHasExternal(Boolean(data.hasExternal));
        setExternalClientType(data.externalClientType ?? null);
        const type = data.clientType || "";
        if (type === "builtin") {
          setClientHost("");
        } else if (data.host) {
          setClientHost(data.host);
        } else {
          setClientHost("");
        }

        const isBuiltin = type === "builtin";

        if (!res.ok || data.offline) {
          setOffline(!isBuiltin && Boolean(data.offline || !res.ok));
          setTorrents(data.torrents ?? []);
          setError(
            data.message ||
              data.error ||
              (isBuiltin
                ? "Built-in engine failed to respond"
                : "Torrent client is offline or unreachable"),
          );
          return;
        }
        setOffline(false);
        setError(null);
        setTorrents(data.torrents ?? []);
      } catch (err) {
        if (!cancelled) {
          setOffline(false);
          setError(err instanceof Error ? err.message : String(err));
          setTorrents([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byStatus = torrents.filter((t) => {
      if (!isDownloadRow(t)) return false;
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
      if (statusFilter === "seeding") return isSeeding(t.state);
      if (statusFilter === "paused") return isPaused(t.state);
      if (statusFilter === "active")
        return isDownloading(t.state) || isSeeding(t.state);
      return true;
    });
    // Media type last, and through the shared rule: status answers "what is
    // this transfer doing", the tab answers "what kind of thing is it", and
    // they compose rather than override each other.
    return filterDownloadsByTab(byStatus, mediaTab);
  }, [torrents, filter, statusFilter, mediaTab]);

  // One row per work. Derived from `filtered` so a search or a tab narrows what
  // a group contains rather than leaving a group summarising rows the user has
  // just filtered away.
  const grouped = useMemo(() => groupDownloads(filtered), [filtered]);

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
        const targets = torrents.filter((t) => selected.has(t.hash));
        if (targets.length) setPendingDelete(targets);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (e.target instanceof HTMLInputElement) return;
        e.preventDefault();
        setSelected(new Set(filtered.map((t) => t.hash)));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, torrents, filtered]);

  const stats = useMemo(() => {
    let downloading = 0;
    let seeding = 0;
    let dlspeed = 0;
    let upspeed = 0;
    let total = 0;
    for (const t of torrents) {
      if (!isDownloadRow(t)) continue;
      total += 1;
      if (isDownloading(t.state)) downloading += 1;
      else if (isSeeding(t.state)) seeding += 1;
      dlspeed += t.dlspeed || 0;
      upspeed += t.upspeed || 0;
    }
    return { downloading, seeding, dlspeed, upspeed, total };
  }, [torrents]);

  async function action(act: "pause" | "resume", hash: string) {
    await fetch("/api/client/torrents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: act, hash }),
    });
    void load();
    setAnnouncement(act === "pause" ? "Download paused." : "Download resumed.");
  }

  async function actionMany(act: "pause" | "resume", hashes: string[]) {
    if (!hashes.length) return;
    await Promise.all(
      hashes.map((hash) =>
        fetch("/api/client/torrents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: act, hash }),
        }),
      ),
    );
    toast.success(
      act === "pause"
        ? `Paused ${hashes.length} torrent(s)`
        : `Resumed ${hashes.length} torrent(s)`,
    );
    setAnnouncement(
      `${act === "pause" ? "Paused" : "Resumed"} ${hashes.length} downloads.`,
    );
    void load();
  }

  async function bulkAction(act: "pause" | "resume") {
    await actionMany(act, [...selected]);
  }

  async function confirmDelete(deleteFiles: boolean) {
    if (!pendingDelete?.length) return;
    setDeleting(true);
    try {
      const results = await Promise.all(
        pendingDelete.map(async (t) => {
          const res = await fetch("/api/client/torrents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "delete",
              hash: t.hash,
              deleteFiles,
            }),
          });
          const text = await res.text();
          let data: { ok?: boolean; message?: string; error?: string } = {};
          try {
            data = text ? (JSON.parse(text) as typeof data) : {};
          } catch {
            return { ok: false, name: t.name, msg: "Bad response" };
          }
          return {
            ok: res.ok && data.ok !== false,
            name: t.name,
            msg: data.message || data.error,
          };
        }),
      );
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

  async function openDownloadFolder(t: ClientTorrent) {
    setOpeningHash(t.hash);
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

  async function copyStreamUrl(t: ClientTorrent) {
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

  function toggleSelect(hash: string, additive: boolean) {
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      if (prev.has(hash) && additive) next.delete(hash);
      else next.add(hash);
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
  function toggleGroupSelect(hashes: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      const all = hashes.every((hash) => next.has(hash));
      for (const hash of hashes) {
        if (all) next.delete(hash);
        else next.add(hash);
      }
      return next;
    });
  }

  function toggleExpanded(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSeason(key: string) {
    setCollapsedSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((t) => t.hash)));
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
    { id: "seeding", label: "Seeding" },
    { id: "paused", label: "Paused" },
  ];

  /**
   * The table flattened into the rows it actually draws.
   *
   * Built here rather than nested inside the JSX because the disclosure state
   * decides what exists at all: a collapsed group contributes one row, and its
   * episodes are absent from the DOM rather than merely hidden — a hidden row
   * still takes a tab stop, and tabbing through forty invisible episodes to
   * reach the next show is worse than the wall of rows this replaces.
   */
  type RenderItem =
    | { kind: "group"; group: SeriesGroup<ClientTorrent> }
    | { kind: "season"; season: SeasonBucket<ClientTorrent> }
    | { kind: "torrent"; torrent: ClientTorrent; depth: number };

  const renderItems: RenderItem[] = [];
  for (const group of grouped as DownloadGroup<ClientTorrent>[]) {
    if (group.kind === "single") {
      renderItems.push({ kind: "torrent", torrent: group.torrent, depth: 0 });
      continue;
    }
    renderItems.push({ kind: "group", group });
    if (!expandedGroups.has(group.key)) continue;
    for (const season of group.seasons) {
      // A show whose releases state no season has nothing to disclose at that
      // level, so a lone "Other" heading is skipped: it would be a row that
      // adds a word and no information.
      const heading = season.season != null || group.seasons.length > 1;
      if (heading) renderItems.push({ kind: "season", season });
      if (heading && collapsedSeasons.has(season.key)) continue;
      for (const entry of season.entries) {
        renderItems.push({
          kind: "torrent",
          torrent: entry.torrent,
          depth: heading ? 2 : 1,
        });
      }
    }
  }

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
              {offline && !isBuiltin
                ? "offline"
                : isBuiltin
                  ? "built-in"
                  : clientType || "torrent client"}
            </Badge>
            {isBuiltin && hasExternal ? (
              <span className="text-[11px] text-[var(--text-tertiary)]">
                +{" "}
                {externalClientType === "transmission"
                  ? "Transmission"
                  : "qBittorrent"}{" "}
                optional
              </span>
            ) : null}
            {!isBuiltin && clientHost ? (
              <span className="font-mono text-[11px] text-[var(--text-tertiary)]">
                {clientHost}
              </span>
            ) : null}
            <span className="text-[var(--text-tertiary)]">
              {offline && !isBuiltin
                ? "retry every 20s"
                : "live · auto-refresh 5s"}
            </span>
          </span>
        }
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/settings?tab=connection">Settings</Link>
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

      {error ? (
        <div
          className="surface p-5 space-y-3 text-sm"
          role="alert"
          data-client-offline={offline && !isBuiltin ? "true" : undefined}
          data-client-engine-error={isBuiltin || !offline ? "true" : undefined}
        >
          <div className="space-y-1">
            <p className="font-medium text-[var(--text)]">
              {isBuiltin
                ? "Built-in engine error"
                : offline
                  ? "Torrent client unreachable"
                  : "Client error"}
            </p>
            <p className="text-[var(--text-secondary)] leading-relaxed">
              {error}
            </p>
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
                Use built-in engine
              </Button>
            ) : null}
            <Button asChild size="sm" variant={!isBuiltin ? "secondary" : "default"}>
              <Link href="/settings?tab=connection">Open connection settings</Link>
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
              ? "Tips: free disk space on the download drive, check DOWNLOAD_DIR / Folders base path, and server logs. Built-in needs no qBittorrent host."
              : "Built-in is the default one-app mode and works with qBit stopped. Use built-in now (keeps your external login for optional “Send to my client”), or start the Web UI and retry."}
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
                label: "Seeding",
                value: stats.seeding,
                tone: stats.seeding ? "success" : "muted",
              },
              {
                label: "Download",
                value: `${formatBytes(stats.dlspeed)}/s`,
                tone: "accent",
                mono: true,
              },
              {
                label: "Upload",
                value: `${formatBytes(stats.upspeed)}/s`,
                mono: true,
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
                    torrents.filter((t) => selected.has(t.hash)),
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
            No `!error` guard is needed here: this whole branch is the `else`
            of the error ternary above, so an errored page never reaches the
            empty state. Verified by `npm run test:errors`, which forces
            /api/client/torrents to 500 and asserts "No torrents yet" stays
            hidden — keep that structure if this section is ever flattened.
          */}
          {!torrents.length && !loading ? (
            <TfEmptyState
              icon={HardDriveDownload}
              title="No torrents yet"
              description={
                isBuiltin
                  ? "Search for a release and send it — downloads use the built-in engine (no qBittorrent required)."
                  : "Search for a release and send it to your connected torrent client."
              }
              actionLabel="Open search"
              actionHref="/"
            />
          ) : (
            <>
            {isBuiltin &&
            torrents.length > 0 &&
            torrents.every(
              (t) => t.progress < 0.01 && /meta|stall/i.test(t.state),
            ) ? (
              <p className="text-[12px] text-[var(--text-tertiary)] px-1 mb-2">
                Torrents are in the built-in engine but show 0% / no peers yet —
                WebTorrent is looking for the swarm (trackers/DHT). Leave this
                page open a minute; if they never move, try another release with
                more seeders.
              </p>
            ) : null}
            <div className="surface overflow-hidden" data-client-table>
              {/* Header row */}
              <div className="hidden sm:grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 items-center px-3 py-2 border-b border-[var(--border)] text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
                <Checkbox
                  checked={
                    filtered.length > 0 && selected.size === filtered.length
                  }
                  onCheckedChange={() => toggleSelectAll()}
                  aria-label="Select all"
                  data-select-all
                />
                <span>Name</span>
                <span className="text-right pr-1">Actions</span>
              </div>

              <div className="divide-y divide-[var(--border)]">
                {renderItems.map((item) => {
                  if (item.kind === "group") {
                    const group = item.group;
                    const expanded = expandedGroups.has(group.key);
                    // Floored, not rounded to a decimal like an individual row:
                    // a combined 99.6% rounding to "100%" would say a whole
                    // season is ready while the last episode is still being
                    // written, which is the exact claim `progressPercent`
                    // exists to refuse.
                    const pct = progressPercent(group.progress);
                    const head = group.torrents[0];
                    const query = artworkQueryForRelease(head.name, head.category);
                    const art = artwork[query.key];
                    const hashes = group.torrents.map((t) => t.hash);
                    const allSelected =
                      hashes.length > 0 && hashes.every((h) => selected.has(h));
                    const barTone = isSeeding(group.state)
                      ? "bg-[var(--success)]"
                      : isPaused(group.state)
                        ? "bg-[var(--text-tertiary)]"
                        : "bg-[var(--primary)]";
                    const titleHref = titleHrefForName(head.name, {
                      mediaType: head.category,
                    });
                    return (
                      <div
                        key={group.key}
                        className={cn(
                          "grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)_auto] gap-2 sm:gap-3 items-center px-3 py-2.5 transition-colors",
                          allSelected
                            ? "bg-[var(--accent-dim)]"
                            : "hover:bg-[var(--bg-muted)]/60",
                        )}
                        data-download-group
                        data-group-key={group.key}
                        data-group-expanded={expanded ? "true" : "false"}
                      >
                        <div className="flex items-center gap-2 sm:contents">
                          <Checkbox
                            checked={allSelected}
                            onCheckedChange={() => toggleGroupSelect(hashes)}
                            aria-label={`Select all of ${group.title}`}
                            className="shrink-0"
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-start gap-2">
                              <button
                                type="button"
                                onClick={() => toggleExpanded(group.key)}
                                aria-expanded={expanded}
                                aria-label={`${expanded ? "Collapse" : "Expand"} ${group.title}`}
                                data-group-expand
                                className="flex shrink-0 items-center justify-center min-h-[44px] min-w-[44px] rounded-md text-[var(--text-tertiary)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] lg:min-h-0 lg:min-w-0 lg:h-6 lg:w-6"
                              >
                                <ChevronRight
                                  className={cn(
                                    "h-4 w-4 transition-transform",
                                    expanded && "rotate-90",
                                  )}
                                />
                              </button>
                              {titleHref ? (
                                <Link
                                  href={titleHref}
                                  tabIndex={-1}
                                  aria-hidden
                                  data-dense-ui
                                  className="shrink-0"
                                >
                                  <TfWorkThumb
                                    title={group.title}
                                    posterUrl={art?.posterUrl}
                                    sizePx={40}
                                  />
                                </Link>
                              ) : (
                                <TfWorkThumb
                                  title={group.title}
                                  posterUrl={art?.posterUrl}
                                  sizePx={40}
                                />
                              )}
                              <div className="min-w-0 flex-1 space-y-1">
                                {titleHref ? (
                                  <Link
                                    href={titleHref}
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
                                  {/*
                                    One plain state word, from the page's own
                                    `stateLabel` (which — unlike the download-only
                                    `active-row-state` vocabulary — knows
                                    "Seeding"). The combined percentage and, only
                                    while downloading, the live speed live beside
                                    the bar below, so nothing is said twice.
                                  */}
                                  <Badge
                                    variant={
                                      isDownloading(group.state)
                                        ? "accent"
                                        : isSeeding(group.state)
                                          ? "success"
                                          : "default"
                                    }
                                    data-group-state
                                  >
                                    {stateLabel(group.state)}
                                  </Badge>
                                  <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                                    {group.releaseCount}{" "}
                                    {group.releaseCount === 1
                                      ? "release"
                                      : "releases"}{" "}
                                    · {group.seasonCount}{" "}
                                    {group.seasonCount === 1
                                      ? "season"
                                      : "seasons"}{" "}
                                    · {formatBytes(group.sizeBytes)}
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
                                  {isDownloading(group.state) &&
                                  speedLabel(group.dlspeed) ? (
                                    <span className="shrink-0 text-[11px] tabular-nums font-mono text-[var(--accent-text)]">
                                      ↓ {speedLabel(group.dlspeed)}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-2 lg:gap-0.5">
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
                                onClick={() => void actionMany("pause", hashes)}
                                className="min-h-[44px] lg:min-h-0"
                              >
                                <Pause />
                                Pause all
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => void actionMany("resume", hashes)}
                                className="min-h-[44px] lg:min-h-0"
                              >
                                <Play />
                                Resume all
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="min-h-[44px] text-[var(--danger)] focus:text-[var(--danger)] lg:min-h-0"
                                onClick={(event) =>
                                  openDeleteDialog(
                                    [...group.torrents],
                                    event.currentTarget,
                                  )
                                }
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

                  if (item.kind === "season") {
                    const season = item.season;
                    const open = !collapsedSeasons.has(season.key);
                    const pct = progressPercent(season.progress);
                    // "Season 9", not the zero-padded "Season 09" the grouping
                    // key carries to match the folder on disk: the padding is a
                    // filesystem detail, not how a person reads a season number.
                    const seasonLabel =
                      season.season != null
                        ? `Season ${season.season}`
                        : season.label;
                    return (
                      <div
                        key={season.key}
                        className="grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)_auto] gap-2 sm:gap-3 items-center py-1 pl-6 pr-3 bg-[var(--bg-muted)]/40"
                        data-season-row
                        data-season-key={season.key}
                      >
                        <span className="hidden sm:block h-4 w-4" />
                        <div className="flex min-w-0 items-center gap-3">
                          <button
                            type="button"
                            onClick={() => toggleSeason(season.key)}
                            aria-expanded={open}
                            data-season-expand
                            className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-md text-left min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] lg:min-h-0 lg:py-1"
                          >
                            <ChevronRight
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)] transition-transform",
                                open && "rotate-90",
                              )}
                            />
                            <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                              {seasonLabel}
                            </span>
                            <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                              {season.entries.length}{" "}
                              {season.entries.length === 1
                                ? "release"
                                : "releases"}
                            </span>
                          </button>
                          <Progress
                            value={pct}
                            aria-label={`${seasonLabel} combined progress`}
                            className="h-1 flex-1 max-w-[14rem]"
                            indicatorClassName={
                              isSeeding(season.state)
                                ? "bg-[var(--success)]"
                                : isPaused(season.state)
                                  ? "bg-[var(--text-tertiary)]"
                                  : "bg-[var(--primary)]"
                            }
                          />
                          <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">
                            {pct}%
                          </span>
                        </div>
                        <span className="hidden sm:block" />
                      </div>
                    );
                  }

                  const t = item.torrent;
                  const isChild = item.depth > 0;
                  const pct = progressPercent(t.progress);
                  const isSelected = selected.has(t.hash);
                  const query = artworkQueryForRelease(t.name, t.category);
                  const display = releaseDisplayFacts(t, query);
                  const art = artwork[query.key];
                  const barTone = isSeeding(t.state)
                    ? "bg-[var(--success)]"
                    : isPaused(t.state)
                      ? "bg-[var(--text-tertiary)]"
                      : "bg-[var(--primary)]";
                  // A transfer is still a work. The row's own click toggles
                  // selection and already ignores anything inside an `<a>`, so
                  // the poster and the name can open the title page without
                  // fighting the multi-select.
                  const titleHref = titleHrefForName(t.name, {
                    mediaType: t.category,
                  });
                  return (
                    <div
                      key={t.hash}
                      className={cn(
                        "group grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)_auto] gap-2 sm:gap-3 items-center px-3 py-2.5 transition-colors",
                        // An episode inside an expanded show is stepped in and
                        // ruled, so a long list still reads as belonging to the
                        // heading above it once the group row has scrolled off.
                        item.depth === 1 && "pl-6 border-l-2 border-[var(--border)]",
                        item.depth === 2 && "pl-10 border-l-2 border-[var(--border)]",
                        isSelected
                          ? "bg-[var(--accent-dim)]"
                          : "hover:bg-[var(--bg-muted)]/60",
                      )}
                      data-client-torrent
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={`${isSelected ? "Deselect" : "Select"} ${display.title}`}
                      data-hash={t.hash}
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
                        toggleSelect(t.hash, e.ctrlKey || e.metaKey || e.shiftKey);
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleSelect(
                            t.hash,
                            e.ctrlKey || e.metaKey || e.shiftKey,
                          );
                        }
                      }}
                    >
                      <div className="flex items-center gap-2 sm:contents">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleSelect(t.hash, true)}
                          aria-label={`Select ${display.title}`}
                          className="shrink-0"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div
                            className="flex items-start gap-2.5"
                            title={t.name}
                          >
                            {/*
                              An episode row leads with its own identity, not
                              its show's. The show name and poster belong to the
                              group header above it; repeating them on every
                              child row is the "looks like a torrent client"
                              noise the product rule removes. Films (depth 0)
                              keep their poster and title — they are their own
                              work, with no header to carry it.
                            */}
                            {!isChild ? (
                              titleHref ? (
                                <Link
                                  href={titleHref}
                                  tabIndex={-1}
                                  aria-hidden
                                  data-dense-ui
                                  className="shrink-0"
                                >
                                  <TfWorkThumb
                                    title={display.title}
                                    posterUrl={art?.posterUrl}
                                    sizePx={40}
                                  />
                                </Link>
                              ) : (
                                <TfWorkThumb
                                  title={display.title}
                                  posterUrl={art?.posterUrl}
                                  sizePx={40}
                                />
                              )
                            ) : null}
                            <div className="min-w-0 flex-1 space-y-1">
                              {isChild ? (
                                <p
                                  className="text-[13px] font-medium text-[var(--text)] leading-snug tabular-nums"
                                  data-episode-lead
                                >
                                  {display.episodeLabel ?? display.title}
                                </p>
                              ) : titleHref ? (
                                <Link
                                  href={titleHref}
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
                                    isSeeding(t.state)
                                      ? "success"
                                      : isPaused(t.state)
                                        ? "default"
                                        : "accent"
                                  }
                                >
                                  {stateLabel(t.state)}
                                </Badge>
                                {/*
                                  One quality tag at most (resolution). Source
                                  tags (WEB-DL), scene/tracker chips, peer counts
                                  and the folder path are torrent mechanics — they
                                  leave the row and live in the overflow's Details.
                                */}
                                {display.qualityChip ? (
                                  <Badge variant="outline">
                                    {display.qualityChip}
                                  </Badge>
                                ) : null}
                                <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                                  {formatBytes(t.sizeBytes)}
                                  {isDownloading(t.state) &&
                                  t.eta != null &&
                                  t.eta > 0
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
                                {isDownloading(t.state) &&
                                speedLabel(t.dlspeed) ? (
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
                        {isBuiltin ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              setPlaying({ infoHash: t.hash, title: display.title })
                            }
                            aria-label={`Play ${display.title}`}
                            data-client-play
                          >
                            <Play className="h-3.5 w-3.5" />
                            Play
                          </Button>
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
                              Details is where the torrent mechanics went: the
                              raw release name, the source tag (WEB-DL), the
                              category, the live peer count and the folder path.
                              None of it belongs in the default row, but it is
                              real information a power user occasionally wants, so
                              it is one keystroke away rather than gone.
                            */}
                            <div
                              className="px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]"
                              data-torrent-details
                            >
                              <p className="font-medium text-[var(--text-secondary)]">
                                Details
                              </p>
                              {(() => {
                                const facts = [
                                  sourceTierChip(t.name),
                                  t.category,
                                  t.peers != null
                                    ? `${t.peers} ${t.peers === 1 ? "peer" : "peers"}`
                                    : null,
                                ].filter(Boolean);
                                return facts.length ? (
                                  <p className="tabular-nums">
                                    {facts.join(" · ")}
                                  </p>
                                ) : null;
                              })()}
                              {t.savePath ? (
                                <p className="break-all font-mono">
                                  {t.savePath}
                                </p>
                              ) : null}
                            </div>
                            <DropdownMenuSeparator />
                            {isBuiltin ? (
                              <>
                                <DropdownMenuItem
                                  onClick={() => void copyStreamUrl(t)}
                                  data-copy-stream-url
                                  className="min-h-[44px] lg:min-h-0"
                                >
                                  <Copy />
                                  Copy stream URL
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                              </>
                            ) : null}
                            <DropdownMenuItem
                              onClick={() => void openDownloadFolder(t)}
                              disabled={openingHash === t.hash}
                              data-open-folder
                              className="min-h-[44px] lg:min-h-0"
                            >
                              {openingHash === t.hash ? (
                                <LoadingGlyph className="h-4 w-4" />
                              ) : (
                                <FolderOpen />
                              )}
                              Open folder
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => void action("pause", t.hash)}
                              className="min-h-[44px] lg:min-h-0"
                            >
                              <Pause />
                              Pause
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => void action("resume", t.hash)}
                              className="min-h-[44px] lg:min-h-0"
                            >
                              <Play />
                              Resume
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="min-h-[44px] text-[var(--danger)] focus:text-[var(--danger)] lg:min-h-0"
                              onClick={(event) =>
                                openDeleteDialog([t], event.currentTarget)
                              }
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

      {playing ? (
        <PlayOverlay
          infoHash={playing.infoHash}
          title={playing.title}
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
                  from {clientType || "your client"}.
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
                        {pendingDelete[0].savePath}
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












