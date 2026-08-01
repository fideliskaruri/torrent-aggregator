import { NextRequest, NextResponse } from "next/server";
import fsp from "node:fs/promises";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getUserClientConfig } from "@/lib/clients";
import { primaryDownloadRoot } from "@/lib/download/path-containment";
import {
  resetDiskInventoryCache,
  resolveOrphanTarget,
  type OrphanTargetRefusal,
} from "@/lib/library/disk-inventory";
import { resetDirectorySizeCache } from "@/lib/library/disk-space";
import {
  getRetentionStorageUsage,
  trackedTorrentRefs,
} from "@/lib/library/retention-settings";
import {
  readMutationObject,
  requestFailureResponse,
  stringField,
} from "@/lib/http/request";

export const dynamic = "force-dynamic";

/**
 * Remove ONE untracked entry from the download folder.
 *
 * ## Why this exists
 *
 * The owner had 40.42 GB under the download root, zero live transfers on the
 * Client page, and no control anywhere in the product that could remove the
 * difference. Making those bytes visible without making them removable would
 * only have told them the bad news more precisely.
 *
 * ## Why it is this cautious
 *
 * The request body carries a path, and a path from a client is a claim, not a
 * fact. Everything that authorises the delete is recomputed here, server-side,
 * by {@link resolveOrphanTarget}:
 *
 *  - the path must be *relative* — no absolute path, drive letter, UNC share, or
 *    `..` segment survives;
 *  - it is resolved through `realpath`, so a junction or symlink planted inside
 *    the root that points at `C:\Windows` fails containment;
 *  - dot-prefixed top-level entries are TorrentFlow's own bookkeeping and are
 *    refused outright;
 *  - a file any live `EngineTorrent` row owns is refused, and so is a folder
 *    that still contains one;
 *  - a folder is refused unless its full inventory is authoritative, because a
 *    truncated, unreadable, or stat-failed walk cannot prove there is no live
 *    file underneath.
 *
 * One entry per request. There is deliberately no "clean everything", and the
 * download root itself can never be the target.
 */

/** How a refusal maps to HTTP, so a client never has to parse prose. */
const REFUSAL_STATUS: Record<OrphanTargetRefusal, number> = {
  "no-root": 400,
  "empty-path": 400,
  "not-relative": 403,
  "escapes-root": 403,
  "is-root": 403,
  internal: 403,
  missing: 404,
  tracked: 409,
  "contains-tracked": 409,
  "inventory-incomplete": 409,
  "unsupported-type": 400,
};

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsedBody = await readMutationObject(request, 16 * 1024);
    if (!parsedBody.ok) return requestFailureResponse(parsedBody);
    const relativePathResult = stringField(parsedBody.value, "relativePath", {
      required: true,
      maxLength: 4096,
    });
    if (!relativePathResult.ok) return requestFailureResponse(relativePathResult);
    const relativePath = relativePathResult.value ?? "";
    if (!relativePath) {
      return NextResponse.json(
        {
          ok: false,
          error: "No entry named",
          message: "Name the untracked file or folder to remove.",
          reason: "empty-path",
        },
        { status: 400 },
      );
    }

    const config = await getUserClientConfig(session.user.id);
    if (!config) {
      return NextResponse.json(
        { ok: false, error: "No download client configured" },
        { status: 400 },
      );
    }

    const root = primaryDownloadRoot(config);
    if (!root) {
      return NextResponse.json(
        {
          ok: false,
          error: "No download folder configured",
          message:
            "Choose a download folder in Settings → Downloads before removing files.",
          reason: "no-root",
        },
        { status: 400 },
      );
    }

    const tracked = await trackedTorrentRefs(session.user.id, prisma);
    const target = await resolveOrphanTarget({ root, relativePath, tracked });
    if (!target.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Refused to remove that entry",
          message: target.message,
          reason: target.reason,
        },
        { status: REFUSAL_STATUS[target.reason] },
      );
    }

    try {
      await fsp.rm(target.path, {
        recursive: target.kind === "directory",
        force: false,
      });
    } catch (err) {
      console.error("[settings/untracked-files POST] delete failed:", err);
      return NextResponse.json(
        {
          ok: false,
          error: "Could not remove that entry",
          message: "The server could not remove that entry.",
          reason: "delete-failed",
        },
        { status: 500 },
      );
    }

    // Both the storage cap's directory size and the inventory now over-report.
    resetDirectorySizeCache();
    resetDiskInventoryCache();

    const usage = await getRetentionStorageUsage(
      session.user.id,
      prisma,
      config.maxStorageBytes ?? null,
      root,
    );

    return NextResponse.json({
      ok: true,
      deleted: {
        relativePath: target.relativePath,
        kind: target.kind,
        bytes: target.bytes,
        fileCount: target.fileCount,
      },
      usage,
    });
  } catch (err) {
    console.error("[settings/untracked-files POST]", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to remove untracked entry",
        message: "The untracked entry could not be removed. Check the server logs.",
      },
      { status: 500 },
    );
  }
}
