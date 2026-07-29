import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await prisma.downloadHistory.findMany({
    // Streams are ephemeral Play cache, not downloads — keep them out of the
    // history list; legacy NULL rows still show (issue E).
    where: { userId: session.user.id, retention: { not: "stream" } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({ items });
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = request.nextUrl.searchParams.get("id");
  if (id) {
    await prisma.downloadHistory.deleteMany({
      where: { id, userId: session.user.id },
    });
  } else {
    await prisma.downloadHistory.deleteMany({
      where: { userId: session.user.id },
    });
  }

  return NextResponse.json({ ok: true });
}
