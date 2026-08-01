import { checkDatabaseReadiness } from "@/lib/observability/readiness";
import { buildPublicHealthResponse } from "@/lib/observability/responses";
import {
  jsonResponse,
  observeRequest,
} from "@/lib/observability/logging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const observer = observeRequest(request, "database", "public-health");
  const database = await checkDatabaseReadiness();
  return jsonResponse(observer, buildPublicHealthResponse(database), {
    status: database.ready ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
