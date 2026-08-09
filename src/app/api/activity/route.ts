import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  loadActivityPage,
  type ActivityItem,
} from "./feed";

export const dynamic = "force-dynamic";

export type { ActivityItem };

/**
 * One page of activity.
 *
 * `?cursor=` is an opaque, URL-safe token echoed back from a previous
 * `nextCursor`. It encodes the `createdAt` **and** id of the last row the
 * caller already has, so a page boundary that lands inside a run of rows
 * written in the same millisecond is exact. Clients must not construct or
 * interpret it; an unrecognised cursor is ignored and the newest page served.
 * `?limit=` is clamped server-side. Older records are reachable by following
 * `nextCursor` until it is null — the page used to stop at the first 50 rows
 * because there was no way to ask for anything else.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized", items: [], count: 0, nextCursor: null, hasMore: false },
        { status: 401 },
      );
    }

    const params = request.nextUrl.searchParams;
    const filter = params.get("filter") === "sent" ? "sent" : "all";
    const page = await loadActivityPage(prisma, session.user.id, filter, {
      limit: params.get("limit"),
      cursor: params.get("cursor"),
    });

    return NextResponse.json({
      items: page.items,
      count: page.items.length,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message, items: [], count: 0, nextCursor: null, hasMore: false },
      { status: 500 },
    );
  }
}
