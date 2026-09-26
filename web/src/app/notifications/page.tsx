import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Radar } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDisplayPath } from "@/lib/features";
import { buildInbox } from "./inbox";
import { NotificationFeed } from "@/components/notifications/notification-feed";
import { formatSaveLocation, parseHistoryFacts } from "@/lib/activity/history";
import { PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";
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

function ActivityContent({ sentOnly: sentOnlyOverride }: { sentOnly?: boolean }) {
  const displayPath = useDisplayPath();
  const [searchParams] = useSearchParams();
  const sentOnly =
    sentOnlyOverride ?? searchParams.get("filter") === "sent";
  const [visibleLimit, setVisibleLimit] = useState(ACTIVITY_BATCH_SIZE);
  const activityUrl = activityPageUrl({ sentOnly, limit: ACTIVITY_PAGE_SIZE });
  const { data, loading, error, refetch } = useApiQuery<ActivityPage>(
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

  const showLoading = useStableLoading(loading && data == null && !error);
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

  const filterControls = (
    <div
      className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface-2)] p-0.5 text-[12px]"
      aria-label="Activity view"
    >
      <Link
        to="/notifications"
        aria-current={!sentOnly ? "page" : undefined}
        className={`inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-full px-3 py-1 transition-colors lg:min-h-0 lg:min-w-0 ${
          !sentOnly
            ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
            : "text-[var(--text-tertiary)] hover:text-[var(--text)]"
        }`}
      >
        Inbox
      </Link>
      <Link
        to="/history"
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
                className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]"
              >
                {group.label}
              </h2>
              <ul className="surface divide-y divide-[var(--border)] overflow-hidden">
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
                            title={item.savePath ? displayPath(item.savePath) : undefined}
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
            <div className="space-y-2">
              {olderError ? (
                <p
                  role="status"
                  className="text-[12px] text-[var(--danger)]"
                  data-older-error
                >
                  {olderError}
                </p>
              ) : null}
              <button
                type="button"
                className="btn btn-secondary btn-md"
                disabled={loadingOlder}
                aria-busy={loadingOlder || undefined}
                onClick={() => void loadOlder()}
                data-load-older
              >
                {loadingOlder ? "Loading…" : "Show older activity"}
              </button>
            </div>
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
  return <div className="container-app"><NotificationFeed /></div>;
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
