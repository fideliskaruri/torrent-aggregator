import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { loadActivitySince } from "../feed";
import {
  INBOX_STATUSES,
  UNREAD_COUNT_CAP,
  buildInbox,
} from "@/app/notifications/inbox";

export const dynamic = "force-dynamic";

/**
 * How many notifications arrived after `?since=`.
 *
 * The badge used to be the length of `/api/activity`'s first page, so it could
 * never exceed the feed's page size no matter how much had happened — the cap
 * was an accident of pagination rather than a decision. This asks the database
 * the question directly: only inbox statuses, only rows newer than the read
 * mark, and never more than {@link UNREAD_COUNT_CAP} + 1 rows read per table,
 * which is all "99+" needs.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ count: 0, capped: false }, { status: 401 });
    }

    const raw = request.nextUrl.searchParams.get("since");
    const parsed = raw ? new Date(raw) : null;
    const since = parsed && Number.isFinite(parsed.getTime()) ? parsed : null;

    const { items, capped } = await loadActivitySince(
      prisma,
      session.user.id,
      since,
      INBOX_STATUSES,
      UNREAD_COUNT_CAP,
    );

    const notifications = buildInbox(
      items.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        message: item.message,
        createdAt: item.createdAt,
        infoHash: item.infoHash,
      })),
    );

    return NextResponse.json({
      count: Math.min(notifications.length, UNREAD_COUNT_CAP),
      capped: capped || notifications.length > UNREAD_COUNT_CAP,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message, count: 0, capped: false },
      { status: 500 },
    );
  }
}
