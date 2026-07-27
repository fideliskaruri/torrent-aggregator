"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Loader2, Radar } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { TfWorkThumb } from "@/components/tf/work-thumb";
import { useApiQuery } from "@/hooks/use-api-query";
import { useReleaseArtwork } from "@/hooks/use-release-artwork";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";

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
  const { data, loading, error, refetch } = useApiQuery<ActivityItem[]>(
    "/api/activity",
    { select: (json) => (json as { items?: ActivityItem[] }).items ?? [] },
  );
  // `data ?? []` is a fresh array on every render, which would make the memo
  // below — and therefore the artwork lookup — recompute forever.
  const items = useMemo(() => data ?? [], [data]);

  // One lookup per work, not per row: the log lists a grab and a send for the
  // same episode, and a show usually appears several times over.
  const artwork = useReleaseArtwork(
    useMemo(
      () => items.map((item) => ({ name: item.title, category: item.category })),
      [items],
    ),
  );

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading activity…
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
        // Not an error banner *above* the empty state: that combination told
        // the user both "this failed" and "you have no activity, go add
        // titles" — and the second is advice we cannot stand behind, because
        // we never found out whether they have activity or not.
        <TfErrorState
          title="Could not load activity"
          message={error}
          onRetry={refetch}
        />
      ) : !items.length ? (
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
              <TfWorkThumb
                title={item.title}
                posterUrl={
                  artwork[artworkQueryForRelease(item.title, item.category).key]
                    ?.posterUrl
                }
                sizePx={38}
              />
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
