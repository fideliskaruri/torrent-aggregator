import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig } from "@/lib/clients";
import { sweepRetentionCache } from "@/lib/library/retention-sweep";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: {
      mode?: "preview" | "delete";
      budgetBytes?: number | null;
    } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }

    const config = await getUserClientConfig(session.user.id);
    if (!config) {
      return NextResponse.json(
        { error: "No download client configured" },
        { status: 400 },
      );
    }

    const result = await sweepRetentionCache({
      userId: session.user.id,
      config,
      mode: body.mode === "delete" ? "delete" : "preview",
      budgetBytes:
        body.budgetBytes != null &&
        Number.isFinite(body.budgetBytes) &&
        body.budgetBytes > 0
          ? body.budgetBytes
          : undefined,
    });

    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[settings/retention-sweep POST]", err);
    return NextResponse.json(
      {
        error: "Failed to run retention sweep",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
