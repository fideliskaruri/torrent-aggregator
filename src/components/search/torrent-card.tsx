"use client";

import { useState } from "react";
import { useSession } from "@/components/providers/session-provider";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  Copy,
  ExternalLink,
  Check,
  Loader2,
  FolderSearch,
  MoreHorizontal,
  Magnet,
  Sparkles,
} from "lucide-react";
import type { TorrentResult } from "@/lib/torrents/types";
import { formatBytes, formatRelativeTime, cn } from "@/lib/utils";
import { useUiPreferences } from "@/components/providers/ui-preferences";
import { useDownloadPrefs } from "@/hooks/use-download-prefs";
import { isSeriesMediaType } from "@/lib/metadata/media-type";
import { TfPathChip } from "@/components/tf/path-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
interface TorrentCardProps {
  torrent: TorrentResult;
  index?: number;
  searchCategory?: string;
  /**
   * Set when the row sits under a header that already carries the show's
   * artwork, name and season. Repeating all three on twenty consecutive rows
   * turned the results page into wallpaper — the same poster twenty times
   * reads as texture, not information.
   */
  /**
   * Set when the row sits under a header that already carries the show's
   * artwork, name and season. Repeating all three on twenty consecutive rows
   * turned the results page into wallpaper — the same poster twenty times
   * reads as texture, not information. It also suppresses the "Best" badge:
   * under a rank-ordered season header, being first already says it.
   */
  grouped?: boolean;
}

export function TorrentCard({
  torrent,
  index = 0,
  searchCategory,
  grouped = false,
}: TorrentCardProps) {
  const { data: session } = useSession();
  const { density } = useUiPreferences();
  const { prefs } = useDownloadPrefs();
  const compact = density === "compact";

  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSendOpts, setShowSendOpts] = useState(false);
  /** Library aggregator: pick start season when adding a series */
  const [showAddLibrary, setShowAddLibrary] = useState(false);
  const [fromSeason, setFromSeason] = useState("1");
  const [fromEpisode, setFromEpisode] = useState("1");
  /** User overrides only — defaults come from torrent.route (server) */
  const [sendCategory, setSendCategory] = useState("");
  const [sendPath, setSendPath] = useState("");
  const [manualCategory, setManualCategory] = useState(false);

  const meta = torrent.metadata;
  const health = torrent.health ?? 0;

  // Server-computed route (source of truth)
  const route = torrent.route;
  const defaultCategory = route?.category ?? "Other";
  const defaultKind = route?.kind ?? "other";
  const defaultConfidence = route?.confidence ?? "low";
  const serverPath = route?.savePath || route?.relativePath || "";
  const absolutePath = route?.savePath || "";
  const relativePath =
    route?.relativePath ||
    (!absolutePath && serverPath ? serverPath : null) ||
    null;

  const activeCategory = manualCategory
    ? sendCategory || defaultCategory
    : defaultCategory;
  const effectivePath = sendPath.trim() || serverPath || "";
  const chipPath = sendPath.trim() || absolutePath || serverPath || "";
  const chipRelative =
    sendPath.trim() ||
    relativePath ||
    (absolutePath ? undefined : serverPath) ||
    null;

  async function copyMagnet() {
    if (!torrent.magnet) return;
    try {
      await navigator.clipboard.writeText(torrent.magnet);
      setCopied(true);
      toast.success("Magnet copied");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy magnet");
    }
  }

  async function sendToClient(target: "primary" | "external" = "primary") {
    if (!session) {
      toast.message("Sign in to send to your client");
      return;
    }
    setSending(true);
    try {
      // Commands only: pass torrent identity; server re-decides route
      // unless user explicitly overrode category/path
      const res = await fetch("/api/torrent/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          magnet: torrent.magnet,
          torrentUrl: torrent.torrentUrl,
          name: torrent.title,
          source: torrent.source,
          infoHash: torrent.infoHash,
          tags: torrent.tags,
          searchCategory: searchCategory ?? null,
          metadata: torrent.metadata ?? null,
          categoryManual: manualCategory,
          category: manualCategory ? activeCategory : null,
          savePath: sendPath.trim() || null,
          target,
        }),
      });
      const data = await res.json();
      const pathHint = data.target?.savePath
        ? ` → ${data.target.savePath}`
        : "";
      const kindHint = data.smart
        ? ` [${data.smart.kind}/${data.smart.confidence}]`
        : "";
      const via =
        data.clientType === "builtin"
          ? "built-in"
          : data.clientType === "qbittorrent"
            ? "qBittorrent"
            : data.clientType === "transmission"
              ? "Transmission"
              : data.clientType || "";
      const msg = `${data.message || (data.ok ? "Sent" : "Failed")}${via ? ` · ${via}` : ""}${kindHint}${pathHint}`;
      if (data.ok) toast.success(msg);
      else toast.error(msg);
    } catch {
      toast.error("Network error");
    } finally {
      setSending(false);
    }
  }

  const externalLabel =
    prefs.externalClientType === "transmission"
      ? "Transmission"
      : prefs.externalClientType === "qbittorrent"
        ? "qBittorrent"
        : "my client";
  const canSendExternal = Boolean(prefs.hasExternal && prefs.externalClientType);

  async function openFolder() {
    if (!session) {
      toast.message("Sign in to open folders");
      return;
    }
    if (!effectivePath) {
      toast.message("Set a base download folder in Settings");
      return;
    }
    setOpening(true);
    try {
      const res = await fetch("/api/settings/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: sendPath.trim() || serverPath || null,
          category: activeCategory || null,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(data.message || "Opened folder");
      } else {
        const p = data.path || data.pathOnly || effectivePath;
        try {
          await navigator.clipboard.writeText(p);
          toast.message(data.message || "Could not open", {
            description: "Path copied to clipboard",
          });
        } catch {
          toast.error(data.message || data.error || "Could not open");
        }
      }
    } catch {
      toast.error("Network error");
    } finally {
      setOpening(false);
    }
  }

  function openAddToLibrary() {
    if (!session || !meta) {
      toast.message(!session ? "Sign in for library" : "No metadata");
      return;
    }
    const isSeries = isSeriesMediaType(meta.mediaType);
    if (isSeries) {
      // Pre-fill from torrent episode if present
      const m = torrent.title.match(/S(\d{1,2})E(\d{1,3})/i);
      if (m) {
        setFromSeason(String(parseInt(m[1], 10)));
        setFromEpisode(String(parseInt(m[2], 10)));
      } else {
        setFromSeason("1");
        setFromEpisode("1");
      }
      setShowAddLibrary(true);
      return;
    }
    void addToWatchlist(null, null);
  }

  async function addToWatchlist(
    season: number | null,
    episode: number | null,
  ) {
    if (!session || !meta) {
      toast.message(!session ? "Sign in for library" : "No metadata");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaType: meta.mediaType,
          externalId: meta.externalId,
          title: meta.title,
          posterUrl: meta.posterUrl,
          synopsis: meta.synopsis,
          rating: meta.rating,
          ...(season != null
            ? { fromSeason: season, fromEpisode: episode ?? 1 }
            : {}),
        }),
      });
      if (res.ok) {
        setSaved(true);
        setShowAddLibrary(false);
        const hint =
          season != null
            ? ` from S${String(season).padStart(2, "0")}E${String(episode ?? 1).padStart(2, "0")}`
            : "";
        toast.success(`Added to library${hint}`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Could not save");
      }
    } catch {
      toast.error("Network error");
    } finally {
      setSaving(false);
    }
  }

  const canSend = Boolean(torrent.magnet || torrent.torrentUrl);

  return (
    <article
      className={cn(
        "torrent-row group",
        /* 8pt grid: 12–16px horizontal padding; vertical from density/globals */
        "px-3 sm:px-4",
        compact ? "py-3" : "py-4",
      )}
      data-torrent-card
      data-index={index}
      tabIndex={0}
    >
      {/*
        Layout (Material list + 8pt grid):
        [poster] [ content column — title → stats → path → actions ]
        Actions sit UNDER content (left-aligned), never flex-end across
        the full row (that created the empty mid-gap).
      */}
      <div className="flex gap-3 sm:gap-4">
        {/* Poster — dropped when a group header already shows it */}
        {grouped ? null : (
        <div
          className={cn(
            "torrent-poster relative shrink-0 self-start",
            compact ? "w-10 sm:w-11" : "w-12 sm:w-14",
          )}
        >
          {meta?.posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={meta.posterUrl}
              alt=""
              className="w-full aspect-[2/3] rounded-md object-cover bg-[var(--bg-muted)]"
            />
          ) : (
            // A bare grey box is pixel-identical to the loading skeleton, so a
            // fully-loaded list of unmatched releases reads as "still
            // searching". An initial is unmistakably a placeholder.
            <div
              className="flex w-full aspect-[2/3] items-center justify-center rounded-md bg-[var(--bg-muted)] px-0.5"
              aria-hidden
            >
              <span className="select-none text-2xl font-semibold text-[var(--text-tertiary)]">
                {(meta?.title ?? torrent.title ?? "?")
                  .trim()
                  .charAt(0)
                  .toUpperCase() || "?"}
              </span>
            </div>
          )}
          {torrent.bestPick && !grouped && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-[var(--accent)] ring-2 ring-[var(--bg)]" />
          )}
        </div>
        )}

        {/* Content column: stacked blocks with consistent 8px rhythm */}
        <div className="min-w-0 flex-1 flex flex-col gap-2">
          {/* 1. Title block */}
          <div className="min-w-0 space-y-1">
            {!compact && !grouped && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {meta?.title && (
                  <span className="text-xs font-medium text-[var(--accent-text)]">
                    {meta.title}
                    {meta.year ? (
                      <span className="font-normal text-[var(--text-tertiary)]">
                        {" "}
                        ({meta.year})
                      </span>
                    ) : null}
                  </span>
                )}
                {torrent.episode?.label && (
                  <span className="badge badge-accent">
                    {torrent.episode.label}
                  </span>
                )}
                {torrent.bestPick && !grouped && (
                  <span
                    className="badge"
                    title="Highest-ranked copy of this particular release"
                  >
                    Best
                  </span>
                )}
              </div>
            )}
            <h3
              className={cn(
                "font-medium text-[var(--text)] leading-snug break-words",
                compact
                  ? "text-[13px] line-clamp-2 sm:line-clamp-1"
                  : "text-sm line-clamp-2",
              )}
            >
              {compact && torrent.bestPick && !grouped ? (
                <span className="mr-1.5 text-[11px] font-medium text-[var(--accent-text)]">
                  Best
                </span>
              ) : null}
              {torrent.title}
            </h3>
          </div>

          {/* 2. Stats + actions on one line — the old build gave each row three
               stacked lines, so twelve rows filled two screens. Wraps to two
               lines on narrow. */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5">
            {(compact || grouped) && torrent.episode?.label && (
              <span className="badge badge-accent">{torrent.episode.label}</span>
            )}
            <span className="stat">
              <span className="stat-em text-[var(--success)]">
                {torrent.seeders}
              </span>{" "}
              seed
            </span>
            {!compact && (
              <span className="stat">{torrent.leechers} leech</span>
            )}
            <span className="stat">
              {torrent.sizeLabel || formatBytes(torrent.sizeBytes)}
            </span>
            <span className="stat">
              <span
                className={cn(
                  "stat-em",
                  health >= 70
                    ? "text-[var(--success)]"
                    : health >= 40
                      ? "text-[var(--accent-text)]"
                      : "text-[var(--danger)]",
                )}
              >
                {health}%
              </span>
            </span>
            <span className="stat uppercase tracking-wide">{torrent.source}</span>
            {!compact && torrent.publishedAt && (
              <span className="stat">
                {formatRelativeTime(torrent.publishedAt)}
              </span>
            )}
            {!compact &&
              torrent.tags.slice(0, 2).map((tag) => (
                <span key={tag} className="badge">
                  {tag}
                </span>
              ))}
            {/* Under a show header every row routes to the same place; twelve
                identical "TV" badges is a column of noise. */}
            {route && !grouped && (
              <span
                className={cn(
                  "badge",
                  defaultKind === "tv" || defaultKind === "movies"
                    ? "badge-accent"
                    : defaultKind === "anime"
                      ? "badge-success"
                      : "",
                )}
                title={`Server route: ${defaultKind} (${defaultConfidence})`}
              >
                <Sparkles className="h-3 w-3" />
                {defaultCategory}
              </span>
            )}
          </div>

          {/* 3. Actions — primary Send + overflow, right-aligned on wide */}
          <div className="torrent-actions flex shrink-0 flex-wrap items-center gap-2">
            <div className="inline-flex h-9 sm:h-8 rounded-md overflow-hidden shadow-sm">
              <button
                type="button"
                onClick={() => void sendToClient("primary")}
                disabled={sending || !canSend}
                data-action="send"
                className="btn btn-primary h-full min-h-9 sm:min-h-8 rounded-none rounded-l-md px-3 text-[13px]"
                title={
                  prefs.clientType === "builtin" || !prefs.clientType
                    ? "Download with built-in engine"
                    : `Send to ${prefs.clientType}`
                }
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                )}
                Send
              </button>
              <button
                type="button"
                onClick={() => setShowSendOpts((v) => !v)}
                className="btn btn-primary h-full min-h-9 sm:min-h-8 rounded-none rounded-r-md border-l border-[rgba(26,18,8,0.35)] px-2"
                aria-expanded={showSendOpts}
                aria-label="Advanced send options"
                title="Category & path overrides"
              >
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform",
                    showSendOpts && "rotate-180",
                  )}
                />
              </button>
            </div>

            {/* Magnet, Copy and "send to external client" all live in the
                overflow menu below. Rendering them again as three visible
                buttons put five controls on every row for one decision the
                user actually makes — and 100 buttons on a 20-row page. */}

            {/* Kept for keyboard/e2e reach without spending row width. */}
            {torrent.magnet && (
              <a
                href={torrent.magnet}
                className="sr-only"
                data-action="magnet"
                tabIndex={-1}
                aria-hidden
              >
                Magnet
              </a>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 sm:h-8 sm:w-8 text-[var(--text-tertiary)]"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                {torrent.magnet && (
                  <DropdownMenuItem asChild>
                    <a href={torrent.magnet} data-action="magnet-menu">
                      <Magnet className="opacity-60" />
                      Open magnet
                    </a>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={!torrent.magnet}
                  onSelect={() => void copyMagnet()}
                >
                  {copied ? (
                    <Check className="opacity-60" />
                  ) : (
                    <Copy className="opacity-60" />
                  )}
                  {copied ? "Copied" : "Copy magnet"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={opening || !effectivePath}
                  onSelect={() => void openFolder()}
                >
                  {opening ? (
                    <Loader2 className="opacity-60 animate-spin" />
                  ) : (
                    <FolderSearch className="opacity-60" />
                  )}
                  Open folder
                </DropdownMenuItem>
                {meta && (
                  <DropdownMenuItem
                    disabled={saving || saved}
                    onSelect={() => openAddToLibrary()}
                  >
                    {saved ? (
                      <BookmarkCheck className="opacity-60" />
                    ) : (
                      <Bookmark className="opacity-60" />
                    )}
                    {saved ? "In library" : "Add to library…"}
                  </DropdownMenuItem>
                )}
                {canSendExternal ? (
                  <DropdownMenuItem
                    disabled={sending || !canSend}
                    onSelect={() => void sendToClient("external")}
                    data-action="send-external"
                  >
                    <ArrowDownToLine className="opacity-60" />
                    Send to {externalLabel}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setShowSendOpts(true)}>
                  <Sparkles className="opacity-60" />
                  Category & path…
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a
                    href={torrent.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="opacity-60" />
                    View on {torrent.source}
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          </div>

          {/* 4. Path — redundant under a group header that names the show */}
          {!grouped && (chipPath || chipRelative) ? (
            <div className="min-w-0">
              <TfPathChip
                path={chipPath || chipRelative}
                relative={chipRelative}
                onOpen={effectivePath ? () => void openFolder() : undefined}
                className="max-w-full sm:max-w-md"
              />
            </div>
          ) : null}

          {/* 5. Advanced send — inset panel */}
          <AnimatePresence>
            {showSendOpts && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="surface-muted mt-1 space-y-3 p-3 sm:p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <p className="text-xs leading-relaxed text-[var(--text-tertiary)] min-w-0">
                      Server →{" "}
                      <span className="text-[var(--accent-text)]">
                        {defaultCategory}
                      </span>{" "}
                      <span>
                        ({defaultKind} · {defaultConfidence})
                      </span>
                      {effectivePath ? (
                        <>
                          <br className="sm:hidden" />
                          <span className="mt-1 block font-mono text-[11px] break-all text-[var(--text-secondary)] sm:mt-0 sm:inline sm:ml-1">
                            {effectivePath}
                          </span>
                        </>
                      ) : (
                        <span>
                          {" "}
                          · set base folder in Settings for full paths
                        </span>
                      )}
                    </p>
                    {manualCategory && (
                      <button
                        type="button"
                        className="shrink-0 text-xs text-[var(--accent-text)] hover:underline"
                        onClick={() => {
                          setManualCategory(false);
                          setSendCategory("");
                          setSendPath("");
                        }}
                      >
                        Use server route
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(prefs.categories.length
                      ? prefs.categories
                      : [
                          "Anime",
                          "Movies",
                          "TV",
                          "Music",
                          "Games",
                          "Software",
                          "Books",
                          "Other",
                        ]
                    ).map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => {
                          setManualCategory(true);
                          setSendCategory(c);
                        }}
                        className={cn(
                          "badge min-h-8 cursor-pointer px-2.5 transition-colors",
                          activeCategory === c && "badge-accent",
                        )}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                  <input
                    className="input-field h-10 w-full px-3 text-xs font-mono sm:h-9"
                    placeholder="Download folder override"
                    value={sendPath}
                    onChange={(e) => setSendPath(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void sendToClient("primary")}
                      disabled={sending}
                      className="btn btn-primary min-h-10 px-4 sm:min-h-9"
                    >
                      Send here
                    </button>
                    <button
                      type="button"
                      onClick={openFolder}
                      disabled={opening || !effectivePath}
                      className="btn btn-secondary min-h-10 px-4 sm:min-h-9"
                    >
                      Open folder
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {showAddLibrary && meta ? (
            <div className="surface-muted mt-2 space-y-3 p-3 border border-[var(--border)] rounded-[var(--radius)]">
              <p className="text-[13px] font-medium text-[var(--text)]">
                Add “{meta.title}” to library
              </p>
              <p className="text-[12px] text-[var(--text-tertiary)] leading-relaxed">
                Start monitoring from a season. Automation will hunt that
                episode next, then advance — not the whole catalog.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1">
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    From season
                  </span>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    className="h-9 w-20"
                    value={fromSeason}
                    onChange={(e) => setFromSeason(e.target.value)}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    Episode
                  </span>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    className="h-9 w-20"
                    value={fromEpisode}
                    onChange={(e) => setFromEpisode(e.target.value)}
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  disabled={saving}
                  onClick={() =>
                    void addToWatchlist(
                      Math.max(1, parseInt(fromSeason, 10) || 1),
                      Math.max(1, parseInt(fromEpisode, 10) || 1),
                    )
                  }
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Bookmark className="h-3.5 w-3.5" />
                  )}
                  Add & monitor
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAddLibrary(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
