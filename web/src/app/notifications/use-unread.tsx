import { useSyncExternalStore } from "react";
import { get } from "@/lib/api";
import { NOTIFICATIONS_CHANGED } from "./use-notifications";
import { badgeText } from "./inbox";

let count = 0;
let pending: Promise<void> | null = null;
let refreshAgain = false;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function refresh() {
  if (document.visibilityState === "hidden") return;
  if (pending) { refreshAgain = true; return; }
  pending = (async () => {
    try {
      const result = await get<{ unreadCount: number }>("/api/notifications/unread-count", {
        signal: AbortSignal.timeout(10_000),
      });
      if (result.ok && typeof result.data?.unreadCount === "number") {
        count = result.data.unreadCount;
        for (const notify of listeners) notify();
      }
    } catch { /* Keep the last confirmed badge until the next successful refresh. */ }
  })().finally(() => {
    pending = null;
    if (refreshAgain && listeners.size > 0) { refreshAgain = false; refresh(); }
  });
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) {
    if (!pending) refresh();
    timer = setInterval(refresh, 15_000);
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    document.addEventListener("visibilitychange", refresh);
  }
  return () => {
    listeners.delete(notify);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
      document.removeEventListener("visibilitychange", refresh);
    }
  };
}
export function useUnreadNotifications(): { count: number; badge: string | null } {
  const unread = useSyncExternalStore(subscribe, () => count, () => 0);
  return { count: unread, badge: badgeText(unread) };
}
