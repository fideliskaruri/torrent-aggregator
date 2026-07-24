import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export interface BrowseFolderEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

function listWindowsDrives(): BrowseFolderEntry[] {
  const drives: BrowseFolderEntry[] = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) {
        drives.push({
          name: `${letter}:`,
          path: root,
          isDirectory: true,
        });
      }
    } catch {
      // skip inaccessible drive letters
    }
  }
  return drives;
}

function isAbsolutePath(p: string): boolean {
  if (path.isAbsolute(p)) return true;
  // Windows drive root like C:\ or C:/
  return /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * GET /api/settings/browse-folders?path=
 * Lists directories only for an absolute path.
 * On Windows with empty path, returns drive letters.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const raw = request.nextUrl.searchParams.get("path") ?? "";
    const requested = raw.trim();

    // Empty path: Windows → drives; Unix → root
    if (!requested) {
      if (process.platform === "win32") {
        return NextResponse.json({
          path: "",
          parent: null,
          entries: listWindowsDrives(),
        });
      }
      return listDir("/");
    }

    if (!isAbsolutePath(requested)) {
      return NextResponse.json(
        { error: "Path must be absolute" },
        { status: 400 },
      );
    }

    // Normalize and resolve (collapses .. segments)
    let resolved: string;
    try {
      resolved = path.resolve(requested.replace(/\//g, path.sep));
    } catch {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    // Block path that somehow isn't absolute after resolve
    if (!path.isAbsolute(resolved) && !/^[a-zA-Z]:[\\/]/.test(resolved)) {
      return NextResponse.json(
        { error: "Path must be absolute" },
        { status: 400 },
      );
    }

    return listDir(resolved);
  } catch (err) {
    console.error("[browse-folders]", err);
    return NextResponse.json(
      {
        error: "Failed to browse folders",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

function listDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    return NextResponse.json(
      { error: "Path not found", path: dirPath },
      { status: 404 },
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dirPath);
  } catch {
    return NextResponse.json(
      { error: "Cannot access path", path: dirPath },
      { status: 403 },
    );
  }

  if (!stat.isDirectory()) {
    return NextResponse.json(
      { error: "Path is not a directory", path: dirPath },
      { status: 400 },
    );
  }

  let names: string[];
  try {
    names = fs.readdirSync(dirPath);
  } catch {
    return NextResponse.json(
      { error: "Cannot read directory", path: dirPath },
      { status: 403 },
    );
  }

  const entries: BrowseFolderEntry[] = [];
  for (const name of names) {
    // Skip hidden / system-ish names that often cause permission noise
    if (name === "." || name === "..") continue;
    const full = path.join(dirPath, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        entries.push({
          name,
          path: full,
          isDirectory: true,
        });
      }
    } catch {
      // skip unreadable entries
    }
  }

  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  const parent = parentPath(dirPath);

  return NextResponse.json({
    path: dirPath,
    parent,
    entries,
  });
}

function parentPath(dirPath: string): string | null {
  if (process.platform === "win32") {
    // Drive root e.g. C:\ → go to drive list (empty path)
    const normalized = path.resolve(dirPath);
    const root = path.parse(normalized).root;
    if (normalized === root || /^[a-zA-Z]:\\?$/.test(normalized)) {
      return "";
    }
  } else if (dirPath === "/" || path.resolve(dirPath) === "/") {
    return null;
  }

  const parent = path.dirname(dirPath);
  if (parent === dirPath) return null;
  return parent;
}
