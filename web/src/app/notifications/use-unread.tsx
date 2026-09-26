import { useEffect } from "react";
import { useApiQuery } from "@/hooks/use-api-query";
import { badgeText } from "./inbox";

export function useUnreadNotifications(): { count: number; badge: string | null } {
  const { data, refetch } = useApiQuery<{ unreadCount: number }>("/api/notifications?limit=1", {
    refreshMs: 15_000, emptyOnUnauthorized: false,
  });
  useEffect(() => {
    window.addEventListener("tf:notifications-read", refetch);
    return () => window.removeEventListener("tf:notifications-read", refetch);
  }, [refetch]);
  const count = data?.unreadCount ?? 0;
  return { count, badge: badgeText(count) };
}
