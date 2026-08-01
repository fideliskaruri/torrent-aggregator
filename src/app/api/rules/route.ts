import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { runAutoRules } from "@/lib/rules/runner";
import {
  booleanField,
  enumField,
  guardBrowserMutation,
  numberField,
  queryString,
  readMutationObject,
  requestFailureResponse,
  stringField,
} from "@/lib/http/request";

export const dynamic = "force-dynamic";

const RULE_CATEGORIES = ["all", "anime", "movies", "tv"] as const;
const RULE_RESOLUTIONS = ["480p", "720p", "1080p", "2160p"] as const;
const RULE_SOURCES = ["nyaa", "1337x", "apibay", "torrentscsv", "yts"] as const;

function validateSources(
  value: string | null | undefined,
): { ok: true; value: string | null | undefined } | {
  ok: false;
  status: 400;
  error: string;
  field: string;
} {
  if (value == null) return { ok: true, value };
  const parts = value.split(",").map((source) => source.trim());
  if (parts.length > RULE_SOURCES.length || parts.some((source) => !source)) {
    return {
      ok: false,
      status: 400,
      error: `sources may contain at most ${RULE_SOURCES.length} non-empty values`,
      field: "sources",
    };
  }
  for (const source of parts) {
    if (!RULE_SOURCES.some((allowed) => allowed === source)) {
      return {
        ok: false,
        status: 400,
        error: `Unknown rule source \`${source}\``,
        field: "sources",
      };
    }
  }
  return { ok: true, value: [...new Set(parts)].join(",") };
}

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

  const parsedBody = await readMutationObject(request);
  if (!parsedBody.ok) return requestFailureResponse(parsedBody);
  const fields = parsedBody.value;
  const name = stringField(fields, "name", { required: true, maxLength: 200 });
  if (!name.ok) return requestFailureResponse(name);
  const query = stringField(fields, "query", { required: true, maxLength: 500 });
  if (!query.ok) return requestFailureResponse(query);
  const category = enumField(fields, "category", RULE_CATEGORIES);
  if (!category.ok) return requestFailureResponse(category);
  const minSeeders = numberField(fields, "minSeeders", {
    integer: true,
    min: 0,
    max: 10_000_000,
  });
  if (!minSeeders.ok) return requestFailureResponse(minSeeders);
  const maxSizeBytes = numberField(fields, "maxSizeBytes", {
    nullable: true,
    integer: true,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (!maxSizeBytes.ok) return requestFailureResponse(maxSizeBytes);
  const resolution = enumField(fields, "resolution", RULE_RESOLUTIONS, { nullable: true });
  if (!resolution.ok) return requestFailureResponse(resolution);
  const rawSources = stringField(fields, "sources", { nullable: true, maxLength: 500 });
  if (!rawSources.ok) return requestFailureResponse(rawSources);
  const sources = validateSources(rawSources.value);
  if (!sources.ok) return requestFailureResponse(sources);
  const enabled = booleanField(fields, "enabled");
  if (!enabled.ok) return requestFailureResponse(enabled);
  const run = booleanField(fields, "run");
  if (!run.ok) return requestFailureResponse(run);

  const rule = await prisma.autoRule.create({
    data: {
      userId: session.user.id,
      name: name.value ?? "",
      query: query.value ?? "",
      category: category.value ?? "all",
      minSeeders: minSeeders.value ?? 10,
      maxSizeBytes:
        maxSizeBytes.value != null ? BigInt(maxSizeBytes.value) : null,
      resolution: resolution.value ?? null,
      sources: sources.value ?? null,
      enabled: enabled.value ?? true,
    },
  });

  let runResult = null;
  if (run.value) {
    try {
      runResult = await runAutoRules(session.user.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const offline =
        /econnrefused|unreachable|fetch failed|timeout|not listening|cannot reach/i.test(
          message,
        );
      console.error("[rules POST] Immediate run failed:", err);
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
            : "The rules run failed. Check the server logs for details.",
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

  const parsedBody = await readMutationObject(request);
  if (!parsedBody.ok) return requestFailureResponse(parsedBody);
  const fields = parsedBody.value;
  const id = stringField(fields, "id", { required: true, maxLength: 128 });
  if (!id.ok) return requestFailureResponse(id);
  const name = stringField(fields, "name", { maxLength: 200 });
  if (!name.ok) return requestFailureResponse(name);
  const query = stringField(fields, "query", { maxLength: 500 });
  if (!query.ok) return requestFailureResponse(query);
  const category = enumField(fields, "category", RULE_CATEGORIES);
  if (!category.ok) return requestFailureResponse(category);
  const minSeeders = numberField(fields, "minSeeders", {
    integer: true,
    min: 0,
    max: 10_000_000,
  });
  if (!minSeeders.ok) return requestFailureResponse(minSeeders);
  const maxSizeBytes = numberField(fields, "maxSizeBytes", {
    nullable: true,
    integer: true,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (!maxSizeBytes.ok) return requestFailureResponse(maxSizeBytes);
  const resolution = enumField(fields, "resolution", RULE_RESOLUTIONS, { nullable: true });
  if (!resolution.ok) return requestFailureResponse(resolution);
  const rawSources = stringField(fields, "sources", { nullable: true, maxLength: 500 });
  if (!rawSources.ok) return requestFailureResponse(rawSources);
  const sources = validateSources(rawSources.value);
  if (!sources.ok) return requestFailureResponse(sources);
  const enabled = booleanField(fields, "enabled");
  if (!enabled.ok) return requestFailureResponse(enabled);

  const updated = await prisma.autoRule.updateMany({
    where: { id: id.value ?? "", userId: session.user.id },
    data: {
      name: name.value ?? undefined,
      query: query.value ?? undefined,
      category: category.value ?? undefined,
      minSeeders: minSeeders.value ?? undefined,
      maxSizeBytes:
        maxSizeBytes.value === undefined
          ? undefined
          : maxSizeBytes.value == null
            ? null
            : BigInt(maxSizeBytes.value),
      resolution: resolution.value,
      sources: sources.value,
      enabled: enabled.value ?? undefined,
    },
  });

  if (updated.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rule = await prisma.autoRule.findUnique({ where: { id: id.value ?? "" } });
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

  const origin = guardBrowserMutation(request);
  if (!origin.ok) return requestFailureResponse(origin);
  const idResult = queryString(request.nextUrl.searchParams, "id", {
    required: true,
    maxLength: 128,
  });
  if (!idResult.ok) return requestFailureResponse(idResult);
  const id = idResult.value ?? "";

  await prisma.autoRule.deleteMany({
    where: { id, userId: session.user.id },
  });

  return NextResponse.json({ ok: true });
}
