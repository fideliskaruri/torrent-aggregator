"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/components/providers/session-provider";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowRight,
  Loader2,
  Radar,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";

interface WatchItem {
  id: string;
  mediaType: string;
  externalId: string;
  title: string;
  posterUrl: string | null;
  synopsis: string | null;
  rating: number | null;
  status: string;
  monitored?: boolean;
  lastEpisode: string | null;
  fromSeason?: number | null;
  fromEpisode?: number | null;
  cursorSeason?: number | null;
  cursorEpisode?: number | null;
  monitorMode?: string | null;
  latestReleaseTitle: string | null;
  latestReleaseAt: string | null;
  latestReleaseMagnet: string | null;
  nextEpisodeHint: string | null;
  updatedAt: string;
}

/** Last automation run summary (client-only, not source of truth — Activity is). */
type LastAutoSummary = {
  at: string;
  sent: number;
  skipped: number;
  failed: number;
  message: string;
  offline?: boolean;
};

const LAST_AUTO_KEY = "tf:last-automation";

const STATUSES = ["watching", "planned", "completed", "dropped"] as const;

function readLastAuto(): LastAutoSummary | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(LAST_AUTO_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LastAutoSummary;
  } catch {
    return null;
  }
}

function writeLastAuto(summary: LastAutoSummary) {
  try {
    sessionStorage.setItem(LAST_AUTO_KEY, JSON.stringify(summary));
  } catch {
    /* ignore quota */
  }
}

export default function WatchlistPage() {
  const { data: session } = useSession();
  const [items, setItems] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningAuto, setRunningAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<WatchItem | null>(null);
  const [removing, setRemoving] = useState(false);
  const [lastAuto, setLastAuto] = useState<LastAutoSummary | null>(null);
  /** null = not loaded yet; 0 = no schedule. */
  const [autoIntervalMinutes, setAutoIntervalMinutes] = useState<number | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/watchlist");
      if (res.status === 401) {
        setItems([]);
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/watchlist");
        if (res.status === 401) {
          if (!cancelled) setItems([]);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || "Failed to load");
        setItems(data.items ?? []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // sessionStorage is an external store; syncing it on mount belongs in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastAuto(readLastAuto());
  }, []);

  // The page used to label every item "monitoring" while nothing ran on a
  // timer. Read the real schedule so the copy can state what actually happens.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/settings/client");
        if (!res.ok) return;
        const data = (await res.json()) as {
          settings?: { automationIntervalMinutes?: number | null } | null;
        };
        if (cancelled) return;
        setAutoIntervalMinutes(data.settings?.automationIntervalMinutes ?? 0);
      } catch {
        /* the schedule line just stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function updateStatus(id: string, newStatus: string) {
    const res = await fetch("/api/watchlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: newStatus }),
    });
    if (res.ok) {
      setItems((prev) =>
        prev.map((i) => (i.id === id ? { ...i, status: newStatus } : i)),
      );
    }
  }

  async function updateFromSeason(
    id: string,
    fromSeason: number,
    fromEpisode = 1,
  ) {
    const res = await fetch("/api/watchlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, fromSeason, fromEpisode }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.item) {
        setItems((prev) =>
          prev.map((i) => (i.id === id ? { ...i, ...data.item } : i)),
        );
        toast.success(
          `Monitoring from S${String(fromSeason).padStart(2, "0")}E${String(fromEpisode).padStart(2, "0")}`,
        );
      }
    } else {
      toast.error("Could not update start season");
    }
  }

  /**
   * Download one episode. When season/episode is the hunt cursor (Download next),
   * the server advances last/next; off-cursor rewatch does not.
   */
  async function grabOnDemand(
    item: WatchItem,
    season: number,
    episode: number,
  ) {
    setSendingId(item.id);
    try {
      const res = await fetch("/api/library/ondemand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watchListItemId: item.id,
          season,
          episode,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(
          data.message ||
            `Queued S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
        );
        if (
          data.advanced &&
          data.cursorSeason != null &&
          data.cursorEpisode != null
        ) {
          setItems((prev) =>
            prev.map((i) =>
              i.id === item.id
                ? {
                    ...i,
                    lastEpisode:
                      typeof data.lastEpisode === "string"
                        ? data.lastEpisode
                        : i.lastEpisode,
                    cursorSeason: data.cursorSeason as number,
                    cursorEpisode: data.cursorEpisode as number,
                    nextEpisodeHint:
                      typeof data.nextEpisodeHint === "string"
                        ? data.nextEpisodeHint
                        : i.nextEpisodeHint,
                  }
                : i,
            ),
          );
        }
      } else {
        toast.error(data.message || "On-demand grab failed");
      }
    } catch {
      toast.error("Network error");
    } finally {
      setSendingId(null);
    }
  }

  async function toggleMonitored(item: WatchItem) {
    const next = item.monitored === false;
    const res = await fetch("/api/watchlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, monitored: next }),
    });
    if (res.ok) {
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, monitored: next } : i)),
      );
      toast.success(next ? "Monitoring on" : "Monitoring off");
    } else {
      toast.error("Could not update monitoring");
    }
  }

  async function runAutomation() {
    setRunningAuto(true);
    try {
      const res = await fetch("/api/automation/run", { method: "POST" });
      const data = await res.json().catch(() => ({
        ok: false,
        message: "Empty response from server",
      }));
      if (res.ok && data.ok !== false) {
        const lib = data.summary?.library;
        const summary: LastAutoSummary = {
          at: new Date().toISOString(),
          sent: lib?.sent ?? 0,
          skipped: lib?.skipped ?? 0,
          failed: lib?.failed ?? 0,
          message: data.message || "Automation finished",
          offline: Boolean(data.offline),
        };
        writeLastAuto(summary);
        setLastAuto(summary);
        const detail = `${summary.sent} sent · ${summary.skipped} skipped · ${summary.failed} failed`;
        if (data.offline) {
          toast.warning(data.message || "Client offline", {
            description: detail,
          });
        } else {
          toast.success(data.message || "Automation finished", {
            description: detail,
          });
        }
        await load();
      } else if (data.offline || res.status === 503) {
        toast.warning(data.message || "Torrent client offline");
      } else {
        toast.error(data.message || data.error || "Automation failed");
      }
    } catch {
      toast.error("Network error running automation");
    } finally {
      setRunningAuto(false);
    }
  }

  async function confirmRemove() {
    if (!pendingRemove) return;
    setRemoving(true);
    try {
      const res = await fetch(
        `/api/watchlist?id=${encodeURIComponent(pendingRemove.id)}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        setItems((prev) => prev.filter((i) => i.id !== pendingRemove.id));
        toast.success("Removed from library");
      } else {
        toast.error("Could not remove item");
      }
      setPendingRemove(null);
    } catch {
      toast.error("Network error");
    } finally {
      setRemoving(false);
    }
  }

  async function sendLatest(item: WatchItem) {
    if (!item.latestReleaseMagnet) return;
    if (!session) {
      toast.error("Sign in to send to your client");
      return;
    }
    setSendingId(item.id);
    try {
      const res = await fetch("/api/torrent/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          magnet: item.latestReleaseMagnet,
          name: item.latestReleaseTitle || item.title,
          source: "watchlist",
          watchListItemId: item.id,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok !== false) {
        toast.success(data.message || "Sent to client");
      } else {
        toast.error(
          data.message || data.error || "Failed to send to client",
        );
      }
    } catch {
      toast.error("Network error");
    } finally {
      setSendingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading library…
      </div>
    );
  }


  const filtered =
    filter === "all" ? items : items.filter((i) => i.status === filter);

  const monitoredCount = items.filter((i) => i.monitored !== false).length;

  const filterChips: { id: string; label: string }[] = [
    { id: "all", label: "All" },
    ...STATUSES.map((s) => ({
      id: s,
      label: s.charAt(0).toUpperCase() + s.slice(1),
    })),
  ];

  return (
    <div className="container-app py-6 sm:py-8 space-y-5 min-w-0">
      <TfPageHeader
        title="Library"
        description={`${items.length} shows · ${monitoredCount} monitored`}
        actions={
          <Button
            type="button"
            size="sm"
            onClick={() => void runAutomation()}
            disabled={runningAuto || !items.length}
            title="Hunt next episode for each monitored show (from cursor)"
          >
            {runningAuto ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Radar className="h-3.5 w-3.5" />
            )}
            Run automation
          </Button>
        }
      />

      <p className="text-[12px] text-[var(--text-tertiary)] leading-relaxed max-w-2xl">
        Each show tracks a{" "}
        <span className="text-[var(--text-secondary)]">next episode</span>.{" "}
        <span className="text-[var(--text-secondary)]">Run automation</span> or{" "}
        <span className="text-[var(--text-secondary)]">Download next</span>{" "}
        gets that one episode and advances the cursor — not the whole series at
        once.{" "}
        {autoIntervalMinutes === null ? null : autoIntervalMinutes > 0 ? (
          <span className="text-[var(--text-secondary)]">
            The server also checks on its own every{" "}
            {autoIntervalMinutes < 60
              ? `${autoIntervalMinutes} minutes`
              : autoIntervalMinutes === 60
                ? "hour"
                : `${autoIntervalMinutes / 60} hours`}
            .
          </span>
        ) : (
          <>
            Nothing runs on a timer —{" "}
            <Link
              href="/settings"
              className="text-[var(--accent-text)] underline underline-offset-2"
            >
              turn on automatic checks
            </Link>{" "}
            to have episodes fetched while you are away.
          </>
        )}
      </p>

      {lastAuto ? (
        <div className="surface px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span className="text-[var(--text-secondary)]">
            Last automation
            {lastAuto.offline ? (
              <Badge variant="danger" className="ml-1.5 align-middle">
                offline
              </Badge>
            ) : null}
            <span className="text-[var(--text-tertiary)]">
              {" "}
              · {lastAuto.sent} sent · {lastAuto.skipped} skipped ·{" "}
              {lastAuto.failed} failed
            </span>
          </span>
          <Link
            href="/activity"
            className="inline-flex items-center gap-1 font-medium text-[var(--accent-text)] hover:underline"
          >
            View in Activity
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        {filterChips.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={filter === c.id}
            onClick={() => setFilter(c.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors capitalize ring-1",
              filter === c.id
                ? "bg-[var(--accent-dim)] text-[var(--accent-text)] ring-[var(--accent-ring)]"
                : "bg-[var(--bg-muted)] text-[var(--text-secondary)] ring-[var(--border)] hover:text-[var(--text)]",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="surface p-4 text-sm text-[var(--danger)]">{error}</div>
      ) : null}

      {!filtered.length ? (
        <TfEmptyState
          icon={Search}
          title={items.length ? "No items match this filter" : "No items yet"}
          description={
            items.length
              ? "Try another status filter."
              : "Search a show, Add to library, pick start season, then Run automation."
          }
          actionLabel={items.length ? undefined : "Search shows"}
          actionHref={items.length ? undefined : "/"}
        />
      ) : (
        // No `items-start`: grid's default stretch gives equal-height cards per
        // row, so a Movie card (no "Next up" block) no longer leaves a ragged
        // void beside a taller series card.
        <div className="grid sm:grid-cols-2 gap-3">
          {filtered.map((item) => {
            const isSeries =
              item.mediaType === "tv" || item.mediaType === "anime";
            const nextLabel =
              item.cursorSeason != null && item.cursorEpisode != null
                ? `S${String(item.cursorSeason).padStart(2, "0")}E${String(item.cursorEpisode).padStart(2, "0")}`
                : item.nextEpisodeHint
                    ?.replace(item.title, "")
                    .trim() || null;
            const searchCat =
              item.mediaType === "anime"
                ? "anime"
                : item.mediaType === "movie"
                  ? "movies"
                  : "tv";

            return (
              <article
                key={item.id}
                className="surface overflow-hidden flex flex-col sm:flex-row gap-0 min-w-0"
                data-library-card
              >
                <div
                  className={cn(
                    "w-full sm:w-[5.5rem] shrink-0 bg-[var(--bg-muted)]",
                    // A full-width grey block is a lot of nothing on a phone.
                    // Keep the narrow desktop placeholder, drop it on mobile.
                    !item.posterUrl && "hidden sm:block",
                  )}
                >
                  {item.posterUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.posterUrl}
                      alt=""
                      className="h-36 sm:h-full w-full object-cover sm:min-h-[140px]"
                    />
                  ) : (
                    <div
                      className="flex h-full sm:min-h-[140px] items-center justify-center px-1"
                      aria-label="No poster"
                      title="No poster"
                    >
                      {/* A crossed-out-image glyph reads as a *failed load*.
                          An initial reads as a deliberate placeholder — the
                          same fallback Plex/Jellyfin use. */}
                      <span
                        aria-hidden
                        className="select-none text-2xl font-semibold text-[var(--text-tertiary)]"
                      >
                        {item.title.trim().charAt(0).toUpperCase() || "?"}
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex flex-1 flex-col gap-2.5 p-3.5 min-w-0">
                  {/* Title + remove */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="font-medium text-[15px] text-[var(--text)] leading-snug line-clamp-2">
                        {item.title}
                      </h2>
                      <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)] capitalize">
                        {item.mediaType}
                        {item.monitored !== false ? " · monitoring" : " · paused"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setPendingRemove(item)}
                      aria-label="Remove from library"
                      className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--danger)]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* One clear “what happens next” block */}
                  {isSeries ? (
                    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-muted)]/50 px-3 py-2.5 space-y-1">
                      <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
                        Automation downloads{" "}
                        <strong className="text-[var(--text-secondary)] font-medium">
                          one episode at a time
                        </strong>
                        , in order — not the whole series.
                      </p>
                      <p className="text-[13px] text-[var(--text)]">
                        Next up:{" "}
                        <span className="font-semibold text-[var(--accent-text)] tabular-nums">
                          {nextLabel || "not set"}
                        </span>
                      </p>
                      {item.lastEpisode ? (
                        <p className="text-[11px] text-[var(--text-tertiary)]">
                          Last downloaded:{" "}
                          <span className="text-[var(--text-secondary)] tabular-nums">
                            {item.lastEpisode}
                          </span>
                          {item.fromSeason != null ? (
                            <span>
                              {" "}
                              · started from S
                              {String(item.fromSeason).padStart(2, "0")}
                            </span>
                          ) : null}
                        </p>
                      ) : item.fromSeason != null ? (
                        <p className="text-[11px] text-[var(--text-tertiary)]">
                          Started from season{" "}
                          {String(item.fromSeason).padStart(2, "0")}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-[12px] text-[var(--text-tertiary)]">
                      Movie — automation looks for a release of this title.
                    </p>
                  )}

                  {/* Primary actions only */}
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-0.5">
                    {isSeries && nextLabel ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={sendingId === item.id}
                        onClick={() => {
                          const s = item.cursorSeason ?? item.fromSeason ?? 1;
                          const e = item.cursorEpisode ?? 1;
                          void grabOnDemand(item, s, e);
                        }}
                        title={`Download ${nextLabel} now`}
                      >
                        {sendingId === item.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ArrowDownToLine className="h-3.5 w-3.5" />
                        )}
                        Download {nextLabel}
                      </Button>
                    ) : null}

                    <Button
                      type="button"
                      variant={item.monitored !== false ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => void toggleMonitored(item)}
                    >
                      <Radar className="h-3.5 w-3.5" />
                      {item.monitored !== false ? "On" : "Off"}
                    </Button>

                    <Button asChild variant="ghost" size="sm">
                      <Link
                        href={`/?q=${encodeURIComponent(
                          item.nextEpisodeHint || item.title,
                        )}&category=${searchCat}`}
                      >
                        <Search className="h-3.5 w-3.5" />
                        Search
                      </Link>
                    </Button>

                    {/* Secondary: season reset + space — not competing with primary */}
                    {isSeries ? (
                      <details className="w-full sm:w-auto">
                        <summary className="cursor-pointer list-none text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] px-1 py-1.5 inline-flex items-center gap-1">
                          More options
                        </summary>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2">
                          <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
                            Jump to season
                            <Input
                              type="number"
                              min={1}
                              max={99}
                              className="h-8 w-14 text-xs"
                              defaultValue={
                                item.fromSeason ?? item.cursorSeason ?? ""
                              }
                              onBlur={(e) => {
                                const n = parseInt(e.target.value, 10);
                                if (
                                  Number.isFinite(n) &&
                                  n >= 1 &&
                                  n !== item.fromSeason
                                ) {
                                  void updateFromSeason(item.id, n, 1);
                                }
                              }}
                            />
                          </label>
                          {item.latestReleaseMagnet ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 text-[11px]"
                              disabled={sendingId === item.id}
                              onClick={() => void sendLatest(item)}
                              title={item.latestReleaseTitle || "Re-send last match"}
                            >
                              <Send className="h-3.5 w-3.5" />
                              Re-send last
                            </Button>
                          ) : null}
                          <select
                            value={item.status}
                            onChange={(e) =>
                              updateStatus(item.id, e.target.value)
                            }
                            className="h-8 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-[11px] text-[var(--text)] capitalize"
                            aria-label="Status"
                          >
                            {STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </div>
                      </details>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <AlertDialog
        open={Boolean(pendingRemove)}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from library?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove
                ? `“${pendingRemove.title}” will be removed from your library. This does not affect your torrent client.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRemove();
              }}
              disabled={removing}
              className="bg-[var(--destructive)] text-white hover:bg-[#e85d66]"
            >
              {removing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
