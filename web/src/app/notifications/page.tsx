import { ActivityColumn } from "@/components/notifications/activity-view-toggle";
import { NotificationsList } from "@/components/notifications/notifications-list";
import { TfEmptyState } from "@/components/tf/empty-state";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { TfPageHeader } from "@/components/tf/page-header";
import { useNotifications } from "./use-notifications";

export { NotificationsView } from "./activity-view";

export default function NotificationsPage() {
  const notifications = useNotifications();
  const { data, ...query } = notifications.query;
  const items = data?.items ?? [];

  return (
    <ActivityColumn view="inbox">
      <div className="container-app min-w-0 space-y-5 py-6 pb-[calc(var(--mobile-nav-h)+var(--safe-bottom)+1.5rem)] sm:py-8 sm:pb-8">
        <TfPageHeader title="Notifications" description="Finished downloads and updates that need your attention." />
        <PageQueryBoundary
          query={{ ...query, data }}
          errorTitle="Could not load notifications"
          isEmpty={() => false}
          empty={<TfEmptyState title="You're all caught up" description="New requests and download updates will appear here." actionLabel="Back to browse" actionHref="/" />}
          skeleton={() => (
            <div className="space-y-2" role="status" aria-label="Loading notifications">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="surface h-20 animate-pulse rounded-md" aria-hidden />
              ))}
            </div>
          )}
        >
          {() => (
            <NotificationsList
              items={items}
              unreadCount={data?.unreadCount ?? 0}
              busy={notifications.busy}
              onRead={(item) => notifications.markRead(item.id)}
              onReadMany={(selected) => notifications.markManyRead(selected.map((item) => item.id))}
              onReadAll={notifications.markAllRead}
              onClearAll={notifications.clearAll}
            />
          )}
        </PageQueryBoundary>
      </div>
    </ActivityColumn>
  );
}
