import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getClient, getUserClientConfig } from "@/lib/clients";
import { pruneEmptyParents } from "@/lib/clients/prune-empty-parents";
import { workIdentityFor, workKeyFor, workKeyMatches } from "@/components/title/work-key";
import {
  deletionPlanSummary,
  heldFilesFromVerifiedJson,
  makeDeletionScope,
  planDeletion,
  type DeletionPlan,
  type DeletionScope,
  type HeldFile,
  type HeldTorrent,
} from "@/lib/library/deletion-plan";
import { resetDiskInventoryCache } from "@/lib/library/disk-inventory";
import { resetDirectorySizeCache } from "@/lib/library/disk-space";
import { resetLocalFilePresenceCache } from "@/lib/library/local-file-presence";
import {
  booleanField,
  enumField,
  guardBrowserMutation,
  numberField,
  queryNumber,
  queryString,
  readMutationObject,
  requestFailureResponse,
  stringField,
} from "@/lib/http/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Delete downloaded media for one library title, at show / season / episode
 * granularity.
 *
 * ## Why this is a separate endpoint from `DELETE /api/watchlist`
 *
 * Because they are separate decisions, and merging them is how a user loses
 * files. Removing a title from the Library is a bookkeeping change people make
 * casually — a show they finished, a film they are no longer chasing — and it
 * keeps every byte. Removing the bytes is irreversible and gets its own
 * endpoint, its own confirmation, and a plan the user reads first.
 *
 * ## GET plans, POST acts
 *
 * `GET` computes the plan and removes nothing. It exists so the confirm dialog
 * can state the file count and the size *before* there is anything to confirm —
 * the requirement being that no one can press the button without having been
 * shown the number.
 *
 * `POST` requires `confirm: true` and refuses with 400 otherwise. That is not
 * belt-and-braces over the dialog: it means a mis-wired client, a replayed
 * request, or a stray fetch cannot delete anything, because the confirmation is
 * a property of the request rather than of the UI that sent it.
 *
 * ## The plan is recomputed server-side, always
 *
 * The client sends a work and a scope. It never sends a file list, a path or a
 * hash. Everything that authorises a delete — ownership of the library row,
 * which releases belong to the work, whether the scope contains them — is
 * derived here from the database, exactly as `settings/untracked-files` does
 * for orphan removal. A path from a client is a claim, not a fact.
 */

/** Rows the plan is built from. Kept narrow so the shape is obvious. */
const ENGINE_SELECT = {
  hash: true,
  name: true,
  savePath: true,
  sizeBytes: true,
  verifiedFilesJson: true,
} as const;

/**
 * `exists` / `missing` / `unknown`, never a bare boolean.
 *
 * Same discipline as `local-file-presence.ts`: an unreadable directory is not
 * evidence that a file is gone. Collapsing `unknown` into `missing` would drop
 * real bytes out of the size shown on the confirm dialog, which is the one
 * number the user is being asked to judge.
 */
function statPresence(target: string): HeldFile["presence"] {
  try {
    return fs.statSync(target, { throwIfNoEntry: false }) ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

/**
 * Every release the engine holds for this work.
 *
 * Identity goes through `workIdentityFor` + `workKeyMatches`, the same funnel
 * the title page uses — a delete that disagreed with the page about which
 * releases belong to a work would remove something the user was looking at
 * somewhere else. The library row states no year, so this can over-reach onto a
 * same-named work (the documented `Dune` case in `work-key.ts`); the response
 * therefore names every release, and the dialog prints them, so nothing is
 * removed that the user has not read the name of.
 */
async function heldForWork(
  userId: string,
  title: string,
): Promise<{ held: HeldTorrent[]; savePaths: Map<string, string> }> {
  const identity = workIdentityFor(title);
  const key = workKeyFor(identity.name, identity.year);
  const rows = await prisma.engineTorrent.findMany({
    where: { userId, status: { not: "removed" } },
    select: ENGINE_SELECT,
    take: 500,
  });

  const held: HeldTorrent[] = [];
  const savePaths = new Map<string, string>();
  for (const row of rows) {
    const rowIdentity = workIdentityFor(row.name);
    if (!workKeyMatches(key, rowIdentity.name, rowIdentity.year)) continue;

    const files = heldFilesFromVerifiedJson(row.verifiedFilesJson).map((file) => ({
      ...file,
      presence: statPresence(file.path),
    }));
    held.push({
      hash: row.hash,
      name: row.name,
      allocatedBytes: Number(row.sizeBytes),
      files,
    });
    const save = row.savePath?.trim();
    if (save) savePaths.set(row.hash, save);
  }
  return { held, savePaths };
}

function planPayload(plan: DeletionPlan) {
  return {
    scope: plan.scope,
    outcome: plan.outcome,
    fileCount: plan.fileCount,
    totalBytes: plan.totalBytes,
    missingFileCount: plan.missingFiles.length,
    releases: plan.releases.map((release) => ({
      name: release.name,
      fileCount: release.fileCount,
      bytes: release.bytes,
      filesRecorded: release.filesRecorded,
    })),
    blocked: plan.blocked.map((entry) => ({
      name: entry.name,
      reason: entry.reason,
      covers: entry.covers,
      fileCount: entry.fileCount,
      bytes: entry.bytes,
    })),
    summary: deletionPlanSummary(plan),
  };
}

/** The library row, proven to belong to this session. */
async function ownedItem(userId: string, watchListItemId: string) {
  return prisma.watchListItem.findFirst({
    where: { id: watchListItemId, userId },
    select: { id: true, title: true, mediaType: true },
  });
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const idResult = queryString(params, "watchListItemId", {
    required: true,
    maxLength: 128,
  });
  if (!idResult.ok) return requestFailureResponse(idResult);
  const scopeKind = queryString(params, "scope", {
    required: true,
    allowed: ["show", "season", "episode"],
  });
  if (!scopeKind.ok) return requestFailureResponse(scopeKind);
  const season = queryNumber(params, "season", { integer: true, min: 1, max: 10_000 });
  if (!season.ok) return requestFailureResponse(season);
  const episode = queryNumber(params, "episode", { integer: true, min: 1, max: 100_000 });
  if (!episode.ok) return requestFailureResponse(episode);

  const scope = makeDeletionScope(scopeKind.value, season.value ?? null, episode.value ?? null);
  if (!scope) return badScope();

  const item = await ownedItem(session.user.id, idResult.value ?? "");
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { held } = await heldForWork(session.user.id, item.title);
  return NextResponse.json({
    ok: true,
    title: item.title,
    plan: planPayload(planDeletion(held, scope)),
  });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Stated here as well as inside `readMutationObject`, which also calls it.
  // This is the most destructive endpoint in the app and the guard that keeps a
  // cross-site page out of it should be visible in the first lines of the
  // handler, not inherited from a helper three files away.
  const origin = guardBrowserMutation(request);
  if (!origin.ok) return requestFailureResponse(origin);

  const parsedBody = await readMutationObject(request);
  if (!parsedBody.ok) return requestFailureResponse(parsedBody);
  const fields = parsedBody.value;

  const watchListItemId = stringField(fields, "watchListItemId", {
    required: true,
    maxLength: 128,
  });
  if (!watchListItemId.ok) return requestFailureResponse(watchListItemId);
  const scopeKind = enumField(fields, "scope", ["show", "season", "episode"] as const, {
    required: true,
  });
  if (!scopeKind.ok) return requestFailureResponse(scopeKind);
  const season = numberField(fields, "season", {
    nullable: true,
    integer: true,
    min: 1,
    max: 10_000,
  });
  if (!season.ok) return requestFailureResponse(season);
  const episode = numberField(fields, "episode", {
    nullable: true,
    integer: true,
    min: 1,
    max: 100_000,
  });
  if (!episode.ok) return requestFailureResponse(episode);
  const confirm = booleanField(fields, "confirm");
  if (!confirm.ok) return requestFailureResponse(confirm);

  // Checked before anything is read, let alone removed. An unconfirmed request
  // is not a request to delete, so it must not even be costed.
  if (confirm.value !== true) {
    return NextResponse.json(
      {
        ok: false,
        error: "Confirmation required",
        message:
          "Deleting files needs `confirm: true`. Ask for the plan with GET first and show the file count and size.",
        reason: "unconfirmed",
      },
      { status: 400 },
    );
  }

  const scope = makeDeletionScope(scopeKind.value, season.value ?? null, episode.value ?? null);
  if (!scope) return badScope();

  const item = await ownedItem(session.user.id, watchListItemId.value ?? "");
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const config = await getUserClientConfig(session.user.id);
  if (!config) {
    return NextResponse.json(
      {
        ok: false,
        error: "No torrent client configured",
        message: "Set up downloads in Settings before deleting files.",
      },
      { status: 400 },
    );
  }
  const client = getClient(config.clientType);
  if (!client.deleteTorrent) {
    return NextResponse.json(
      {
        ok: false,
        error: "Client cannot delete",
        message: "The configured download client cannot remove files.",
      },
      { status: 400 },
    );
  }

  const { held, savePaths } = await heldForWork(session.user.id, item.title);
  const plan = planDeletion(held, scope);

  // Nothing to do, or nothing this scope is allowed to do. Both are a conflict
  // with the current state rather than a bad request, and both carry the
  // summary — a refusal the user cannot read is indistinguishable from a bug.
  if (plan.outcome !== "deletes") {
    return NextResponse.json(
      {
        ok: false,
        error: plan.outcome === "blocked" ? "Refused" : "Nothing to delete",
        message: deletionPlanSummary(plan),
        reason: plan.outcome,
        plan: planPayload(plan),
      },
      { status: 409 },
    );
  }

  const deleted: Array<{ name: string; bytes: number; fileCount: number }> = [];
  const failed: Array<{ name: string; message: string }> = [];
  let freedBytes = 0;
  let freedFiles = 0;

  for (const release of plan.releases) {
    let result: { ok: boolean; message: string };
    try {
      result = await client.deleteTorrent(config, release.hash, true);
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (!result.ok) {
      failed.push({ name: release.name, message: result.message });
      continue;
    }

    // The built-in engine removes its own row inside `deleteTorrent`; external
    // clients do not. Doing it here as well is idempotent, and skipping it for
    // qBittorrent/Transmission would leave a row claiming files that are gone —
    // exactly the stale claim `local-file-presence.ts` exists to clean up after.
    try {
      await prisma.engineTorrent.deleteMany({
        where: { userId: session.user.id, hash: release.hash },
      });
    } catch {
      /* the files are gone; a stale row is recoverable, a lost file is not */
    }

    const leaf = savePaths.get(release.hash);
    const base = config.baseDownloadPath?.trim();
    if (leaf && base) {
      try {
        pruneEmptyParents(leaf, base);
      } catch {
        /* an empty folder left behind is cosmetic */
      }
    }

    deleted.push({
      name: release.name,
      bytes: release.bytes,
      fileCount: release.fileCount,
    });
    freedBytes += release.bytes;
    freedFiles += release.fileCount;
  }

  // Every memo that counts bytes under the download root now over-reports, and
  // the presence cache still says files exist. Left stale, the next Play is
  // refused by a storage cap measured against files that are no longer there.
  resetDirectorySizeCache();
  resetDiskInventoryCache();
  resetLocalFilePresenceCache();

  return NextResponse.json({
    ok: failed.length === 0,
    // Reports what actually happened, not what was planned. A partial failure
    // that claimed the planned total would tell the user they had freed space
    // they still do not have.
    freedBytes,
    freedFiles,
    deleted,
    failed,
    plan: planPayload(plan),
  });
}

function badScope(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "Invalid scope",
      message:
        "A season scope needs `season`, and an episode scope needs `season` and `episode`.",
      reason: "bad-scope",
    },
    { status: 400 },
  );
}

export type { DeletionScope };
