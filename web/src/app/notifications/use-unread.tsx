import { useCallback, useEffect, useState } from "react";

import { badgeText, unreadCountUrl } from "./inbox";

const STORAGE_KEY = "tf-notifications-read-at";
const READ_EVENT = "tf:notifications-read";

/**
 * Record that the inbox has been seen.
 *
 * A plain function rather than part of the hook, so the page can call it
 * without owning any state. The event is what tells the nav badges — which
 * live in two other components — to clear; without it a badge would sit there
 * contradicting the page the user is currently reading.
 */
function markNotificationsRead(): void {
  localStorage.setItem(STORAGE_KEY, new Date().toISOString());
  window.dispatchEvent(new CustomEvent(READ_EVENT));
}

/**
 * How many notifications the user has not seen, for the nav badge.
 *
 * The read mark is a timestamp in `localStorage`, not a set of ids on the
 * server. Two reasons, and the second is the real one:
 *
 *  - The user reads the *page*, not individual rows. A per-row model needs
 *    storage that grows forever to answer a question nobody asks.
 *  - This is a single-user app running on the user's own machine. A read mark
 *    is not data worth a table, a migration and a sync path.
 *
 * The initial state is deliberately `0` rather than the real count, and the
 * stored value is read in an effect. Reading `localStorage` during render
 * would produce a number on the client that the server could not have
 * produced, which is a hydration mismatch — the exact defect this codebase
 * just finished removing from the Browse hero. A badge that appears a frame
 * late is not worth reintroducing it.
 */
export function useUnreadNotifications(): {
  count: number;
  badge: string | null;
} {
  const [count, setCount] = useState(0);

  const compute = useCallback(async () => {
    try {
      const lastReadAt = localStorage.getItem(STORAGE_KEY);
      // Counted by the server, not by measuring a page of the feed. The old
      // implementation fetched `/api/activity` and counted what came back,
      // which meant the badge could never exceed one page — a 300-unread inbox
      // and a 50-unread inbox showed the same number.
      const res = await fetch(unreadCountUrl(lastReadAt), {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { count?: unknown };
      setCount(
        typeof json.count === "number" && json.count >= 0 ? json.count : 0,
      );
    } catch {
      // A badge is not worth an error state. If the count cannot be fetched
      // the nav simply shows no badge, which is the honest default: we do not
      // know of anything unread.
    }
  }, []);

  useEffect(() => {
    // `compute` only reaches `setCount` after awaiting a fetch, so this is not
    // the synchronous cascade the rule guards against — but the rule cannot
    // see past the async boundary. Same disable, and same reason, as the route
    // effect in `components/layout/mobile-nav.tsx`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void compute();
  }, [compute]);

  useEffect(() => {
    const onRead = () => setCount(0);
    window.addEventListener(READ_EVENT, onRead);
    return () => window.removeEventListener(READ_EVENT, onRead);
  }, []);

  return { count, badge: badgeText(count) };
}

/**
 * Marks the inbox read on mount. Rendered by the Notifications page.
 *
 * Writes storage and fires the event; it holds no state of its own, which is
 * why this does not set state synchronously inside an effect.
 */
export function MarkNotificationsRead() {
  useEffect(() => {
    markNotificationsRead();
  }, []);
  return null;
}
