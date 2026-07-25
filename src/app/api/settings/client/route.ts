import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  externalClientConfig,
  testClientConnection,
  type ClientConnectionConfig,
} from "@/lib/clients";
import {
  DEFAULT_CATEGORIES,
  ensureDefaultClientSettings,
  defaultDownloadDir,
} from "@/lib/clients/defaults";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(
  raw: string | null | undefined,
): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string" && val.trim()) out[k] = val.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function publicSettings(settings: {
  clientType: string;
  externalClientType?: string | null;
  host: string;
  username: string | null;
  password: string | null;
  category: string | null;
  savePath: string | null;
  baseDownloadPath: string | null;
  maxStorageBytes?: bigint | number | null;
  categories: string | null;
  pathRules: string | null;
}) {
  const categories = parseJsonArray(settings.categories);
  const external =
    settings.externalClientType === "qbittorrent" ||
    settings.externalClientType === "transmission"
      ? settings.externalClientType
      : null;
  const maxRaw = settings.maxStorageBytes;
  const maxStorageBytes =
    maxRaw == null
      ? null
      : typeof maxRaw === "bigint"
        ? Number(maxRaw)
        : Number(maxRaw);
  const maxStorageGb =
    maxStorageBytes != null && Number.isFinite(maxStorageBytes)
      ? Math.round((maxStorageBytes / 1e9) * 10) / 10
      : null;
  return {
    clientType: settings.clientType,
    externalClientType: external,
    host: settings.host,
    username: settings.username,
    hasPassword: Boolean(settings.password),
    category: settings.category,
    savePath: settings.savePath,
    baseDownloadPath: settings.baseDownloadPath,
    maxStorageBytes:
      maxStorageBytes != null && Number.isFinite(maxStorageBytes)
        ? maxStorageBytes
        : null,
    maxStorageGb,
    categories: categories.length ? categories : DEFAULT_CATEGORIES,
    pathRules: parseJsonRecord(settings.pathRules),
    hasExternal: Boolean(external),
  };
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const settings = await ensureDefaultClientSettings(session.user.id);

    return NextResponse.json({
      settings: publicSettings(settings),
      defaults: {
        categories: DEFAULT_CATEGORIES,
        baseDownloadPath: defaultDownloadDir(),
        clientType: "builtin",
      },
    });
  } catch (err) {
    console.error("[settings/client GET]", err);
    return NextResponse.json(
      {
        error: "Failed to load settings",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: {
      clientType?: string;
      externalClientType?: string | null;
      host?: string;
      username?: string | null;
      password?: string | null;
      category?: string | null;
      savePath?: string | null;
      baseDownloadPath?: string | null;
      /** Max download library size in GB (converted to maxStorageBytes). */
      maxStorageGb?: number | null;
      maxStorageBytes?: number | null;
      categories?: string[] | null;
      pathRules?: Record<string, string> | null;
      test?: boolean;
      /** Which connection to test: primary or external */
      testTarget?: "primary" | "external";
      /** One-click: make builtin primary, keep current external creds */
      switchToBuiltin?: boolean;
    };

    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const existing = await prisma.clientSettings.findUnique({
      where: { userId: session.user.id },
    });

    // One-click recovery from offline external primary
    if (body.switchToBuiltin) {
      const prevType = (existing?.clientType || "").toLowerCase();
      const keepExternal =
        existing?.externalClientType ||
        (prevType === "qbittorrent" || prevType === "transmission"
          ? prevType
          : null);
      const settings = await prisma.clientSettings.upsert({
        where: { userId: session.user.id },
        create: {
          userId: session.user.id,
          clientType: "builtin",
          externalClientType: keepExternal,
          host: existing?.host || "http://127.0.0.1:8080",
          username: existing?.username ?? null,
          password: existing?.password ?? null,
          category: existing?.category ?? null,
          savePath: existing?.savePath ?? null,
          baseDownloadPath:
            existing?.baseDownloadPath ?? defaultDownloadDir(),
          categories:
            existing?.categories ?? JSON.stringify(DEFAULT_CATEGORIES),
          pathRules: existing?.pathRules ?? null,
        },
        update: {
          clientType: "builtin",
          externalClientType: keepExternal,
        },
      });
      return NextResponse.json({
        settings: publicSettings(settings),
        message:
          "Switched to built-in engine. External client kept for optional Send to my client.",
      });
    }

    const clientType =
      body.clientType || existing?.clientType || "builtin";
    if (!["qbittorrent", "transmission", "builtin"].includes(clientType)) {
      return NextResponse.json({ error: "Invalid clientType" }, { status: 400 });
    }

    let externalClientType: string | null;
    if (body.externalClientType !== undefined) {
      if (
        body.externalClientType === null ||
        body.externalClientType === "" ||
        body.externalClientType === "none"
      ) {
        externalClientType = null;
      } else if (
        body.externalClientType === "qbittorrent" ||
        body.externalClientType === "transmission"
      ) {
        externalClientType = body.externalClientType;
      } else {
        return NextResponse.json(
          { error: "Invalid externalClientType" },
          { status: 400 },
        );
      }
    } else {
      externalClientType = existing?.externalClientType ?? null;
    }

    // If user picks external as primary, clear redundant external dual (or keep same)
    if (clientType === "qbittorrent" || clientType === "transmission") {
      // Primary is external — dual external only makes sense for a *different* type;
      // keep simple: when primary is external, externalClientType unused
      if (body.externalClientType === undefined) {
        externalClientType = null;
      }
    }

    const hostRaw =
      body.host?.trim() ||
      existing?.host ||
      "http://127.0.0.1:8080";

    let password: string | null;
    if (body.password === undefined || body.password === "") {
      password = existing?.password ?? null;
    } else {
      password = encryptSecret(body.password);
    }

    const categoriesJson =
      body.categories != null
        ? JSON.stringify(
            body.categories.map((c) => c.trim()).filter(Boolean),
          )
        : (existing?.categories ?? JSON.stringify(DEFAULT_CATEGORIES));

    const pathRulesJson =
      body.pathRules != null
        ? JSON.stringify(body.pathRules)
        : (existing?.pathRules ?? null);

    const baseDownloadPath =
      body.baseDownloadPath !== undefined
        ? body.baseDownloadPath?.trim() || null
        : (existing?.baseDownloadPath ?? defaultDownloadDir());

    const category =
      body.category !== undefined
        ? body.category?.trim() || null
        : (existing?.category ?? null);

    const savePath =
      body.savePath !== undefined
        ? body.savePath?.trim() || null
        : (existing?.savePath ?? null);

    // Storage cap: maxStorageGb from UI, or raw bytes
    let maxStorageBytes: bigint | null | undefined;
    if (body.maxStorageGb !== undefined) {
      if (body.maxStorageGb == null || body.maxStorageGb <= 0) {
        maxStorageBytes = null; // null → engine uses DEFAULT_MAX_STORAGE_BYTES
      } else {
        maxStorageBytes = BigInt(Math.round(body.maxStorageGb * 1e9));
      }
    } else if (body.maxStorageBytes !== undefined) {
      maxStorageBytes =
        body.maxStorageBytes == null || body.maxStorageBytes <= 0
          ? null
          : BigInt(Math.round(body.maxStorageBytes));
    } else {
      maxStorageBytes = undefined; // leave existing
    }

    const settings = await prisma.clientSettings.upsert({
      where: { userId: session.user.id },
      create: {
        userId: session.user.id,
        clientType,
        externalClientType,
        host: hostRaw.replace(/\/+$/, ""),
        username: body.username ?? existing?.username ?? null,
        password,
        category,
        savePath,
        baseDownloadPath,
        maxStorageBytes:
          maxStorageBytes === undefined
            ? BigInt(100 * 1e9) // default 100 GB
            : maxStorageBytes,
        categories: categoriesJson,
        pathRules: pathRulesJson,
      },
      update: {
        clientType,
        externalClientType,
        host: hostRaw.replace(/\/+$/, ""),
        username:
          body.username !== undefined
            ? body.username
            : existing?.username ?? null,
        password,
        category,
        savePath,
        baseDownloadPath,
        ...(maxStorageBytes !== undefined
          ? { maxStorageBytes }
          : {}),
        categories: categoriesJson,
        pathRules: pathRulesJson,
      },
    });

    // The in-process engine keeps running until it is told to stop. Leaving it
    // alive after the user moves to an external client means torrents that no
    // longer appear anywhere in the UI still hold peers, bandwidth and disk.
    if (
      (existing?.clientType ?? "builtin") === "builtin" &&
      clientType !== "builtin"
    ) {
      try {
        const { shutdownBuiltinEngine } = await import(
          "@/lib/clients/builtin-engine"
        );
        await shutdownBuiltinEngine();
      } catch (err) {
        // The setting is already saved; a failed teardown must not undo it.
        console.warn(
          "[settings/client PUT] builtin engine shutdown failed",
          err instanceof Error ? err.message : err,
        );
      }
    }

    let testResult = null;
    if (body.test) {
      try {
        const maxB = settings.maxStorageBytes;
        const base: ClientConnectionConfig = {
          clientType: settings.clientType as ClientConnectionConfig["clientType"],
          externalClientType:
            (settings.externalClientType as ClientConnectionConfig["externalClientType"]) ??
            null,
          host: settings.host,
          username: settings.username,
          password: decryptSecret(settings.password),
          category: settings.category,
          savePath: settings.savePath,
          baseDownloadPath: settings.baseDownloadPath,
          maxStorageBytes:
            maxB == null ? null : Number(maxB),
          categories: parseJsonArray(settings.categories),
          pathRules: parseJsonRecord(settings.pathRules),
          userId: session.user.id,
        };
        const config =
          body.testTarget === "external"
            ? externalClientConfig(base) ?? base
            : base;
        testResult = await testClientConnection(config);
      } catch (err) {
        testResult = {
          ok: false,
          message:
            err instanceof Error ? err.message : "Connection test failed",
        };
      }
    }

    return NextResponse.json({
      settings: publicSettings(settings),
      testResult,
    });
  } catch (err) {
    console.error("[settings/client PUT]", err);
    return NextResponse.json(
      {
        error: "Failed to save settings",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
