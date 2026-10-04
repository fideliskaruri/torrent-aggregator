import { ActivityColumn } from "@/components/notifications/activity-view-toggle";
import { NotificationsList } from "@/components/notifications/notifications-list";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { TfPageHeader } from "@/components/tf/page-header";
import { cn } from "@/lib/utils";
import { useNotifications } from "./use-notifications";

export default function NotificationsPage() {
  const notifications = useNotifications();

  return (
    <ActivityColumn view="inbox">
      <div className="min-w-0 space-y-5">
        <TfPageHeader title="Notifications" description="Finished downloads and updates that need your attention." />
        <PageQueryBoundary
          query={notifications.query}
          errorTitle="Could not load notifications"
          skeleton={(visible) => (
            <div className={cn("space-y-2 transition-opacity duration-150", !visible && "opacity-0")} role="status" aria-label="Loading notifications">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="surface h-20 animate-pulse rounded-md" aria-hidden />
              ))}
            </div>
          )}
        >
          {(data) => (
            <NotificationsList
              items={data.items}
              unreadCount={data.unreadCount}
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
