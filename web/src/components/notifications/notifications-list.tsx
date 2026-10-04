import { useCallback, useMemo, useState } from "react";
import { Bell, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { keepFocusNear } from "@/components/ui/focus-return";
import { BulkBar } from "@/components/tf/bulk-bar";
import { ConfirmAction } from "@/components/tf/confirm-action";
import { DataList } from "@/components/tf/data-list";
import { FilterBar, type FilterField } from "@/components/tf/filter-bar";
import { StatusChip } from "@/components/tf/status-chip";
import { TfEmptyState } from "@/components/tf/empty-state";
import { useSelection } from "@/components/tf/use-selection";
import { isReleasePickLink, PICK_RELEASE_LABEL } from "@/components/releases/release-picker-store";
import { formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { NotificationItem } from "@/app/notifications/use-notifications";

const KEY = (item: NotificationItem) => item.id;
const FILTER_FIELDS: readonly FilterField<NotificationItem>[] = [
  { key: "searchText", label: "Search notifications", kind: "search" },
  { key: "unread", label: "Unread only", kind: "toggle" },
];

export function NotificationsList({
  items,
  unreadCount,
  busy,
  onRead,
  onReadMany,
  onReadAll,
  onClearAll,
}: {
  items: NotificationItem[];
  unreadCount: number;
  busy: boolean;
  onRead: (item: NotificationItem) => Promise<void>;
  onReadMany: (items: readonly NotificationItem[]) => Promise<void>;
  onReadAll: () => Promise<void>;
  onClearAll: () => Promise<void>;
}) {
  const [predicate, setPredicate] = useState<(item: NotificationItem) => boolean>(() => () => true);
  const filtered = useMemo(() => items.filter(predicate), [items, predicate]);
  const selection = useSelection(filtered, KEY);
  const [operationError, setOperationError] = useState<string | null>(null);
  const filterChange = useCallback((next: (item: NotificationItem) => boolean) => setPredicate(() => next), []);
  const clearFilters = useCallback(() => setPredicate(() => () => true), []);
  const empty = items.length ? (
    <TfEmptyState icon={Bell} title="No notifications match" description="Clear the filters to see other notifications." />
  ) : (
    <div data-notifications-empty>
      <TfEmptyState
        icon={Bell}
        title="You're all caught up"
        description="New requests and download updates will appear here."
        actionLabel="Back to browse"
        actionHref="/"
      />
    </div>
  );
  async function run(action: () => Promise<void>, fallbackMessage: string, rethrow = false) {
    setOperationError(null);
    try {
      await action();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : fallbackMessage);
      if (rethrow) throw error;
    }
  }

  async function markSelected() {
    const selected = [...selection.selected];
    selection.clear();
    await run(
      () => onReadMany(selected.filter((item) => item.unread)),
      "Could not mark notifications read. Try again.",
    );
  }

  async function markEveryUnread() {
    await run(onReadAll, "Could not mark notifications read. Try again.");
  }

  async function clearNotifications() {
    await run(onClearAll, "Could not clear notifications. Try again.", true);
  }

  async function markOne(item: NotificationItem) {
    await run(
      () => onRead(item),
      "Could not mark this notification read. Try again.",
    );
  }

  return (
    <section className="space-y-4" data-notification-feed>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" data-notifications-summary>
          {items.length} notifications · {unreadCount} unread
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            aria-disabled={busy || unreadCount === 0 || undefined}
            onClick={() => { if (!busy && unreadCount > 0) void markEveryUnread(); }}
            aria-label="Mark all notifications read"
            data-notifications-read-all
            className="min-h-11"
          >
            Mark all read
          </Button>
          {items.length ? (
            <ConfirmAction
              label={<><Trash2 aria-hidden="true" />Clear all</>}
              title="Clear all notifications?"
              description="This removes every notification from your inbox."
              confirmLabel="Clear notifications"
              onConfirm={clearNotifications}
              variant="ghost"
              buttonProps={{ className: "min-h-11", disabled: busy }}
            />
          ) : null}
        </div>
      </div>
      {operationError ? (
        <Alert variant="destructive">
          <AlertDescription>{operationError}</AlertDescription>
        </Alert>
      ) : null}
      <FilterBar fields={FILTER_FIELDS} onPredicateChange={filterChange}>
        {({ activeCount }) => (
          <div className="space-y-4">
            <Card className="gap-0 py-0">
              <DataList
                items={filtered}
                getKey={KEY}
                selection={selection}
                empty={empty}
                noResults={Boolean(items.length && activeCount)}
                onClearFilters={clearFilters}
                className="divide-y divide-border space-y-0"
                renderRow={(item) => (
                  <div
                    data-notification-id={item.id}
                    data-unread={item.unread}
                    className="flex min-w-0 flex-wrap items-start gap-3 p-4"
                  >
                    <span aria-hidden className={cn("mt-2 size-2 shrink-0 rounded-full", item.unread ? "bg-brand" : "bg-transparent")} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className={item.unread ? "font-semibold text-foreground" : "text-muted-foreground"}>{item.title}</p>
                        <StatusChip label={item.unread ? "Unread" : "Read"} tone={item.unread ? "active" : "neutral"} />
                      </div>
                      {item.body ? <p className="break-words text-sm text-muted-foreground">{item.body}</p> : null}
                      <time className="block text-xs text-subtle-foreground" dateTime={item.createdAt}>
                        {formatWhen(item.createdAt, { style: "relative" })}
                      </time>
                      {item.link ? (
                        <Button asChild variant="link" className="h-auto min-h-11 px-0">
                          <Link
                            to={item.link}
                            onClick={() => { if (item.unread) void markOne(item); }}
                            aria-label={`Open ${item.title}`}
                            data-notification-open
                          >
                            {isReleasePickLink(item.link) ? PICK_RELEASE_LABEL : "View details"}
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                    {item.unread ? (
                      <Button
                        variant="ghost"
                        aria-disabled={busy || undefined}
                        onClick={(event) => {
                          if (busy) return;
                          keepFocusNear(event.currentTarget);
                          void markOne(item);
                        }}
                        aria-label={`Mark ${item.title} read`}
                        data-notification-read
                        className="min-h-11"
                      >
                        Mark read
                      </Button>
                    ) : null}
                  </div>
                )}
              />
            </Card>
            <BulkBar
              count={selection.selected.length}
              onClear={selection.clear}
              actions={<Button type="button" variant="secondary" disabled={busy || !selection.selected.some((item) => item.unread)} onClick={() => void markSelected()} className="min-h-11">
                Mark selected read
              </Button>}
            />
          </div>
        )}
      </FilterBar>
      {items.length === 100 ? (
        <p className="text-xs text-subtle-foreground">Showing the latest 100 notifications. Mark all read also clears older unread entries.</p>
      ) : null}
    </section>
  );
}
