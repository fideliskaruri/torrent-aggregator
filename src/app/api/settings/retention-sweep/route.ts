import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getUserClientConfig } from "@/lib/clients";
import { primaryDownloadRoot } from "@/lib/download/path-containment";
import { STORAGE_SETUP_REQUIRED_MESSAGE } from "@/lib/library/disk-space";
import { getRetentionStorageUsage } from "@/lib/library/retention-settings";
import { sweepRetentionCache } from "@/lib/library/retention-sweep";
import { streamCacheBudgetForStorageCap } from "@/lib/streaming/retention";
import {
  enumField,
  numberField,
  readMutationObject,
  requestFailureResponse,
} from "@/lib/http/request";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsedBody = await readMutationObject(request, 16 * 1024);
    if (!parsedBody.ok) return requestFailureResponse(parsedBody);
    const mode = enumField(parsedBody.value, "mode", ["preview", "delete"] as const);
    if (!mode.ok) return requestFailureResponse(mode);
    const budgetBytes = numberField(parsedBody.value, "budgetBytes", {
      nullable: true,
      integer: true,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    });
    if (!budgetBytes.ok) return requestFailureResponse(budgetBytes);

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
      mode: mode.value === "delete" ? "delete" : "preview",
      budgetBytes:
        budgetBytes.value != null
          ? budgetBytes.value
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
        message: "The retention sweep failed. Check the server logs for details.",
      },
      { status: 500 },
    );
  }
}
