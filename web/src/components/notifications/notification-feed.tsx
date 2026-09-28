import { useEffect, useState } from "react";
import { AlertTriangle, Bell } from "lucide-react";
import { Link, useLocation } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PageSkeletonFrame } from "@/components/ui/loading";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TfEmptyState } from "@/components/tf/empty-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { useUnreadNotifications } from "@/app/notifications/use-unread";
import { sessionAwareFetch } from "@/lib/session-expiry";
import { cn, formatRelativeTime } from "@/lib/utils";
import { withTimeout } from "@/lib/with-timeout";

const PUSH_ENABLE_TIMEOUT_MS = 15_000;
const PUSH_ENABLE_FAIL = "Couldn't enable push. Check the browser's notification permission.";

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
  const response = await sessionAwareFetch(`/api/notifications/${path}`, {
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
  async function read(id?: string) {
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
    <section className="mx-auto w-full max-w-3xl space-y-4 py-6" data-notification-feed>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">Notifications</h1>
        <Button variant="outline" disabled={busy || !data?.unreadCount} onClick={() => void read()}
          aria-label="Mark all notifications read" data-notifications-read-all className="min-h-11">Mark all read</Button>
      </div>
      <PushToggle />
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
            <ul className="divide-y divide-border">
              {data?.items.map(item => <li key={item.id} data-notification-id={item.id} data-unread={!item.readAt}
                className="flex min-w-0 flex-wrap items-start gap-3 p-4">
                <span aria-hidden className={cn("mt-2 size-2 shrink-0 rounded-full", item.readAt ? "bg-transparent" : "bg-brand")} />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className={item.readAt ? "text-muted-foreground" : "font-semibold text-foreground"}>{item.title}</p>
                  {item.body && <p className="break-words text-sm text-muted-foreground">{item.body}</p>}
                  <time className="block text-xs text-subtle-foreground" dateTime={item.createdAt}>{formatRelativeTime(item.createdAt)}</time>
                  {item.link && <Button asChild variant="link" className="h-auto min-h-11 px-0">
                    <Link to={item.link} onClick={() => { if (!item.readAt) void read(item.id); }}
                      aria-label={`Open ${item.title}`} data-notification-open>View details</Link>
                  </Button>}
                </div>
                {!item.readAt && <Button variant="ghost" disabled={busy} onClick={() => void read(item.id)}
                  aria-label={`Mark ${item.title} read`} data-notification-read className="min-h-11">Mark read</Button>}
              </li>)}
            </ul>
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
function PushToggle() {
  const supported = typeof window !== "undefined" && window.isSecureContext
    && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const [enabled, setEnabled] = useState(false);
  const [checking, setChecking] = useState(supported);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    navigator.serviceWorker.getRegistration("/").then(async registration => {
      const subscription = await registration?.pushManager.getSubscription();
      if (!disposed) setEnabled(Boolean(subscription));
    }).catch(() => { if (!disposed) setError("Could not check push settings. Try again."); })
      .finally(() => { if (!disposed) setChecking(false); });
    return () => { disposed = true; };
  }, [supported]);
  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (enabled) {
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        const registration = await withTimeout(
          navigator.serviceWorker.ready,
          10_000,
          "Service worker is not ready. Reload and try again.",
        );
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
          await mutate("push/subscription", "DELETE", { endpoint: existing.endpoint });
          if (!await existing.unsubscribe()) throw new Error("Browser could not disable push. Try again.");
        }
        setEnabled(false);
      } else {
        await withTimeout(enablePush(), PUSH_ENABLE_TIMEOUT_MS, PUSH_ENABLE_FAIL);
        setEnabled(true);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function enablePush() {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(PUSH_ENABLE_FAIL);
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const response = await sessionAwareFetch("/api/notifications/push/public-key", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load push settings. Try again.");
    const { publicKey } = await response.json() as { publicKey: string };
    const key = publicKey.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(key.padEnd(Math.ceil(key.length / 4) * 4, "=")), c => c.charCodeAt(0));
    const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    const json = subscription.toJSON();
    try {
      await mutate("push/subscription", "POST", { endpoint: subscription.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth });
    } catch (e) {
      if (!existing) await subscription.unsubscribe();
      throw e;
    }
  }
  const stateLabel = busy ? "Saving…" : checking ? "Checking…" : enabled ? "On" : "Off";
  return <Card size="sm" className="gap-2 px-4 py-3">
    <div className="flex min-h-11 items-center justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor="push-toggle" className="text-sm font-medium text-foreground">Browser notifications</Label>
        <p className="text-xs text-subtle-foreground">{supported ? "Optional alerts on this device, even when the app is closed." : "Push needs a supported browser and HTTPS (or localhost). On iOS, install the app first."}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <span className="text-xs tabular-nums text-muted-foreground" aria-hidden>{stateLabel}</span>
        <Switch id="push-toggle" checked={enabled} aria-label="Browser push notifications" data-push-toggle
          aria-busy={busy || checking || undefined}
          disabled={!supported || checking || busy} onCheckedChange={() => void toggle()} />
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </Card>;
}