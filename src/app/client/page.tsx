"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
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
import { TfPathChip } from "@/components/tf/path-chip";
import { TfWorkThumb } from "@/components/tf/work-thumb";
import { titleHrefForName } from "@/components/title/work-key";
import { useReleaseArtwork } from "@/hooks/use-release-artwork";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import { parseEpisode } from "@/lib/torrents/episodes";
import { parseResolution, parseSourceTier, SOURCE_TIER } from "@/lib/torrents/quality";
import { PlayOverlay } from "@/components/browse/play-overlay";
import { startVisiblePoller } from "./polling";
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
  title: string;
  chips: string[];
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

/** Work is happening but no bytes can move yet — worth saying out loud. */
function isBusy(state: string) {
  return /^(metaDL|checking|allocating)/i.test(state);
}

function isDownloading(state: string) {
  return /down|meta|stalledDL|allocat|queuedDL|checking/i.test(state);
}
function isSeeding(state: string) {
  return /up|seed|stalledUP|queuedUP/i.test(state) && !isDownloading(state);
}
function isPaused(state: string) {
  return /paused|stopped|error|missing/i.test(state);
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
  const chips = [
    parseEpisode(torrent.name).label,
    resolutionChip(torrent.name),
    sourceTierChip(torrent.name),
  ].filter((chip): chip is string => Boolean(chip));

  return { title, chips };
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
    return torrents.filter((t) => {
      const display = releaseDisplayFacts(t);
      if (
        q &&
        !t.name.toLowerCase().includes(q) &&
        !display.title.toLowerCase().includes(q) &&
        !display.chips.some((chip) => chip.toLowerCase().includes(q))
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
  }, [torrents, filter, statusFilter]);

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
    for (const t of torrents) {
      if (isDownloading(t.state)) downloading += 1;
      else if (isSeeding(t.state)) seeding += 1;
      dlspeed += t.dlspeed || 0;
      upspeed += t.upspeed || 0;
    }
    return { downloading, seeding, dlspeed, upspeed, total: torrents.length };
  }, [torrents]);

  async function action(act: "pause" | "resume", hash: string) {
    await fetch("/api/client/torrents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: act, hash }),
    });
    void load();
  }

  async function bulkAction(act: "pause" | "resume") {
    const hashes = [...selected];
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
    void load();
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

  return (
    <div className="container-app max-w-5xl py-6 sm:py-8 space-y-4 min-w-0">
      <TfPageHeader
        title="Client"
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
                  className={cn(
                    "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
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
                onClick={() =>
                  setPendingDelete(
                    torrents.filter((t) => selected.has(t.hash)),
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
              <div className="hidden sm:grid grid-cols-[auto_minmax(0,1fr)_7rem_5.5rem_5.5rem_auto] gap-3 items-center px-3 py-2 border-b border-[var(--border)] text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
                <Checkbox
                  checked={
                    filtered.length > 0 && selected.size === filtered.length
                  }
                  onCheckedChange={() => toggleSelectAll()}
                  aria-label="Select all"
                  data-select-all
                />
                <span>Name</span>
                <span>Progress</span>
                <span>↓</span>
                <span>↑</span>
                <span className="text-right pr-1">Actions</span>
              </div>

              <div className="divide-y divide-[var(--border)]">
                {filtered.map((t) => {
                  const pct = Math.min(100, Math.round(t.progress * 1000) / 10);
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
                        "group grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)_7rem_5.5rem_5.5rem_auto] gap-2 sm:gap-3 items-center px-3 py-2.5 transition-colors",
                        isSelected
                          ? "bg-[var(--accent-dim)]"
                          : "hover:bg-[var(--bg-muted)]/60",
                      )}
                      data-client-torrent
                      data-hash={t.hash}
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
                    >
                      <div className="flex items-center gap-2 sm:contents">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleSelect(t.hash, true)}
                          aria-label={`Select ${display.title}`}
                          className="shrink-0"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-start gap-2.5" title={t.name}>
                            {titleHref ? (
                              <Link
                                href={titleHref}
                                tabIndex={-1}
                                aria-hidden
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
                            )}
                            <div className="min-w-0 flex-1 space-y-1">
                              {titleHref ? (
                                <Link
                                  href={titleHref}
                                  className="block rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
                            {t.category ? (
                              <Badge variant="outline">{t.category}</Badge>
                            ) : null}
                            {display.chips.map((chip) => (
                              <Badge key={chip} variant="outline">
                                {chip}
                              </Badge>
                            ))}
                            <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                              {formatBytes(t.sizeBytes)}
                              {t.peers != null && !isBusy(t.state)
                                ? ` · ${t.peers} ${t.peers === 1 ? "peer" : "peers"}`
                                : ""}
                              {t.eta != null && t.eta > 0
                                ? ` · ETA ${formatDuration(t.eta)}`
                                : ""}
                            </span>
                            {t.savePath ? (
                              <TfPathChip
                                path={t.savePath}
                                onOpen={() => void openDownloadFolder(t)}
                              />
                            ) : null}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-1 min-w-0 sm:px-0">
                        <Progress
                          value={pct}
                          className="h-1.5"
                          indicatorClassName={barTone}
                        />
                        <div className="flex items-center justify-between gap-2 sm:justify-end">
                          <p className="text-[11px] tabular-nums text-[var(--text-tertiary)] sm:text-right">
                            {pct.toFixed(1)}%
                          </p>
                          {/* Speeds on mobile (desktop uses dedicated columns) */}
                          <p className="sm:hidden text-[11px] tabular-nums text-[var(--text-tertiary)] font-mono">
                            <span className="text-[var(--accent-text)]">
                              ↓ {formatBytes(t.dlspeed)}/s
                            </span>
                            <span className="mx-1.5 text-[var(--border-strong)]">
                              ·
                            </span>
                            <span>↑ {formatBytes(t.upspeed)}/s</span>
                          </p>
                        </div>
                      </div>

                      <p className="hidden sm:block text-[12px] tabular-nums text-[var(--text-secondary)] font-mono">
                        {formatBytes(t.dlspeed)}/s
                      </p>
                      <p className="hidden sm:block text-[12px] tabular-nums text-[var(--text-secondary)] font-mono">
                        {formatBytes(t.upspeed)}/s
                      </p>

                      <div className="flex items-center justify-end gap-0.5">
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
                            {isBuiltin ? (
                              <>
                                <DropdownMenuItem
                                  onClick={() => void copyStreamUrl(t)}
                                  data-copy-stream-url
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
                            >
                              <Pause />
                              Pause
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => void action("resume", t.hash)}
                            >
                              <Play />
                              Resume
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-[var(--danger)] focus:text-[var(--danger)]"
                              onClick={() => setPendingDelete([t])}
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
          if (!open && !deleting) setPendingDelete(null);
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
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <SkeletonBlock className="h-8 w-24" />
          <SkeletonBlock className="h-4 w-80 max-w-full" />
        </div>
        <div className="flex gap-2">
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
            className="grid grid-cols-1 gap-2 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_7rem_5.5rem_5.5rem_auto] sm:gap-3"
          >
            <SkeletonBlock className="h-4 w-4" />
            <div className="flex gap-2.5">
              <SkeletonBlock className="h-10 w-10 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <SkeletonBlock className="h-4 w-4/5" />
                <SkeletonBlock className="h-3 w-2/3" />
              </div>
            </div>
            <SkeletonBlock className="h-7 w-full" />
            <SkeletonBlock className="hidden h-4 w-full sm:block" />
            <SkeletonBlock className="hidden h-4 w-full sm:block" />
            <SkeletonBlock className="h-8 w-24 justify-self-end" />
          </div>
        ))}
      </div>
    </PageSkeletonFrame>
  );
}
