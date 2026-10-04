import { useState } from "react";
import { useApiQuery } from "@/hooks/use-api-query";
import { send } from "@/lib/api";

export const NOTIFICATIONS_CHANGED = "tf:notifications-read";

export interface NotificationItem {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  readAt: string | null;
  searchText: string;
  unread: boolean;
}

interface NotificationResponse {
  items: NotificationItem[];
  unreadCount: number;
}

function parseNotifications(json: unknown): NotificationResponse {
  const body = (json ?? {}) as { items?: unknown; unreadCount: number };
  const rows = Array.isArray(body.items) ? body.items : [];
  const items = rows.flatMap((value): NotificationItem[] => {
    const row = (value ?? {}) as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.title !== "string") return [];
    const bodyText = typeof row.body === "string" ? row.body : null;
    const readAt = typeof row.readAt === "string" ? row.readAt : null;
    return [{
      id: row.id,
      title: row.title,
      body: bodyText,
      link: typeof row.link === "string" ? row.link : null,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
      readAt,
      searchText: `${row.title} ${bodyText ?? ""}`,
      unread: readAt == null,
    }];
  });
  return {
    items,
    unreadCount: body.unreadCount,
  };
}

export function useNotifications() {
  const [busy, setBusy] = useState(false);
  const query = useApiQuery<NotificationResponse>("/api/notifications", {
    refreshMs: 15_000,
    emptyOnUnauthorized: false,
    select: parseNotifications,
  });

  async function mutate(actions: readonly { url: string; method?: "POST" | "DELETE" }[]) {
    setBusy(true);
    try {
      const responses = await Promise.all(actions.map(({ url, method = "POST" }) => send(url, { method })));
      const failed = responses.find((response) => !response.ok);
      if (failed) throw failed.error ?? new Error(`Could not update notifications (${failed.status}). Try again.`);
    } finally {
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
      query.refetch();
      setBusy(false);
    }
  }

  async function markRead(id: string) {
    await mutate([{ url: `/api/notifications/read/${encodeURIComponent(id)}` }]);
  }

  async function markManyRead(ids: readonly string[]) {
    await mutate(ids.map((id) => ({
      url: `/api/notifications/read/${encodeURIComponent(id)}`,
    })));
  }

  async function markAllRead() {
    await mutate([{ url: "/api/notifications/read-all" }]);
  }

  async function clearAll() {
    await mutate([{ url: "/api/notifications", method: "DELETE" }]);
  }

  return { query, busy, markRead, markManyRead, markAllRead, clearAll };
}
