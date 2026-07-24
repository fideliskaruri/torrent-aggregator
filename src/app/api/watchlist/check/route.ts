import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkWatchlistReleases } from "@/lib/watchlist/check-releases";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const updates = await checkWatchlistReleases(session.user.id);
  return NextResponse.json({ updates });
}
