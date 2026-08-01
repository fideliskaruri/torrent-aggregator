import { auth } from "@/lib/auth";
import { componentHealthSnapshot } from "@/lib/observability/health";
import {
  jsonResponse,
  observeRequest,
} from "@/lib/observability/logging";
import { checkDatabaseReadiness } from "@/lib/observability/readiness";
import { buildDiagnosticsHealthResponse } from "@/lib/observability/responses";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const observer = observeRequest(request, "database", "diagnostics-health");
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return jsonResponse(
        observer,
        { error: "Unauthorized", code: "AUTHENTICATION_FAILED" },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
  } catch (error) {
    const safeError = observer.failure("DATABASE_UNAVAILABLE", error);
    return jsonResponse(
      observer,
      { error: safeError.message, code: safeError.code },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const database = await checkDatabaseReadiness();
  return jsonResponse(
    observer,
    buildDiagnosticsHealthResponse(database, componentHealthSnapshot()),
    {
      status: database.ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
