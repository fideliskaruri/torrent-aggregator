import { useState } from "react";
import { AlertTriangle, Bell } from "lucide-react";
import { Link, useLocation } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { keepFocusNear } from "@/components/ui/focus-return";
import { PageSkeletonFrame } from "@/components/ui/loading";
import { Skeleton } from "@/components/ui/skeleton";
import { TfEmptyState } from "@/components/tf/empty-state";
import { DataList } from "@/components/tf/data-list";
import { useApiQuery } from "@/hooks/use-api-query";
import { useUnreadNotifications } from "@/app/notifications/use-unread";
import { send } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isReleasePickLink, PICK_RELEASE_LABEL } from "@/components/releases/release-picker-store";

export const NOTIFICATIONS_CHANGED = "tf:notifications-read";

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

async function mutate(path: string, method = "POST", body?: unknown) {
  const response = await send(`/api/notifications/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Could not save notification settings (${response.status}). Try again.`);
}

export function NotificationBell() {
  const { count, badge } = useUnreadNotifications();
  const pathname = useLocation().pathname;
  const active = ["/notifications", "/activity", "/history"].some((href) => pathname === href || pathname.startsWith(`${href}/`));
  return (
    <Button asChild variant="ghost"
      className={cn("relative hidden md:inline-flex h-9 min-w-9 pointer-coarse:h-11 pointer-coarse:min-w-11 shrink-0", badge ? "gap-0.5 pl-2 pr-1.5" : "w-9 pointer-coarse:w-11 px-0",
        active ? "bg-muted text-foreground" : "text-muted-foreground")}>
      <Link to="/notifications" aria-label={`Notifications${count ? `, ${count} unread` : ""}`}
        aria-current={active ? "page" : undefined}
        data-notification-bell>
        <Bell className="size-5" aria-hidden />
        {/* Phones carry the count on the Alerts tab, so the bell is desktop only.
            In flow beside the bell, raised like a superscript: hung off the
            corner it lost its top half to the header and covered the glyph. */}
        {badge && <Badge variant="solid" data-notification-badge aria-hidden
          className="-mt-4 h-[18px] min-h-[18px] min-w-[18px] rounded-full px-1 text-[12px] font-semibold leading-[18px] tabular-nums">{badge}</Badge>}
      </Link>
    </Button>
  );
}

export function NotificationFeed() {
  const { data, loading, error, refetch } = useApiQuery<{ items: NotificationItem[]; unreadCount: number }>("/api/notifications", {
    refreshMs: 15_000, emptyOnUnauthorized: false,
  });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const nothingUnread = !data?.unreadCount;
  async function read(id?: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await mutate(id ? `read/${encodeURIComponent(id)}` : "read-all");
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
      refetch();
    } catch (e) { setActionError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    // The page column (`ActivityColumn`) is the caller's.
    <section className="space-y-4" data-notification-feed>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">Notifications</h1>
        {/* aria-disabled, not disabled: this button has focus when it runs out of work, and a disabled one drops it to <body>. */}
        <Button variant="outline" aria-disabled={busy || nothingUnread || undefined} onClick={() => { if (!nothingUnread) void read(); }}
          aria-label="Mark all notifications read" data-notifications-read-all className="min-h-11">Mark all read</Button>
      </div>
      {actionError && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertDescription className="text-destructive">{actionError}</AlertDescription>
        </Alert>
      )}
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>Could not load notifications</AlertTitle>
          <AlertDescription className="text-destructive">{error}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={refetch} aria-label="Retry notifications" data-notifications-retry>Retry</Button>
          </AlertAction>
        </Alert>
      ) : loading && !data ? <NotificationFeedSkeleton />
        : data && !data.items.length ? (
          <div data-notifications-empty>
            <TfEmptyState icon={Bell} title="You're all caught up"
              description="New requests and download updates will appear here."
              actionLabel="Back to browse" actionHref="/" />
          </div>
        ) : (
          <Card className="gap-0 py-0">
            <DataList items={data?.items ?? []} getKey={(item) => item.id} className="divide-y divide-border space-y-0"
              renderRow={(item) => (
                <div data-notification-id={item.id} data-unread={!item.readAt}
                  className="flex min-w-0 flex-wrap items-start gap-3 p-4">
                <span aria-hidden className={cn("mt-2 size-2 shrink-0 rounded-full", item.readAt ? "bg-transparent" : "bg-brand")} />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className={item.readAt ? "text-muted-foreground" : "font-semibold text-foreground"}>{item.title}</p>
                  {item.body && <p className="break-words text-sm text-muted-foreground">{item.body}</p>}
                  <time className="block text-xs text-subtle-foreground" dateTime={item.createdAt}>{formatWhen(item.createdAt, { style: "relative" })}</time>
                  {item.link && <Button asChild variant="link" className="h-auto min-h-11 px-0">
                    <Link to={item.link} onClick={() => { if (!item.readAt) void read(item.id); }}
                      aria-label={`Open ${item.title}`} data-notification-open>{isReleasePickLink(item.link) ? PICK_RELEASE_LABEL : "View details"}</Link>
                  </Button>}
                </div>
                {!item.readAt && <Button variant="ghost" aria-disabled={busy || undefined} onClick={(event) => {
                  if (busy) return;
                  // The button goes once the item is read; keep focus in the list rather than on <body>.
                  keepFocusNear(event.currentTarget);
                  void read(item.id);
                }}
                  aria-label={`Mark ${item.title} read`} data-notification-read className="min-h-11">Mark read</Button>}
                </div>
              )}
            />
          </Card>
        )}
      {data && data.items.length === 100 && <p className="text-xs text-subtle-foreground">Showing the latest 100 notifications. Mark all read also clears older unread entries.</p>}
    </section>
  );
}

function NotificationFeedSkeleton() {
  return (
    <PageSkeletonFrame
      aria-label="Loading notifications"
      className="space-y-2"
    >
      <Card className="gap-0 py-0">
        <ul className="divide-y divide-border">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="flex items-start gap-3 p-4" aria-hidden>
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <Skeleton className="h-11 w-20 shrink-0" />
            </li>
          ))}
        </ul>
      </Card>
    </PageSkeletonFrame>
  );
}
