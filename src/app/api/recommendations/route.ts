import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { libraryKey, recommendationsFor } from "@/lib/recommend";

export const dynamic = "force-dynamic";

/**
 * One rail, seeded from the library row the user touched most recently.
 *
 * Always 200. A missing rail is a normal answer here — no catalog id, no TMDB
 * key, a catalog outage — and the page renders nothing for it.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await prisma.watchListItem.findMany({
    where: { userId: session.user.id },
    orderBy: { updatedAt: "desc" },
    select: { title: true, mediaType: true, externalId: true, status: true },
  });

  const seed = items.find((i) => i.status === "watching");
  if (!seed) return NextResponse.json({ rail: null });

  const rail = await recommendationsFor(seed, new Set(items.map(libraryKey)));
  return NextResponse.json({ rail });
}
