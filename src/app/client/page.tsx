import { redirect } from "next/navigation";

import { DOWNLOADS_HREF } from "@/lib/navigation";

/**
 * `/client` is now `/downloads`.
 *
 * The page did not change; its name did. "Client" described the subsystem —
 * the thing that talks BitTorrent — rather than what the user came to see,
 * which is whether their download finished.
 *
 * A permanent redirect rather than a deletion: this route has been linked from
 * the header since the app existed, so it is in bookmarks and in muscle
 * memory. Breaking it to save one file would be a poor trade.
 */
export default function ClientRedirect() {
  redirect(DOWNLOADS_HREF);
}
