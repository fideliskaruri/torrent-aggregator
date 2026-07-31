import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  loadActivityItems,
  type ActivityItem,
} from "./feed";

export const dynamic = "force-dynamic";

export type { ActivityItem };

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized", items: [] },
        { status: 401 },
      );
    }

    const filter =
      request.nextUrl.searchParams.get("filter") === "sent" ? "sent" : "all";
    const items = await loadActivityItems(prisma, session.user.id, filter);

    return NextResponse.json({ items, count: items.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message, items: [], count: 0 },
      { status: 500 },
    );
  }
}
