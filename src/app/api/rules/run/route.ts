import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { runAutoRules } from "@/lib/rules/runner";
import {
  guardBrowserMutation,
  requestFailureResponse,
} from "@/lib/http/request";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized", message: "Sign in required" },
        { status: 401 },
      );
    }
    const origin = guardBrowserMutation(request);
    if (!origin.ok) return requestFailureResponse(origin);

    const summary = await runAutoRules(session.user.id);
    const offline = summary.some((r) => r.offline);
    const sent = summary.filter((r) => r.status === "sent").length;
    const failed = summary.filter((r) => r.status === "failed").length;
    const skipped = summary.filter((r) => r.status === "skipped").length;

    return NextResponse.json({
      ok: true,
      offline,
      message: offline
        ? `Rules finished with client offline · ${sent} sent · ${failed} failed · ${skipped} skipped`
        : `Rules finished · ${sent} sent · ${failed} failed · ${skipped} skipped`,
      summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline =
      /econnrefused|unreachable|fetch failed|timeout|not listening|cannot reach/i.test(
        message,
      );
    console.error("[rules/run] Unexpected rules failure:", err);

    return NextResponse.json(
      {
        ok: false,
        offline,
        error: offline ? "Client offline" : "Rules run failed",
        message: offline
          ? "Cannot reach torrent client. Is it running? Check Host URL in Settings."
          : "The rules run failed. Check the server logs for details.",
        summary: [],
      },
      { status: offline ? 503 : 500 },
    );
  }
}
