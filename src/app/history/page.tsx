"use client";

/**
 * Download log — thin subset of Activity (manual + automation sends only).
 * Does not compete with Activity for “what ran”; use Activity for GrabJobs,
 * skips, failures, and save paths. Linked from Activity as “Download log”.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, History, Loader2, Trash2 } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

interface HistoryItem {
  id: string;
  title: string;
  magnet: string | null;
  source: string | null;
  status: string;
  message: string | null;
  createdAt: string;
}

export default function HistoryPage() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingClear, setPendingClear] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<HistoryItem | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/history");
        if (res.status === 401) {
          if (!cancelled) setItems([]);
          return;
        }
        const data = await res.json();
        if (!cancelled) setItems(data.items ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function confirmClearAll() {
    setBusy(true);
    try {
      await fetch("/api/history", { method: "DELETE" });
      setItems([]);
      setPendingClear(false);
      toast.success("Download log cleared");
    } catch {
      toast.error("Could not clear download log");
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    if (!pendingRemove) return;
    setBusy(true);
    try {
      await fetch(`/api/history?id=${encodeURIComponent(pendingRemove.id)}`, {
        method: "DELETE",
      });
      setItems((prev) => prev.filter((i) => i.id !== pendingRemove.id));
      setPendingRemove(null);
      toast.success("Entry removed");
    } catch {
      toast.error("Could not remove entry");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading download log…
      </div>
    );
  }


  return (
    <div className="container-app max-w-3xl py-6 sm:py-8 space-y-5 min-w-0">
      <TfPageHeader
        title="Download log"
        description={`${items.length} past sends · subset of Activity`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/activity"
              className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent-text)] hover:underline"
            >
              See automation activity
              <ArrowRight className="h-3 w-3" />
            </Link>
            {items.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPendingClear(true)}
              >
                Clear all
              </Button>
            ) : null}
          </div>
        }
      />

      <p className="text-[12px] text-[var(--text-tertiary)] leading-relaxed">
        Sent magnets only (no skips or search attempts). For grabs, failures,
        and save paths use{" "}
        <Link
          href="/activity"
          className="text-[var(--accent-text)] hover:underline"
        >
          Activity
        </Link>
        .
      </p>

      {!items.length ? (
        <TfEmptyState
          icon={History}
          title="No downloads logged"
          description="Send a magnet from Search or Run automation from Library. Full hunt log is on Activity."
          actionLabel="Open activity"
          actionHref="/activity"
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="surface px-3.5 py-3 flex items-start gap-3"
            >
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm text-[var(--text)] line-clamp-2">
                  {item.title}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                  <Badge
                    variant={
                      item.status === "sent" ? "success" : "danger"
                    }
                    className="capitalize"
                  >
                    {item.status}
                  </Badge>
                  {/* Build the trail from what actually exists — a missing
                      source used to leave an orphan separator. */}
                  {[
                    item.source ? (
                      <span
                        key="src"
                        className="text-[var(--text-secondary)]"
                      >
                        {item.source}
                      </span>
                    ) : null,
                    <span key="when">{formatRelativeTime(item.createdAt)}</span>,
                    item.message ? (
                      <span key="msg" className="line-clamp-1">
                        {item.message}
                      </span>
                    ) : null,
                  ]
                    .filter(Boolean)
                    .map((node, i, all) => (
                      // The separator trails its own part rather than leading
                      // the next one. Both keep the dot glued to a neighbour,
                      // but only this order lets a wrap leave the dot at the
                      // end of a line instead of stranding it in the left
                      // margin of the next.
                      <span
                        key={i}
                        className="inline-flex items-center gap-1.5"
                      >
                        {node}
                        {i < all.length - 1 ? (
                          <span aria-hidden className="text-[var(--border-strong)]">
                            ·
                          </span>
                        ) : null}
                      </span>
                    ))}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setPendingRemove(item)}
                aria-label="Remove"
                className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--danger)]"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={pendingClear} onOpenChange={setPendingClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear download log?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes all {items.length} log entries. It does not affect
              torrents already in your client or automation GrabJobs on Activity.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmClearAll();
              }}
              disabled={busy}
              className="bg-[var(--destructive)] text-white hover:bg-[#e85d66]"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Clear all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(pendingRemove)}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove log entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove
                ? `“${pendingRemove.title}” will be removed from the download log.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRemove();
              }}
              disabled={busy}
              className="bg-[var(--destructive)] text-white hover:bg-[#e85d66]"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
