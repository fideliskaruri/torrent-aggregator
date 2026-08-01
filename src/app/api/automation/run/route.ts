import { auth } from "@/lib/auth";
import { runUserAutomation } from "@/lib/automation/runner";
import {
  jsonResponse,
  observeRequest,
} from "@/lib/observability/logging";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const observer = observeRequest(request, "automation", "run-automation");
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

    const summary = await runUserAutomation(session.user.id);
    if (summary.offline) {
      observer.degraded("AUTOMATION_FAILED", {
        offline: true,
        status: "offline",
      });
    } else {
      observer.success("AUTOMATION_SUCCEEDED", { offline: false, status: "ok" });
    }

    return reply({
      ok: true,
      offline: summary.offline,
      message: summary.message,
      summary,
    });
  } catch (err) {
    const safeError = observer.failure("AUTOMATION_FAILED", err);
    const offline =
      safeError.code === "UPSTREAM_UNAVAILABLE" ||
      safeError.code === "OPERATION_TIMEOUT";

    // Never empty body; never hard-500 on client offline
    return reply(
      {
        ok: false,
        offline,
        error: offline ? "Client offline" : "Automation failed",
        message: offline
          ? "The configured torrent client is unavailable."
          : safeError.message,
        summary: {
          rules: { ran: 0, matched: 0, messages: [] },
          library: { checked: 0, sent: 0, skipped: 0, failed: 0 },
          offline,
          message: offline
            ? "The configured torrent client is unavailable."
            : safeError.message,
        },
      },
      { status: offline ? 503 : 500 },
    );
  }
}
