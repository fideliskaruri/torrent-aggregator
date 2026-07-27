import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  infoHashFromMagnet,
  deduplicateActivity,
  type ActivityItem,
} from "@/lib/activity/dedup";

export const dynamic = "force-dynamic";

export type { ActivityItem };

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized", items: [] },
        { status: 401 },
      );
    }

    const userId = session.user.id;

    const [jobs, history] = await Promise.all([
      prisma.grabJob.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.downloadHistory.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);

    const grabItems: ActivityItem[] = jobs.map((j) => ({
      id: `grab-${j.id}`,
      type: "grab" as const,
      title: j.title,
      status: j.status,
      message: j.message,
      source: j.source,
      kind: j.kind,
      query: j.query,
      magnet: j.magnet,
      infoHash: j.infoHash ?? infoHashFromMagnet(j.magnet),
      savePath: j.savePath,
      category: j.category,
      createdAt: j.createdAt.toISOString(),
    }));

    const historyItems: ActivityItem[] = history.map((h) => ({
      id: `hist-${h.id}`,
      type: "history" as const,
      title: h.title,
      status: h.status,
      message: h.message,
      source: h.source,
      kind: null,
      query: null,
      magnet: h.magnet,
      infoHash: h.infoHash ?? infoHashFromMagnet(h.magnet),
      savePath: null,
      category: null,
      createdAt: h.createdAt.toISOString(),
    }));

    const merged = [...grabItems, ...historyItems].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const items = deduplicateActivity(merged, 50);

    return NextResponse.json({ items, count: items.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message, items: [], count: 0 },
      { status: 500 },
    );
  }
}
