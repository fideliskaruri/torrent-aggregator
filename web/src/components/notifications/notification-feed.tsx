import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { useUnreadNotifications } from "@/app/notifications/use-unread";
import { sessionAwareFetch } from "@/lib/session-expiry";
import { formatRelativeTime } from "@/lib/utils";
import { withTimeout } from "@/lib/with-timeout";

const PUSH_ENABLE_TIMEOUT_MS = 15_000;
const PUSH_ENABLE_FAIL = "Couldn't enable push — check browser notification permission";

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
  return (
    <Link to="/notifications" aria-label={`Notifications${count ? `, ${count} unread` : ""}`}
      data-notification-bell className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-[var(--bg-muted)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
      <Bell className="h-5 w-5" aria-hidden />
      {badge && <span data-notification-badge className="absolute right-0 top-0 rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-[var(--primary-foreground)]">{badge}</span>}
    </Link>
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
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <Button variant="outline" disabled={busy || !data?.unreadCount} onClick={() => void read()}
          aria-label="Mark all notifications read" data-notifications-read-all className="min-h-[44px]">Mark all read</Button>
      </div>
      <PushToggle />
      {actionError && <p role="alert" className="text-sm text-[var(--danger)]">{actionError}</p>}
      {error ? <div role="alert"><p>{error}</p><Button variant="outline" onClick={refetch} aria-label="Retry notifications" data-notifications-retry>Retry</Button></div>
        : loading && !data ? <p role="status">Loading notifications…</p>
        : data && !data.items.length ? <div className="space-y-3 rounded-lg border border-[var(--border)] p-6">
          <p>You&apos;re all caught up. New requests and download updates will appear here.</p><Link to="/" className="underline">Back to browse</Link>
        </div> : (
          <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]">
            {data?.items.map(item => <li key={item.id} data-notification-id={item.id} data-unread={!item.readAt}
              className="flex min-w-0 flex-wrap items-start gap-3 p-4">
              <div className="min-w-0 flex-1 space-y-1">
                <p className={item.readAt ? "text-[var(--text-secondary)]" : "font-semibold"}>{item.title}</p>
                {item.body && <p className="break-words text-sm text-[var(--text-secondary)]">{item.body}</p>}
                <time className="text-xs text-[var(--text-tertiary)]" dateTime={item.createdAt}>{formatRelativeTime(item.createdAt)}</time>
                {item.link && <Link to={item.link} onClick={() => { if (!item.readAt) void read(item.id); }}
                  aria-label={`Open ${item.title}`} data-notification-open className="flex min-h-[44px] items-center text-sm underline">View details</Link>}
              </div>
              {!item.readAt && <Button variant="ghost" disabled={busy} onClick={() => void read(item.id)}
                aria-label={`Mark ${item.title} read`} data-notification-read className="min-h-[44px]">Mark read</Button>}
            </li>)}
          </ul>
        )}
      {data && data.items.length === 100 && <p className="text-xs text-[var(--text-tertiary)]">Showing the latest 100 notifications. Mark all read also clears older unread entries.</p>}
    </section>
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
  return <div className="space-y-2 rounded-lg border border-[var(--border)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-sm font-medium">Browser notifications</p>
        <p className="text-xs text-[var(--text-tertiary)]">{supported ? "Optional alerts on this device, even when the app is closed." : "Push needs a supported browser and HTTPS (or localhost). On iOS, install the app first."}</p></div>
      <Button variant="outline" role="switch" aria-checked={enabled} aria-label="Browser push notifications" data-push-toggle
        disabled={!supported || checking || busy} onClick={() => void toggle()} className="min-h-[44px]">
        {busy ? "Saving…" : checking ? "Checking…" : enabled ? "Disable push" : "Enable push"}
      </Button>
    </div>
    {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
  </div>;
}
