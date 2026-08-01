import { auth } from "@/lib/auth";
import { runAutoRules } from "@/lib/rules/runner";
import {
  guardBrowserMutation,
  requestFailureResponse,
} from "@/lib/http/request";
import {
  CORRELATION_HEADER,
  jsonResponse,
  observeRequest,
} from "@/lib/observability/logging";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const observer = observeRequest(request, "rules", "run-rules");
  const reply = (body: unknown, init?: ResponseInit) =>
    jsonResponse(observer, body, init);
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return reply(
        { ok: false, error: "Unauthorized", message: "Sign in required" },
        { status: 401 },
      );
    }
    const origin = guardBrowserMutation(request);
    if (!origin.ok) {
      const response = requestFailureResponse(origin);
      response.headers.set(CORRELATION_HEADER, observer.correlationId);
      return response;
    }

    const summary = await runAutoRules(session.user.id);
    const offline = summary.some((r) => r.offline);
    const sent = summary.filter((r) => r.status === "sent").length;
    const failed = summary.filter((r) => r.status === "failed").length;
    const skipped = summary.filter((r) => r.status === "skipped").length;
    if (offline || failed > 0) {
      observer.degraded("RULES_FAILED", {
        offline,
        count: summary.length,
        status: offline ? "offline" : "partial",
      });
    } else {
      observer.success("RULES_SUCCEEDED", {
        offline: false,
        count: summary.length,
        status: "ok",
      });
    }

    return reply({
      ok: true,
      offline,
      message: offline
        ? `Rules finished with client offline · ${sent} sent · ${failed} failed · ${skipped} skipped`
        : `Rules finished · ${sent} sent · ${failed} failed · ${skipped} skipped`,
      summary,
    });
  } catch (err) {
    const safeError = observer.failure("RULES_FAILED", err);
    const offline =
      safeError.code === "UPSTREAM_UNAVAILABLE" ||
      safeError.code === "OPERATION_TIMEOUT";

    return reply(
      {
        ok: false,
        offline,
        error: offline ? "Client offline" : "Rules run failed",
        message: offline
          ? "The configured torrent client is unavailable."
          : safeError.message,
        summary: [],
      },
      { status: offline ? 503 : 500 },
    );
  }
}
