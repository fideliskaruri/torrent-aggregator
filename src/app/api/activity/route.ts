import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export type ActivityItem = {
  id: string;
  type: "grab" | "history";
  title: string;
  status: string;
  message: string | null;
  source: string | null;
  kind: string | null;
  query: string | null;
  magnet: string | null;
  savePath: string | null;
  category: string | null;
  createdAt: string;
};

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
      savePath: null,
      category: null,
      createdAt: h.createdAt.toISOString(),
    }));

    // Merge by time; prefer grab jobs when near-duplicate of history (same magnet + second)
    const merged = [...grabItems, ...historyItems].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    // De-dupe: drop history entries that share magnet+status with a grab within 2 minutes
    const seen = new Set<string>();
    const items: ActivityItem[] = [];
    for (const item of merged) {
      const key =
        item.magnet && item.magnet.length > 20
          ? `${item.magnet.slice(0, 80)}|${item.status}`
          : null;
      if (key && item.type === "history" && seen.has(key)) continue;
      if (key && item.type === "grab") seen.add(key);
      items.push(item);
      if (items.length >= 50) break;
    }

    return NextResponse.json({ items, count: items.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message, items: [], count: 0 },
      { status: 500 },
    );
  }
}
