import { auth } from "@/lib/auth";
import { componentHealthSnapshot } from "@/lib/observability/health";
// Side-effect barrel: constructs every named bounded cache so the registry
// cannot be empty here just because this route bundle never imported them.
import { registeredCacheSizes } from "@/lib/cache/registered-caches";
import {
  liveEnginePressure,
  redactEnginePressureDetails,
} from "@/lib/clients/engine-pressure";
import { completionSweepCounters } from "@/lib/clients/completion-sweep";
import { eventLoopDelaySnapshot } from "@/lib/observability/event-loop-delay";
import { recentEventLoopDelay } from "@/lib/observability/event-loop-recent";
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
  const caches = registeredCacheSizes();
  return jsonResponse(
    observer,
    buildDiagnosticsHealthResponse(database, componentHealthSnapshot(), {
      caches: caches.sizes,
      cacheNames: caches.registered,
      missingCaches: caches.missing,
      // This route is authenticated, not admin-only. Keep aggregate pressure
      // diagnostics without exposing other users' release names/info hashes.
      enginePressure: redactEnginePressureDetails(liveEnginePressure()),
      completionSweep: completionSweepCounters(),
      eventLoopDelay: eventLoopDelaySnapshot(),
      // Lifetime percentiles above cannot move once a bad minute has happened,
      // so they cannot answer "is it blocked NOW" or "did that change help".
      // The recent window can. Additive: nothing reads the old field's shape.
      eventLoopDelayRecent: recentEventLoopDelay(),
    }),
    {
      status: database.ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
