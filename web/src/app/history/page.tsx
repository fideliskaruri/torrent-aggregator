import { NotificationsView } from "@/app/notifications/page";

/**
 * The download log: Notifications filtered to what was sent.
 *
 * Still its own route rather than a tab, because it is a *log* — the place you
 * go to answer "did I already grab this?" — and that question deserves a URL
 * you can bookmark. It has no nav entry; it is reached from Notifications.
 */
export default function HistoryPage() {
  return <NotificationsView sentOnly />;
}
