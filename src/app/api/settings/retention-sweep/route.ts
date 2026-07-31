import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getUserClientConfig } from "@/lib/clients";
import { primaryDownloadRoot } from "@/lib/download/path-containment";
import { STORAGE_SETUP_REQUIRED_MESSAGE } from "@/lib/library/disk-space";
import { getRetentionStorageUsage } from "@/lib/library/retention-settings";
import { sweepRetentionCache } from "@/lib/library/retention-sweep";
import { streamCacheBudgetForStorageCap } from "@/lib/streaming/retention";

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
    const configuredBudget = streamCacheBudgetForStorageCap(
      config.maxStorageBytes,
    );
    if (configuredBudget == null) {
      return NextResponse.json(
        { error: "Storage setup required", message: STORAGE_SETUP_REQUIRED_MESSAGE },
        { status: 409 },
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
          : configuredBudget,
    });

    // The sweep only ever moves *tracked* bytes. Returning the reconciled
    // picture with it is what stops the panel from reporting a reclaim while
    // the folder total on screen stays stale — the exact disconnect that made
    // the cap unexplainable in the first place.
    const usage = await getRetentionStorageUsage(
      session.user.id,
      prisma,
      config.maxStorageBytes ?? null,
      primaryDownloadRoot(config),
    );

    return NextResponse.json({ ok: true, result, usage });
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
