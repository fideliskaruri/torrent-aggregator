import { NextRequest, NextResponse } from "next/server";
import os from "node:os";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { readStorageCapInput } from "@/lib/library/storage-cap-input";
import {
  externalClientConfig,
  testClientConnection,
  type ClientConnectionConfig,
} from "@/lib/clients";
import {
  DEFAULT_CATEGORIES,
  defaultDownloadDir,
  ensureDefaultClientSettings,
} from "@/lib/clients/defaults";
import { retainedExternalClientType } from "@/lib/clients/transfer-ownership";
import {
  detectUnsafeDownloadPath,
  unsafeDownloadPathMessage,
  type UnsafeDownloadPathReason,
} from "@/app/settings/download-path-safety";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { DEFAULT_TARGET_RESOLUTION } from "@/lib/torrents/quality";
import {
  getRetentionSettingsSnapshot,
  normalizeRetentionPolicy,
  writeDefaultRetentionPolicy,
  RETENTION_POLICY_EPHEMERAL,
  RETENTION_POLICY_KEPT,
  type RetentionPolicy,
} from "@/lib/library/retention-settings";
import {
  SELECTABLE_RESOLUTIONS,
  invalidateTargetResolution,
} from "@/lib/torrents/target-resolution";
import { primaryDownloadRoot } from "@/lib/download/path-containment";
import { resetDirectorySizeCache } from "@/lib/library/disk-space";
import { resetDiskInventoryCache } from "@/lib/library/disk-inventory";
import {
  booleanField,
  enumField,
  numberField,
  readMutationObject,
  requestFailureResponse,
  stringArrayField,
  stringField,
  stringRecordField,
} from "@/lib/http/request";
import { invalidateSearchCache } from "@/lib/torrents/search-cache";

export const dynamic = "force-dynamic";

/** The tree the disk inventory walks for this user's settings row. */
function downloadRootFor(settings: {
  baseDownloadPath?: string | null;
  savePath?: string | null;
}): string | null {
  return primaryDownloadRoot(settings);
}

type DownloadStorageCacheState = {
  baseDownloadPath?: string | null;
  savePath?: string | null;
  maxStorageBytes?: bigint | number | null;
  storageCapConfigured?: boolean | null;
};

/**
 * Intervals the UI offers. 0 means "never on a timer".
 *
 * Nothing shorter than 15 minutes: episodes do not appear that fast, and a
 * tighter loop only buys extra requests against indexers that ban IPs.
 */
export const AUTOMATION_INTERVAL_CHOICES = [0, 30, 120, 360] as const;

/** Clamp anything unrecognised to "off" rather than inventing a schedule. */
function normalizeAutomationInterval(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return (AUTOMATION_INTERVAL_CHOICES as readonly number[]).includes(value)
    ? value
    : 0;
}

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
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string" && val.trim()) out[k] = val.trim();
    }
    return out;
  } catch {
    return {};
  }
}

interface DownloadPathWarning {
  field: "baseDownloadPath" | "savePath" | "pathRule";
  category?: string;
  path: string;
  reasons: UnsafeDownloadPathReason[];
  message: string;
}

function collectDownloadPathWarnings(settings: {
  baseDownloadPath: string | null;
  savePath: string | null;
  pathRules: Record<string, string>;
}): DownloadPathWarning[] {
  const configured: Array<{
    field: DownloadPathWarning["field"];
    category?: string;
    path: string;
  }> = [
    ...(settings.baseDownloadPath?.trim()
      ? [
          {
            field: "baseDownloadPath" as const,
            path: settings.baseDownloadPath.trim(),
          },
        ]
      : []),
    ...(settings.savePath?.trim()
      ? [{ field: "savePath" as const, path: settings.savePath.trim() }]
      : []),
    ...Object.entries(settings.pathRules).map(([category, path]) => ({
      field: "pathRule" as const,
      category,
      path,
    })),
  ];

  return configured.flatMap((item) => {
    const safety = detectUnsafeDownloadPath(item.path, {
      repoRoot: process.cwd(),
      tempRoots: [os.tmpdir()],
    });
    return safety.unsafe
      ? [
          {
            ...item,
            reasons: safety.reasons,
            message: unsafeDownloadPathMessage(safety.reasons),
          },
        ]
      : [];
  });
}

function configuredStorageCap(settings: {
  maxStorageBytes?: bigint | number | null;
  storageCapConfigured?: boolean | null;
}): number | null {
  if (settings.storageCapConfigured !== true) return null;
  const value =
    typeof settings.maxStorageBytes === "bigint"
      ? Number(settings.maxStorageBytes)
      : Number(settings.maxStorageBytes);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function shouldResetDownloadStorageCaches(
  previous: DownloadStorageCacheState | null | undefined,
  next: DownloadStorageCacheState,
): boolean {
  return (
    downloadRootFor(previous ?? {}) !== downloadRootFor(next) ||
    configuredStorageCap(previous ?? {}) !== configuredStorageCap(next)
  );
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
  storageCapConfigured?: boolean | null;
  verboseDiagnostics?: boolean | null;
  preferredResolution?: number | null;
  automationIntervalMinutes?: number | null;
  categories: string | null;
  pathRules: string | null;
  defaultRetentionPolicy?: RetentionPolicy | null;
  defaultRetentionPolicyPersisted?: boolean | null;
  storageUsage?: Awaited<ReturnType<typeof getRetentionSettingsSnapshot>>["storageUsage"] | null;
}) {
  const categories = parseJsonArray(settings.categories);
  const pathRules = parseJsonRecord(settings.pathRules);
  const external =
    settings.externalClientType === "qbittorrent" ||
    settings.externalClientType === "transmission"
      ? settings.externalClientType
      : null;
  const maxStorageBytes = configuredStorageCap(settings);
  const storageCapConfigured = maxStorageBytes != null;
  const maxStorageGb =
    maxStorageBytes != null && Number.isFinite(maxStorageBytes)
      ? Math.round((maxStorageBytes / 1e9) * 10) / 10
      : 0;
  const hasDownloadFolder = Boolean(
    settings.baseDownloadPath?.trim() || settings.savePath?.trim(),
  );
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
    storageCapConfigured,
    setupComplete:
      hasDownloadFolder &&
      storageCapConfigured &&
      maxStorageBytes != null &&
      maxStorageBytes > 0,
    verboseDiagnostics: settings.verboseDiagnostics === true,
    preferredResolution:
      settings.preferredResolution != null &&
      SELECTABLE_RESOLUTIONS.some(
        (resolution) => resolution === settings.preferredResolution,
      )
        ? settings.preferredResolution
        : DEFAULT_TARGET_RESOLUTION,
    automationIntervalMinutes: normalizeAutomationInterval(
      settings.automationIntervalMinutes,
    ),
    categories: categories.length ? categories : DEFAULT_CATEGORIES,
    pathRules,
    pathWarnings: collectDownloadPathWarnings({
      baseDownloadPath: settings.baseDownloadPath,
      savePath: settings.savePath,
      pathRules,
    }),
    hasExternal: Boolean(external),
    defaultRetentionPolicy:
      settings.defaultRetentionPolicy ?? normalizeRetentionPolicy(null),
    defaultRetentionPolicyPersisted: Boolean(
      settings.defaultRetentionPolicyPersisted,
    ),
    storageUsage: settings.storageUsage ?? null,
  };
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const settings = await ensureDefaultClientSettings(session.user.id);
    const retention = await getRetentionSettingsSnapshot(
      session.user.id,
      prisma,
      configuredStorageCap(settings),
      downloadRootFor(settings),
    );

    return NextResponse.json({
      settings: publicSettings({ ...settings, ...retention }),
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
        message: "Settings could not be loaded. Check the server logs for details.",
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

    // Ensure settings row exists (prevents null pointer in subsequent operations)
    await ensureDefaultClientSettings(session.user.id);

    const parsedBody = await readMutationObject(request);
    if (!parsedBody.ok) return requestFailureResponse(parsedBody);
    const fields = parsedBody.value;
    const clientTypeInput = enumField(
      fields,
      "clientType",
      ["qbittorrent", "transmission", "builtin"] as const,
    );
    if (!clientTypeInput.ok) return requestFailureResponse(clientTypeInput);
    const externalInput = stringField(fields, "externalClientType", {
      nullable: true,
      maxLength: 32,
    });
    if (!externalInput.ok) return requestFailureResponse(externalInput);
    if (
      externalInput.value != null &&
      externalInput.value !== "" &&
      externalInput.value !== "none" &&
      externalInput.value !== "qbittorrent" &&
      externalInput.value !== "transmission"
    ) {
      return NextResponse.json(
        { error: "Invalid externalClientType", field: "externalClientType" },
        { status: 400 },
      );
    }
    const host = stringField(fields, "host", { maxLength: 2048 });
    if (!host.ok) return requestFailureResponse(host);
    if (host.value) {
      try {
        const url = new URL(host.value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return NextResponse.json(
            { error: "host must use http or https", field: "host" },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: "host must be a valid URL", field: "host" },
          { status: 400 },
        );
      }
    }
    const username = stringField(fields, "username", { nullable: true, maxLength: 500 });
    if (!username.ok) return requestFailureResponse(username);
    const passwordInput = stringField(fields, "password", {
      nullable: true,
      trim: false,
      maxLength: 4096,
    });
    if (!passwordInput.ok) return requestFailureResponse(passwordInput);
    const categoryInput = stringField(fields, "category", { nullable: true, maxLength: 100 });
    if (!categoryInput.ok) return requestFailureResponse(categoryInput);
    const savePathInput = stringField(fields, "savePath", { nullable: true, maxLength: 4096 });
    if (!savePathInput.ok) return requestFailureResponse(savePathInput);
    const baseDownloadPathInput = stringField(fields, "baseDownloadPath", {
      nullable: true,
      maxLength: 4096,
    });
    if (!baseDownloadPathInput.ok) return requestFailureResponse(baseDownloadPathInput);
    for (const [field, value] of [
      ["savePath", savePathInput.value],
      ["baseDownloadPath", baseDownloadPathInput.value],
    ] as const) {
      if (value?.includes("\0")) {
        return NextResponse.json(
          { error: `${field} contains an invalid null character`, field },
          { status: 400 },
        );
      }
    }
    const maxStorageGb = numberField(fields, "maxStorageGb", {
      nullable: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER / 1e9,
    });
    if (!maxStorageGb.ok) return requestFailureResponse(maxStorageGb);
    const maxStorageBytesInput = numberField(fields, "maxStorageBytes", {
      nullable: true,
      integer: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    });
    if (!maxStorageBytesInput.ok) return requestFailureResponse(maxStorageBytesInput);
    if (maxStorageGb.value !== undefined && maxStorageBytesInput.value !== undefined) {
      return NextResponse.json(
        { error: "Provide maxStorageGb or maxStorageBytes, not both" },
        { status: 400 },
      );
    }
    const verboseDiagnosticsInput = booleanField(fields, "verboseDiagnostics");
    if (!verboseDiagnosticsInput.ok) return requestFailureResponse(verboseDiagnosticsInput);
    const preferredResolutionInput = numberField(fields, "preferredResolution", {
      nullable: true,
      integer: true,
    });
    if (!preferredResolutionInput.ok) return requestFailureResponse(preferredResolutionInput);
    if (
      preferredResolutionInput.value != null &&
      !SELECTABLE_RESOLUTIONS.some(
        (resolution) => resolution === preferredResolutionInput.value,
      )
    ) {
      return NextResponse.json(
        {
          error: `preferredResolution must be one of: ${SELECTABLE_RESOLUTIONS.join(", ")}`,
          field: "preferredResolution",
        },
        { status: 400 },
      );
    }
    const automationIntervalInput = numberField(fields, "automationIntervalMinutes", {
      nullable: true,
      integer: true,
      min: 0,
    });
    if (!automationIntervalInput.ok) return requestFailureResponse(automationIntervalInput);
    if (
      automationIntervalInput.value != null &&
      !AUTOMATION_INTERVAL_CHOICES.some(
        (minutes) => minutes === automationIntervalInput.value,
      )
    ) {
      return NextResponse.json(
        {
          error: `automationIntervalMinutes must be one of: ${AUTOMATION_INTERVAL_CHOICES.join(", ")}`,
          field: "automationIntervalMinutes",
        },
        { status: 400 },
      );
    }
    const categories = stringArrayField(fields, "categories", {
      nullable: true,
      maxItems: 64,
      maxItemLength: 100,
    });
    if (!categories.ok) return requestFailureResponse(categories);
    const pathRules = stringRecordField(fields, "pathRules", {
      nullable: true,
      maxEntries: 64,
      maxKeyLength: 100,
      maxValueLength: 4096,
    });
    if (!pathRules.ok) return requestFailureResponse(pathRules);
    if (
      pathRules.value &&
      Object.values(pathRules.value).some((value) => value.includes("\0"))
    ) {
      return NextResponse.json(
        { error: "pathRules contains an invalid null character", field: "pathRules" },
        { status: 400 },
      );
    }
    const test = booleanField(fields, "test");
    if (!test.ok) return requestFailureResponse(test);
    const testTarget = enumField(fields, "testTarget", ["primary", "external"] as const);
    if (!testTarget.ok) return requestFailureResponse(testTarget);
    const retentionInput = enumField(
      fields,
      "defaultRetentionPolicy",
      [
        RETENTION_POLICY_EPHEMERAL,
        RETENTION_POLICY_KEPT,
        "STREAM",
        "KEEP",
      ] as const,
      { nullable: true },
    );
    if (!retentionInput.ok) return requestFailureResponse(retentionInput);
    const switchToBuiltin = booleanField(fields, "switchToBuiltin");
    if (!switchToBuiltin.ok) return requestFailureResponse(switchToBuiltin);
    const body = {
      clientType: clientTypeInput.value,
      externalClientType: externalInput.value,
      host: host.value,
      username: username.value,
      password: passwordInput.value,
      category: categoryInput.value,
      savePath: savePathInput.value,
      baseDownloadPath: baseDownloadPathInput.value,
      maxStorageGb: maxStorageGb.value,
      maxStorageBytes: maxStorageBytesInput.value,
      verboseDiagnostics: verboseDiagnosticsInput.value,
      preferredResolution: preferredResolutionInput.value,
      automationIntervalMinutes: automationIntervalInput.value,
      categories: categories.value,
      pathRules: pathRules.value,
      test: test.value,
      testTarget: testTarget.value,
      defaultRetentionPolicy: retentionInput.value,
      switchToBuiltin: switchToBuiltin.value,
    };

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
          baseDownloadPath: existing?.baseDownloadPath ?? null,
          maxStorageBytes: existing?.maxStorageBytes ?? null,
          storageCapConfigured: existing?.storageCapConfigured ?? null,
          verboseDiagnostics: existing?.verboseDiagnostics ?? null,
          categories:
            existing?.categories ?? JSON.stringify(DEFAULT_CATEGORIES),
          pathRules: existing?.pathRules ?? null,
        },
        update: {
          clientType: "builtin",
          externalClientType: keepExternal,
        },
      });
      const retention = await getRetentionSettingsSnapshot(
        session.user.id,
        prisma,
        configuredStorageCap(settings),
        downloadRootFor(settings),
      );
      return NextResponse.json({
        settings: publicSettings({ ...settings, ...retention }),
        message:
          "Switched to built-in engine. External client kept for optional Send to my client.",
      });
    }

    const clientType =
      body.clientType || existing?.clientType || "builtin";
    if (!["qbittorrent", "transmission", "builtin"].includes(clientType)) {
      return NextResponse.json({ error: "Invalid clientType" }, { status: 400 });
    }

    if (
      body.externalClientType !== undefined &&
      body.externalClientType !== null &&
      body.externalClientType !== "" &&
      body.externalClientType !== "none" &&
      body.externalClientType !== "qbittorrent" &&
      body.externalClientType !== "transmission"
    ) {
      return NextResponse.json(
        { error: "Invalid externalClientType" },
        { status: 400 },
      );
    }
    const externalClientType = retainedExternalClientType(
      clientType as ClientConnectionConfig["clientType"],
      body.externalClientType,
      existing?.externalClientType,
    );

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
        : (existing?.baseDownloadPath ?? null);

    const category =
      body.category !== undefined
        ? body.category?.trim() || null
        : (existing?.category ?? null);

    const savePath =
      body.savePath !== undefined
        ? body.savePath?.trim() || null
        : (existing?.savePath ?? null);

    // Storage cap: maxStorageGb from UI, or raw bytes.
    // @see readStorageCapInput — absent, cleared and malformed are three
    // different things, and conflating the last two silently blocked every
    // download on this install.
    let maxStorageBytes: bigint | null | undefined;
    let storageCapConfigured: boolean | undefined;
    {
      const raw =
        body.maxStorageGb !== undefined
          ? ([body.maxStorageGb, "maxStorageGb", 1e9] as const)
          : ([body.maxStorageBytes, "maxStorageBytes", 1] as const);
      const parsed = readStorageCapInput(raw[0], raw[1], raw[2]);
      if (!parsed.ok) {
        return NextResponse.json(
          { ok: false, error: parsed.reason, message: parsed.reason },
          { status: 400 },
        );
      }
      if (parsed.action === "keep") {
        maxStorageBytes = undefined;
        storageCapConfigured = undefined;
      } else if (parsed.action === "clear") {
        maxStorageBytes = null;
        storageCapConfigured = false;
      } else {
        maxStorageBytes = BigInt(parsed.bytes);
        storageCapConfigured = true;
      }
    }

    if (
      body.verboseDiagnostics !== undefined &&
      typeof body.verboseDiagnostics !== "boolean"
    ) {
      return NextResponse.json(
        { error: "verboseDiagnostics must be a boolean" },
        { status: 400 },
      );
    }
    const verboseDiagnostics = body.verboseDiagnostics;

    // Only accept a value the UI actually offers. An arbitrary number would
    // make every release "above target" and quietly invert the ordering.
    let preferredResolution: number | null | undefined;
    if (body.preferredResolution !== undefined) {
      preferredResolution =
        body.preferredResolution ?? DEFAULT_TARGET_RESOLUTION;
    }

    let automationIntervalMinutes: number | undefined;
    if (body.automationIntervalMinutes !== undefined) {
      automationIntervalMinutes = normalizeAutomationInterval(
        body.automationIntervalMinutes,
      );
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
        maxStorageBytes: maxStorageBytes === undefined ? null : maxStorageBytes,
        storageCapConfigured:
          storageCapConfigured === undefined ? null : storageCapConfigured,
        verboseDiagnostics: verboseDiagnostics ?? null,
        preferredResolution: preferredResolution ?? DEFAULT_TARGET_RESOLUTION,
        automationIntervalMinutes: automationIntervalMinutes ?? 0,
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
          ? { maxStorageBytes, storageCapConfigured }
          : {}),
        ...(verboseDiagnostics !== undefined ? { verboseDiagnostics } : {}),
        ...(preferredResolution !== undefined ? { preferredResolution } : {}),
        ...(automationIntervalMinutes !== undefined
          ? { automationIntervalMinutes }
          : {}),
        categories: categoriesJson,
        pathRules: pathRulesJson,
      },
    });

    if (shouldResetDownloadStorageCaches(existing, settings)) {
      // A settings save is the moment the app should stop trusting any
      // previous storage snapshot for this user. The next settings read and
      // the next download check both need the post-save tree, not a memo from
      // before the path or cap change.
      resetDirectorySizeCache();
      resetDiskInventoryCache();
    }

    let retentionWrite = { persisted: true };
    if (body.defaultRetentionPolicy !== undefined) {
      retentionWrite = await writeDefaultRetentionPolicy(
        session.user.id,
        normalizeRetentionPolicy(body.defaultRetentionPolicy),
      );
    }
    const retention = await getRetentionSettingsSnapshot(
      session.user.id,
      prisma,
      configuredStorageCap(settings),
      downloadRootFor(settings),
    );

    // Ranking reads this through a short-lived memo; without this the user
    // would change the quality target, hit Search, and see the old order.
    const targetResolutionChanged =
      preferredResolution !== undefined &&
      preferredResolution !==
        (existing?.preferredResolution ?? DEFAULT_TARGET_RESOLUTION);
    invalidateTargetResolution();
    if (targetResolutionChanged) {
      const invalidation = await invalidateSearchCache();
      if (!invalidation.persistedCleared) {
        console.warn(
          "[settings/client PUT] target changed but persisted search cache cleanup failed",
        );
      }
    }

    let testResult = null;
    if (body.test) {
      try {
        const maxB =
          settings.storageCapConfigured === true
            ? settings.maxStorageBytes
            : null;
        const storedClientType =
          settings.clientType === "qbittorrent" ||
          settings.clientType === "transmission" ||
          settings.clientType === "builtin"
            ? settings.clientType
            : "builtin";
        const storedExternalType =
          settings.externalClientType === "qbittorrent" ||
          settings.externalClientType === "transmission"
            ? settings.externalClientType
            : null;
        const base: ClientConnectionConfig = {
          clientType: storedClientType,
          externalClientType: storedExternalType,
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
        console.warn("[settings/client PUT] connection test failed:", err);
        testResult = {
          ok: false,
          message: "Connection test failed. Verify the host and credentials.",
        };
      }
    }

    return NextResponse.json({
      settings: publicSettings({ ...settings, ...retention }),
      testResult,
      retentionWarning: retentionWrite.persisted
        ? null
        : "Retention default needs the pending Prisma migration before it can be saved.",
    });
  } catch (err) {
    console.error("[settings/client PUT]", err);
    return NextResponse.json(
      {
        error: "Failed to save settings",
        message: "Settings could not be saved. Check the server logs for details.",
      },
      { status: 500 },
    );
  }
}
