import { permanentRedirect } from "next/navigation";

import { NOTIFICATIONS_HREF } from "@/lib/navigation";

/**
 * `/activity` is now `/notifications`.
 *
 * Not only a rename. Activity was a wall of everything that had happened, which
 * is why it grew into something nobody read. Notifications is a quiet inbox:
 * completed downloads and terminal failures, retried and fallen back before the
 * user is ever told. The name is the promise the page has to keep.
 *
 * Redirected rather than removed — it was a header entry for the app's whole
 * life and will be bookmarked. `permanentRedirect` (308), not `redirect` (307),
 * because the move is permanent: the comment said so while the code issued a
 * temporary redirect, so bookmarks and history were never updated.
 */
export default function ActivityRedirect() {
  permanentRedirect(NOTIFICATIONS_HREF);
}
