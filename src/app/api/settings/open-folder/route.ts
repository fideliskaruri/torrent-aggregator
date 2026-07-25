import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getUserClientConfig } from "@/lib/clients";
import { resolveDownloadTarget } from "@/lib/clients";
import { isWithinLibrary, libraryRoots } from "@/lib/download/path-containment";

export const dynamic = "force-dynamic";

/**
 * Open a download folder on the machine running TorrentFlow.
 * Only useful when the app and downloads share the same filesystem (typical self-host).
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    path?: string | null;
    category?: string | null;
    /** When false, validate only — do not spawn Explorer/Finder (used by e2e). Default true. */
    reveal?: boolean;
  };

  // Never leave Explorer open during automated tests
  const shouldReveal =
    body.reveal !== false && process.env.PLAYWRIGHT_NO_REVEAL !== "1";

  const config = await getUserClientConfig(session.user.id);
  if (!config) {
    return NextResponse.json(
      { error: "Configure your torrent client in Settings first." },
      { status: 400 },
    );
  }

  const target = resolveDownloadTarget(config, {
    category: body.category,
    savePath: body.path,
  });

  let folder = (body.path || target.savePath || "").trim();
  if (!folder) {
    return NextResponse.json(
      {
        error: "No folder configured",
        message:
          "Set a default download folder or a per-category path in Settings.",
      },
      { status: 400 },
    );
  }

  // Normalize Windows-ish paths
  folder = folder.replace(/\//g, path.sep);

  // Security: only allow absolute paths; block traversal tricks
  if (!path.isAbsolute(folder) && !/^[a-zA-Z]:[\\/]/.test(folder)) {
    return NextResponse.json(
      {
        error: "Path must be absolute",
        message: `Got: ${folder}`,
      },
      { status: 400 },
    );
  }

  const resolved = path.resolve(folder);

  // Containment: this endpoint spawns the OS file manager, and the app has no
  // sign-in, so only folders inside the user's own library may be revealed.
  const roots = libraryRoots(config);
  if (!isWithinLibrary(resolved, roots)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Path is outside your download folders",
        message:
          "TorrentFlow only opens folders inside your configured download locations. Add this location in Settings first.",
        pathOnly: resolved,
      },
      { status: 403 },
    );
  }

  if (!fs.existsSync(resolved)) {
    // Try parent if file path was given
    const parent = path.dirname(resolved);
    if (
      isWithinLibrary(parent, roots) &&
      fs.existsSync(parent) &&
      fs.statSync(parent).isDirectory()
    ) {
      return openPath(parent, resolved, shouldReveal);
    }
    return NextResponse.json(
      {
        ok: false,
        error: "Folder not found on this machine",
        path: resolved,
        message:
          "The path must exist on the server running TorrentFlow. If your torrent client is remote/Docker, open the folder on that host instead.",
        pathOnly: resolved,
      },
      { status: 404 },
    );
  }

  return openPath(resolved, resolved, shouldReveal);
}

async function openPath(
  folder: string,
  displayPath: string,
  reveal = true,
) {
  try {
    if (reveal) {
      await revealInFileManager(folder);
    }
    return NextResponse.json({
      ok: true,
      path: displayPath,
      message: reveal
        ? `Opened ${displayPath}`
        : `Verified folder ${displayPath}`,
      revealed: reveal,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        path: displayPath,
        error: "Could not open folder",
        message: err instanceof Error ? err.message : String(err),
        pathOnly: displayPath,
      },
      { status: 500 },
    );
  }
}

function revealInFileManager(folder: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let cmd: string;
    let args: string[];

    if (platform === "win32") {
      cmd = "explorer.exe";
      args = [folder];
    } else if (platform === "darwin") {
      cmd = "open";
      args = [folder];
    } else {
      cmd = "xdg-open";
      args = [folder];
    }

    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.unref();
    // explorer returns non-zero sometimes even on success
    setTimeout(() => resolve(), 200);
  });
}
