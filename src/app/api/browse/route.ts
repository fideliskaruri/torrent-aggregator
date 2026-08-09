import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildBrowsePayload } from "@/lib/browse/rails";

export const dynamic = "force-dynamic";

/**
 * One round-trip payload for the Netflix-style home page.
 *
 * Returns typed rails — the personal ones first (Continue Watching, Ready to
 * Play, Next Up, My Library), then the discovery ones (Because you're
 * watching X, Trending now, Popular series). Empty rails are
 * omitted.
 *
 * The discovery rails read a cache that `@/lib/catalog/refresh` fills on a
 * timer, so this route does not fetch feeds per request. The one exception is
 * a genuinely cold cache — a brand-new install, where the alternative is
 * answering with an empty page — and even then the wait is capped and the
 * refresh continues in the background if it runs over.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await buildBrowsePayload(session.user.id);
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[browse]", err);
    return NextResponse.json(
      {
        error: "Failed to build browse payload",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
