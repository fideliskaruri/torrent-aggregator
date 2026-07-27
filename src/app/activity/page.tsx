"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
import { formatSaveLocation, parseHistoryFacts } from "@/lib/activity/history";

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
  context?: string | null;
  clientType?: string | null;
  sendKind?: string | null;
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

function ActivityContent() {
  const searchParams = useSearchParams();
  const sentOnly = searchParams.get("filter") === "sent";
  const { data, loading, error, refetch } = useApiQuery<ActivityItem[]>(
    "/api/activity",
    { select: (json) => (json as { items?: ActivityItem[] }).items ?? [] },
  );
  const { data: historyRows } = useApiQuery<ActivityItem[]>("/api/history", {
    select: (json) => (json as { items?: ActivityItem[] }).items ?? [],
  });
  // `data ?? []` is a fresh array on every render, which would make the memo
  // below — and therefore the artwork lookup — recompute forever.
  const items = useMemo(() => {
    const historyById = new Map<string, ActivityItem>(
      (historyRows ?? []).map((row) => [`hist-${row.id}`, row] as const),
    );
    const normalized = (data ?? []).map((item) => {
      const row = item.type === "history" ? historyById.get(item.id) : null;
      const facts = parseHistoryFacts({
        message: row?.message ?? item.message,
        context: row?.context ?? item.context,
        category: row?.category ?? item.category,
        savePath: row?.savePath ?? item.savePath,
        clientType: row?.clientType ?? item.clientType,
        sendKind: row?.sendKind ?? item.sendKind,
      });
      return {
        ...item,
        message: facts.message,
        context: facts.context,
        category: facts.category,
        savePath: facts.savePath,
        clientType: facts.clientType,
        sendKind: facts.sendKind,
      };
    });
    return sentOnly
      ? normalized.filter((item) => item.status === "sent")
      : normalized;
  }, [data, historyRows, sentOnly]);

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
            Recent sends and automation results.
          </span>
        }
        actions={
          <div className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface-2)] p-0.5 text-[12px]">
            <Link
              href="/activity"
              className={`rounded-full px-3 py-1 transition-colors ${
                !sentOnly
                  ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text)]"
              }`}
            >
              All
            </Link>
            <Link
              href="/activity?filter=sent"
              className={`rounded-full px-3 py-1 transition-colors ${
                sentOnly
                  ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text)]"
              }`}
            >
              Sent only
            </Link>
          </div>
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
          title={sentOnly ? "No sent downloads yet" : "No activity yet"}
          description={
            sentOnly
              ? "Successful manual and automation sends will appear here."
              : "Add titles in Library, turn Monitor on, then Run automation. Manual sends from Search also appear here."
          }
          actionLabel="Open library"
          actionHref="/watchlist"
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const location = formatSaveLocation(item.savePath, item.category);
            return (
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
                    {item.kind ? (
                      <Badge variant="accent" className="capitalize">
                        {item.kind}
                      </Badge>
                    ) : null}
                    {item.context ? (
                      <Badge variant="outline">{item.context}</Badge>
                    ) : null}
                    {item.source ? (
                      <span className="text-[var(--text-secondary)]">
                        {item.source}
                      </span>
                    ) : null}
                    {item.category ? (
                      <span className="text-[var(--text-secondary)]">
                        {item.category}
                      </span>
                    ) : null}
                    <span>{formatRelativeTime(item.createdAt)}</span>
                  </div>
                  {item.message ? (
                    <p className="text-[11px] text-[var(--text-tertiary)] line-clamp-2">
                      {item.message}
                    </p>
                  ) : null}
                  {location ? (
                    <p
                      className="text-[11px] text-[var(--text-tertiary)] truncate"
                      title={item.savePath ?? undefined}
                      data-save-path
                    >
                      Saved to {location}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function ActivityPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center gap-2 text-[var(--text-tertiary)]">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading activity…
        </div>
      }
    >
      <ActivityContent />
    </Suspense>
  );
}
