import type { BrowsePayload } from "@/lib/browse";
import { auth } from "@/lib/auth";
import { buildBrowsePayload } from "@/lib/browse";

/**
 * The one place the browse UI touches the browse data layer.
 *
 * Called directly rather than through `GET /api/browse`: the page is already
 * server-rendered on the same process, so an HTTP round trip to ourselves would
 * add a connection, a serialisation pass and an auth check for nothing. The
 * route still exists for clients that need it — this is the same function it
 * calls, so the two can never disagree.
 *
 * A failure is reported, never swallowed. The previous version caught
 * everything and returned an empty payload with a `degraded` flag that the UI
 * spent as a change of wording on the *empty* state — which is to say it told
 * a user whose database was unreachable that they own nothing. `error` carries
 * the reason up so the page can render a failure as a failure, with a retry.
 */
export interface BrowseSource {
  payload: BrowsePayload;
  /** Why the payload could not be built, or null. Never a silent empty. */
  error: string | null;
}

export async function loadBrowsePayload(): Promise<BrowseSource> {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    // Signed out is not a failure. It is a first-run page for a user who has
    // not identified themselves yet, and alarming them would be wrong.
    if (!userId) return { payload: emptyPayload(), error: null };

    return { payload: await buildBrowsePayload(userId), error: null };
  } catch (err) {
    console.error("[browse-ui] payload unavailable", err);
    return {
      payload: emptyPayload(),
      error:
        err instanceof Error
          ? err.message
          : "The browse payload could not be assembled.",
    };
  }
}

function emptyPayload(): BrowsePayload {
  return { rails: [], generatedAt: new Date().toISOString() };
}
