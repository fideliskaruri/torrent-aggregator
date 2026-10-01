import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Radar } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDisplayPath } from "@/lib/features";
import { buildInbox } from "./inbox";
import { NotificationFeed } from "@/components/notifications/notification-feed";
import { ActivityColumn } from "@/components/notifications/activity-view-toggle";
import { formatSaveLocation, parseHistoryFacts } from "@/lib/activity/history";
import { PageSkeletonFrame } from "@/components/ui/loading";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStableLoading } from "@/components/ui/use-stable-loading";
import {
  ACTIVITY_BATCH_SIZE,
  ACTIVITY_PAGE_SIZE,
  activityKindLabel,
  activityPageUrl,
  boundedActivityItems,
  groupActivityByDay,
  mergeActivityPages,
  olderActivityAction,
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

interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
  hasMore: boolean;
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

const STATUS_LABELS: Record<string, string> = {
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
  searching: "Searching",
  queued: "Waiting",
  downloaded: "Downloaded",
  completed: "Finished",
  complete: "Finished",
  info: "Info",
};

/** A status in the user's words; unknown values become sentence case, never a raw enum. */
function statusLabel(status: string): string {
  const known = STATUS_LABELS[status];
  if (known) return known;
  const words = status.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Update";
}

function ActivityContent({ sentOnly: sentOnlyOverride }: { sentOnly?: boolean }) {
  const displayPath = useDisplayPath();
  const [searchParams] = useSearchParams();
  const sentOnly =
    sentOnlyOverride ?? searchParams.get("filter") === "sent";
  const [visibleLimit, setVisibleLimit] = useState(ACTIVITY_BATCH_SIZE);
  const activityUrl = activityPageUrl({ sentOnly, limit: ACTIVITY_PAGE_SIZE });
  const activityQuery = useApiQuery<ActivityPage>(
    activityUrl,
    {
      select: (json) => {
        const body = json as Partial<ActivityPage>;
        return {
          items: body.items ?? [],
          nextCursor: body.nextCursor ?? null,
          hasMore: Boolean(body.hasMore),
        };
      },
    },
  );
  const { data, refetch } = activityQuery;

  // Pages fetched after the first. Held here rather than in the query hook
  // because the hook owns one request, and "older activity" is a sequence of
  // them whose results accumulate.
  const [olderItems, setOlderItems] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [serverHasMore, setServerHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Guards double-clicks without making the click handler depend on render
  // state, which is what a `loadingOlder` check would do.
  const inFlightRef = useRef(false);

  // A new filter is a new feed: anything paged in under the old one describes
  // a different question and must not be carried over.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOlderItems([]);
    setVisibleLimit(ACTIVITY_BATCH_SIZE);
    setOlderError(null);
  }, [activityUrl]);

  useEffect(() => {
    if (!data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCursor(data.nextCursor);
    setServerHasMore(data.hasMore);
  }, [data]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // `data ?? []` is a fresh array on every render, which would make the memo
  // below — and therefore the artwork lookup — recompute forever.
  const items = useMemo(() => {
    const normalized = mergeActivityPages(data?.items ?? [], olderItems).map(
      (item) => {
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
      },
    );
    // `/history` keeps the whole log — that is what a log is for. The inbox
    // does not: it shows only what is news. See `inbox.ts` for why, and for
    // what "news" means here.
    if (sentOnly) return normalized.filter((item) => item.status === "sent");

    const news = new Set(
      buildInbox(
        normalized.map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          message: item.message,
          createdAt: item.createdAt,
          infoHash: null,
        })),
      ).map((n) => n.id),
    );
    return normalized.filter((item) => news.has(item.id));
  }, [data, olderItems, sentOnly]);

  const visibleItems = boundedActivityItems(items, visibleLimit);
  const dayGroups = groupActivityByDay(visibleItems);
  const olderAction = olderActivityAction(
    visibleItems.length,
    items.length,
    serverHasMore,
  );
  const hasOlder = olderAction !== "none";

  // A plain function rather than `useCallback`: the in-flight guard lives in a
  // ref, so there is nothing here for a dependency array to get wrong, and the
  // compiler memoizes it for us.
  async function loadOlder() {
    if (olderAction === "none") return;
    if (olderAction === "reveal") {
      setVisibleLimit((limit) => limit + ACTIVITY_BATCH_SIZE);
      return;
    }
    if (inFlightRef.current || !cursor) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const res = await fetch(
        activityPageUrl({ sentOnly, cursor, limit: ACTIVITY_PAGE_SIZE }),
        { cache: "no-store", signal: controller.signal },
      );
      if (!res.ok) {
        // Never a silent no-op: a button that does nothing reads as "there is
        // nothing older", which is the one thing we do not know.
        throw new Error(`Request failed (${res.status})`);
      }
      const body = (await res.json()) as Partial<ActivityPage>;
      setOlderItems((current) =>
        mergeActivityPages(current, body.items ?? []),
      );
      setCursor(body.nextCursor ?? null);
      setServerHasMore(Boolean(body.hasMore));
      setVisibleLimit((limit) => limit + ACTIVITY_BATCH_SIZE);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setOlderError("Could not load older activity. Try again.");
    } finally {
      inFlightRef.current = false;
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }

  const title = sentOnly ? "Download log" : "Notifications";
  const description = sentOnly
    ? "Releases successfully sent to a download client."
    : // Truthful about what `buildInbox` actually keeps: this is not "all
      // activity", and calling it that is what made the old page a wall.
      "Finished downloads and failures that need you. Everything else is in the download log.";

  return (
    <PageQueryBoundary
      query={activityQuery}
      skeleton={(visible) => <ActivitySkeleton visible={visible} />}
      errorTitle="Could not load activity"
      frame={(node) => (
        <div className="min-w-0 space-y-5">
          <TfPageHeader title={title} description={description} />
          {node}
        </div>
      )}
    >
    {() => (
    <div className="min-w-0 space-y-5">
      <TfPageHeader title={title} description={description} />

      {!items.length ? (
        <TfEmptyState
          icon={Radar}
          title={sentOnly ? "No sent downloads yet" : "You're all caught up"}
          description={
            sentOnly
              ? "Successful manual and automation sends will appear here."
              : "Finished downloads and failures that need you show up here. Everything else stays in the download log."
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
                className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-subtle-foreground"
              >
                {group.label}
              </h2>
              <Card className="gap-0 py-0">
              <ul className="divide-y divide-border">
                {group.items.map((item) => {
                  const location = formatSaveLocation(item.savePath ? displayPath(item.savePath) : null, item.category);
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
                        className="mt-0.5 self-start"
                      >
                        {statusLabel(item.status)}
                      </Badge>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-foreground">
                          {item.title}
                        </p>
                        <p className="truncate text-xs text-subtle-foreground">
                          {[kindLabel, item.source, item.category]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        {item.message ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {item.message}
                          </p>
                        ) : null}
                        {location ? (
                          <p
                            className="truncate font-mono text-xs text-subtle-foreground"
                            title={item.savePath ? displayPath(item.savePath) : undefined}
                            data-save-path
                          >
                            Saved to {location}
                          </p>
                        ) : null}
                      </div>
                      <time
                        dateTime={item.createdAt}
                        className="col-start-2 whitespace-nowrap text-xs text-subtle-foreground sm:col-start-3 sm:row-start-1"
                      >
                        {formatRelativeTime(item.createdAt)}
                      </time>
                    </li>
                  );
                })}
              </ul>
              </Card>
            </section>
          ))}
          {hasOlder ? (
            <div className="space-y-2">
              {olderError ? (
                <p
                  role="status"
                  className="text-[12px] text-destructive"
                  data-older-error
                >
                  {olderError}
                </p>
              ) : null}
              <Button
                variant="secondary"
                className="max-md:min-h-11"
                disabled={loadingOlder}
                aria-busy={loadingOlder || undefined}
                onClick={() => void loadOlder()}
                data-load-older
              >
                {loadingOlder ? "Loading…" : "Show older activity"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
    )}
    </PageQueryBoundary>
  );
}

export function NotificationsView({ sentOnly: sentOnlyOverride }: { sentOnly?: boolean }) {
  // The same rule `ActivityContent` uses, so the toggle marks the view it shows.
  const [searchParams] = useSearchParams();
  const sentOnly = sentOnlyOverride ?? searchParams.get("filter") === "sent";
  return (
    <ActivityColumn view={sentOnly ? "log" : "inbox"}>
      <Suspense fallback={<ActivitySkeleton />}>
        <ActivityContent sentOnly={sentOnly} />
      </Suspense>
    </ActivityColumn>
  );
}

export default function NotificationsPage() {
  return (
    <ActivityColumn view="inbox">
      <NotificationFeed />
    </ActivityColumn>
  );
}

function ActivitySkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading activity"
      className={cn(
        "min-w-0 space-y-5 transition-opacity duration-150",
        !visible && "opacity-0",
      )}
    >
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <Skeleton className="h-3 w-20" />
      <Card className="gap-0 py-0">
        <ul className="divide-y divide-border">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="flex items-start gap-2.5 px-3 py-2.5" aria-hidden>
              <Skeleton className="h-5 w-14 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <Skeleton className="hidden h-3 w-12 shrink-0 sm:block" />
            </li>
          ))}
        </ul>
      </Card>
    </PageSkeletonFrame>
  );
}
