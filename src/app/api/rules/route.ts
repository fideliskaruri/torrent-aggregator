import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { runAutoRules } from "@/lib/rules/runner";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rules = await prisma.autoRule.findMany({
    where: { userId: session.user.id },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({
    rules: rules.map((r) => ({
      ...r,
      maxSizeBytes: r.maxSizeBytes != null ? Number(r.maxSizeBytes) : null,
    })),
  });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    name?: string;
    query?: string;
    category?: string;
    minSeeders?: number;
    maxSizeBytes?: number | null;
    resolution?: string | null;
    sources?: string | null;
    enabled?: boolean;
    run?: boolean;
  };

  if (!body.name?.trim() || !body.query?.trim()) {
    return NextResponse.json(
      { error: "name and query are required" },
      { status: 400 },
    );
  }

  const rule = await prisma.autoRule.create({
    data: {
      userId: session.user.id,
      name: body.name.trim(),
      query: body.query.trim(),
      category: body.category ?? "all",
      minSeeders: body.minSeeders ?? 10,
      maxSizeBytes:
        body.maxSizeBytes != null ? BigInt(body.maxSizeBytes) : null,
      resolution: body.resolution ?? null,
      sources: body.sources ?? null,
      enabled: body.enabled ?? true,
    },
  });

  let runResult = null;
  if (body.run) {
    try {
      runResult = await runAutoRules(session.user.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const offline =
        /econnrefused|unreachable|fetch failed|timeout|not listening|cannot reach/i.test(
          message,
        );
      return NextResponse.json(
        {
          rule: {
            ...rule,
            maxSizeBytes:
              rule.maxSizeBytes != null ? Number(rule.maxSizeBytes) : null,
          },
          runResult: null,
          ok: false,
          offline,
          error: offline ? "Client offline" : "Rules run failed",
          message: offline
            ? "Cannot reach torrent client. Is it running? Check Host URL in Settings."
            : message,
        },
        { status: offline ? 503 : 500 },
      );
    }
  }

  return NextResponse.json({
    rule: {
      ...rule,
      maxSizeBytes: rule.maxSizeBytes != null ? Number(rule.maxSizeBytes) : null,
    },
    runResult,
  });
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    id?: string;
    name?: string;
    query?: string;
    category?: string;
    minSeeders?: number;
    maxSizeBytes?: number | null;
    resolution?: string | null;
    sources?: string | null;
    enabled?: boolean;
  };

  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const updated = await prisma.autoRule.updateMany({
    where: { id: body.id, userId: session.user.id },
    data: {
      name: body.name,
      query: body.query,
      category: body.category,
      minSeeders: body.minSeeders,
      maxSizeBytes:
        body.maxSizeBytes === undefined
          ? undefined
          : body.maxSizeBytes == null
            ? null
            : BigInt(body.maxSizeBytes),
      resolution: body.resolution,
      sources: body.sources,
      enabled: body.enabled,
    },
  });

  if (updated.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rule = await prisma.autoRule.findUnique({ where: { id: body.id } });
  return NextResponse.json({
    rule: rule
      ? {
          ...rule,
          maxSizeBytes:
            rule.maxSizeBytes != null ? Number(rule.maxSizeBytes) : null,
        }
      : null,
  });
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  await prisma.autoRule.deleteMany({
    where: { id, userId: session.user.id },
  });

  return NextResponse.json({ ok: true });
}
