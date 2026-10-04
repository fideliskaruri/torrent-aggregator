import { useEffect } from "react";
import { useApiQuery } from "@/hooks/use-api-query";
import { NOTIFICATIONS_CHANGED } from "./use-notifications";
import { badgeText } from "./inbox";

export function useUnreadNotifications(): { count: number; badge: string | null } {
  const { data, refetch } = useApiQuery<{ unreadCount: number }>("/api/notifications?limit=1", {
    refreshMs: 15_000, emptyOnUnauthorized: false,
  });
  useEffect(() => {
    window.addEventListener(NOTIFICATIONS_CHANGED, refetch);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, refetch);
  }, [refetch]);
  const count = data?.unreadCount ?? 0;
  return { count, badge: badgeText(count) };
}
