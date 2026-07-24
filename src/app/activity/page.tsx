"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Activity, Loader2, Radar } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";

interface ActivityItem {
  id: string;
  type: "grab" | "history";
  title: string;
  status: string;
  message: string | null;
  source: string | null;
  kind: string | null;
  query: string | null;
  magnet: string | null;
  savePath: string | null;
  category: string | null;
  createdAt: string;
}

function statusVariant(
  status: string,
): "success" | "danger" | "secondary" | "accent" | "default" {
  switch (status) {
    case "sent":
      return "success";
    case "failed":
      return "danger";
    case "skipped":
      return "secondary";
    case "searching":
    case "queued":
      return "accent";
    default:
      return "default";
  }
}

export default function ActivityPage() {
  const { data: session, status } = useSession();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/activity");
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
    if (status === "authenticated") void load();
    if (status === "unauthenticated") setLoading(false);
  }, [status, load]);

  if (status === "loading" || (status === "authenticated" && loading)) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading activity…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="container-app max-w-lg py-24">
        <TfEmptyState
          icon={Activity}
          title="Activity"
          description="Sign in to see automation grabs, save paths, and recent downloads."
          actionLabel="Sign in"
          actionHref="/login"
        />
      </div>
    );
  }

  return (
    <div className="container-app max-w-3xl py-6 sm:py-8 space-y-5 min-w-0">
      <TfPageHeader
        title="Activity"
        description={
          <span>
            What automation did — grabs, skips, failures, and paths. Live
            transfers live on{" "}
            <Link
              href="/client"
              className="text-[var(--accent-text)] hover:underline"
            >
              Client
            </Link>
            .
          </span>
        }
        actions={
          <Link
            href="/history"
            className="text-[12px] text-[var(--text-tertiary)] hover:text-[var(--accent-text)] transition-colors"
          >
            Download log
          </Link>
        }
      />

      {error ? (
        <div className="surface p-4 text-sm text-[var(--danger)]">{error}</div>
      ) : null}

      {!items.length ? (
        <TfEmptyState
          icon={Radar}
          title="No activity yet"
          description="Add titles in Library, turn Monitor on, then Run automation. Manual sends from Search also appear here."
          actionLabel="Open library"
          actionHref="/watchlist"
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="surface px-3.5 py-3 flex items-start gap-3"
              data-activity-type={item.type}
              data-activity-status={item.status}
            >
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm text-[var(--text)] line-clamp-2">
                  {item.title}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                  <Badge
                    variant={statusVariant(item.status)}
                    className="capitalize"
                  >
                    {item.status}
                  </Badge>
                  {item.type === "grab" ? (
                    <Badge variant="accent" className="capitalize">
                      {item.kind || "grab"}
                    </Badge>
                  ) : (
                    <Badge variant="outline">manual send</Badge>
                  )}
                  {item.source ? (
                    <span className="text-[var(--text-secondary)]">
                      {item.source}
                    </span>
                  ) : null}
                  {item.category ? (
                    <>
                      <span>·</span>
                      <span className="text-[var(--text-secondary)]">
                        {item.category}
                      </span>
                    </>
                  ) : null}
                  <span>·</span>
                  <span>{formatRelativeTime(item.createdAt)}</span>
                </div>
                {item.message ? (
                  <p className="text-[11px] text-[var(--text-tertiary)] line-clamp-2">
                    {item.message}
                  </p>
                ) : null}
                {item.savePath ? (
                  <p
                    className="text-[11px] text-[var(--text-tertiary)] font-mono truncate"
                    title={item.savePath}
                    data-save-path
                  >
                    {item.savePath}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
