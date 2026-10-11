import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get } from "@/lib/api";
import { Radar } from "lucide-react";
import { formatWhen } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { TfPageHeader } from "@/components/tf/page-header";
import { TfEmptyState } from "@/components/tf/empty-state";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDisplayPath } from "@/lib/features";
import { formatSaveLocation, parseHistoryFacts } from "@/lib/activity/history";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  activityPageUrl,
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_BATCH_SIZE,
  activityKindLabel,
  boundedActivityItems,
  groupActivityByDay,
  mergeActivityPages,
  olderActivityAction,
} from "./presentation";
import { ActivitySkeleton } from "./activity-skeleton";
import type { ActivityPage } from "./activity-types";

export function ActivityContent() {
  const displayPath = useDisplayPath();
  const [visibleLimit, setVisibleLimit] = useState(ACTIVITY_BATCH_SIZE);
  const activityQuery = useApiQuery<ActivityPage>(
    activityPageUrl({ limit: ACTIVITY_PAGE_SIZE }),
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
  const { data } = activityQuery;
  const [olderPages, setOlderPages] = useState<ActivityPage[]>([]);
  const olderItems = useMemo(
    () => olderPages.flatMap((page) => page.items),
    [olderPages],
  );
  const lastPage = olderPages[olderPages.length - 1];
  const cursor = lastPage ? lastPage.nextCursor : data?.nextCursor ?? null;
  const serverHasMore = lastPage ? lastPage.hasMore : Boolean(data?.hasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  const items = useMemo(() => {
    const normalized = mergeActivityPages(data?.items ?? [], olderItems).map(
      (item) => ({ ...item, ...parseHistoryFacts(item) }),
    );
    return normalized;
  }, [data?.items, olderItems]);
  const visibleItems = boundedActivityItems(items, visibleLimit);
  const dayGroups = groupActivityByDay(visibleItems);
  const olderAction = olderActivityAction(
    visibleItems.length,
    items.length,
    serverHasMore,
  );
  const hasOlder = olderAction !== "none";

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
      const res = await get(
        activityPageUrl({ cursor, limit: ACTIVITY_PAGE_SIZE }),
        { cache: "no-store", signal: controller.signal },
      );
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const body = (await res.json()) as Partial<ActivityPage>;
      setOlderPages((current) => [
        ...current,
        {
          items: body.items ?? [],
          nextCursor: body.nextCursor ?? null,
          hasMore: Boolean(body.hasMore),
        },
      ]);
      setVisibleLimit((limit) => limit + ACTIVITY_BATCH_SIZE);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setOlderError("Could not load older activity. Try again.");
    } finally {
      inFlightRef.current = false;
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }

  function withHeader(content: ReactNode) {
    return (
      <div className="min-w-0 space-y-5">
        <TfPageHeader
          title="Download log"
          description="Sources successfully sent to a download client."
        />
        {content}
      </div>
    );
  }

  return (
    <PageQueryBoundary
      query={activityQuery}
      skeleton={(visible) => <ActivitySkeleton visible={visible} />}
      errorTitle="Could not load activity"
      frame={withHeader}
    >
      {() => withHeader(
        !items.length ? (
          <TfEmptyState
            icon={Radar}
            title="No sent downloads yet"
            description="Successful manual and automation sends will appear here."
            actionLabel="Open library"
            actionHref="/library"
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
                      const location = formatSaveLocation(
                        item.savePath ? displayPath(item.savePath) : null,
                        item.category,
                      );
                      const kindLabel = activityKindLabel(item);
                      return (
                        <li
                          key={item.id}
                          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                          data-activity-type={item.type}
                          data-activity-status={item.status}
                        >
                          <Badge variant="success" className="mt-0.5 self-start">Sent</Badge>
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-foreground">
                              {item.title}
                            </p>
                            <p className="truncate text-xs text-subtle-foreground">
                              {[kindLabel, item.category].filter(Boolean).join(" · ")}
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
                            {formatWhen(item.createdAt, { style: "relative" })}
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
                  <p role="status" className="text-[12px] text-destructive" data-older-error>
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
        ),
      )}
    </PageQueryBoundary>
  );
}
