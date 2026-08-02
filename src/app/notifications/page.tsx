"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Radar } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatSaveLocation, parseHistoryFacts } from "@/lib/activity/history";
import { PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";
import { useStableLoading } from "@/components/ui/use-stable-loading";
import {
  ACTIVITY_BATCH_SIZE,
  activityKindLabel,
  boundedActivityItems,
  groupActivityByDay,
} from "./presentation";

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

function ActivityContent({ sentOnly: sentOnlyOverride }: { sentOnly?: boolean }) {
  const searchParams = useSearchParams();
  const sentOnly =
    sentOnlyOverride ?? searchParams.get("filter") === "sent";
  const [visibleLimit, setVisibleLimit] = useState(ACTIVITY_BATCH_SIZE);
  const activityUrl = sentOnly
    ? "/api/activity?filter=sent"
    : "/api/activity";
  const { data, loading, error, refetch } = useApiQuery<ActivityItem[]>(
    activityUrl,
    { select: (json) => (json as { items?: ActivityItem[] }).items ?? [] },
  );
  const showLoading = useStableLoading(loading && data == null && !error);
  // `data ?? []` is a fresh array on every render, which would make the memo
  // below — and therefore the artwork lookup — recompute forever.
  const items = useMemo(() => {
    const normalized = (data ?? []).map((item) => {
      const facts = parseHistoryFacts({
        message: item.message,
        context: item.context,
        category: item.category,
        savePath: item.savePath,
        clientType: item.clientType,
        sendKind: item.sendKind,
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
  }, [data, sentOnly]);

  const visibleItems = boundedActivityItems(items, visibleLimit);
  const dayGroups = groupActivityByDay(visibleItems);
  const hasOlder = visibleItems.length < items.length;

  const title = sentOnly ? "Download log" : "Activity";
  const description = sentOnly
    ? "Releases successfully sent to a download client."
    : "Recent sends and automation outcomes.";

  const filterControls = (
    <div
      className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface-2)] p-0.5 text-[12px]"
      aria-label="Activity view"
    >
      <Link
        href="/notifications"
        aria-current={!sentOnly ? "page" : undefined}
        className={`inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-full px-3 py-1 transition-colors lg:min-h-0 lg:min-w-0 ${
          !sentOnly
            ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
            : "text-[var(--text-tertiary)] hover:text-[var(--text)]"
        }`}
      >
        All activity
      </Link>
      <Link
        href="/history"
        aria-current={sentOnly ? "page" : undefined}
        className={`inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-full px-3 py-1 transition-colors lg:min-h-0 lg:min-w-0 ${
          sentOnly
            ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
            : "text-[var(--text-tertiary)] hover:text-[var(--text)]"
        }`}
      >
        Download log
      </Link>
    </div>
  );

  if (loading && data == null && !error) return <ActivitySkeleton visible={showLoading} />;

  return (
    <div className="container-app max-w-3xl py-6 sm:py-8 space-y-5 min-w-0">
      <TfPageHeader
        title={title}
        description={description}
        actions={filterControls}
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
        <div className="space-y-4" data-activity-groups>
          {dayGroups.map((group) => (
            <section key={group.key} aria-labelledby={`activity-day-${group.key}`}>
              <h2
                id={`activity-day-${group.key}`}
                className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]"
              >
                {group.label}
              </h2>
              <ul className="surface divide-y divide-[var(--border)] overflow-hidden">
                {group.items.map((item) => {
                  const location = formatSaveLocation(item.savePath, item.category);
                  const kindLabel = activityKindLabel(item);
                  return (
                    <li
                      key={item.id}
                      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                      data-activity-type={item.type}
                      data-activity-status={item.status}
                    >
                      <Badge
                        variant={statusVariant(item.status)}
                        className="mt-0.5 capitalize"
                      >
                        {item.status}
                      </Badge>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-[var(--text)]">
                          {item.title}
                        </p>
                        <p className="truncate text-[11px] text-[var(--text-tertiary)]">
                          {[kindLabel, item.source, item.category]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        {item.message ? (
                          <p className="truncate text-[11px] text-[var(--text-secondary)]">
                            {item.message}
                          </p>
                        ) : null}
                        {location ? (
                          <p
                            className="truncate font-mono text-[11px] text-[var(--text-tertiary)]"
                            title={item.savePath ?? undefined}
                            data-save-path
                          >
                            Saved to {location}
                          </p>
                        ) : null}
                      </div>
                      <time
                        dateTime={item.createdAt}
                        className="col-start-2 whitespace-nowrap text-[11px] text-[var(--text-tertiary)] sm:col-start-3 sm:row-start-1"
                      >
                        {formatRelativeTime(item.createdAt)}
                      </time>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {hasOlder ? (
            <button
              type="button"
              className="btn btn-secondary btn-md"
              onClick={() =>
                setVisibleLimit((limit) => limit + ACTIVITY_BATCH_SIZE)
              }
            >
              Show older activity
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function NotificationsView({ sentOnly }: { sentOnly?: boolean }) {
  return (
    <Suspense fallback={<ActivitySkeleton />}>
      <ActivityContent sentOnly={sentOnly} />
    </Suspense>
  );
}

export default function NotificationsPage() {
  return <NotificationsView />;
}

function ActivitySkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading activity"
      className={cn(
        "container-app max-w-3xl py-6 sm:py-8 space-y-5 min-w-0 transition-opacity duration-150",
        !visible && "opacity-0",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <SkeletonBlock className="h-8 w-32" />
          <SkeletonBlock className="h-4 w-64 max-w-full" />
        </div>
        <SkeletonBlock className="h-8 w-28 rounded-full" />
      </div>
      <ul className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="surface flex items-start gap-3 px-3.5 py-3">
            <SkeletonBlock className="h-[38px] w-[38px] shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <SkeletonBlock className="h-4 w-4/5" />
              <SkeletonBlock className="h-3 w-2/3" />
              <SkeletonBlock className="h-3 w-1/2" />
            </div>
          </li>
        ))}
      </ul>
    </PageSkeletonFrame>
  );
}
