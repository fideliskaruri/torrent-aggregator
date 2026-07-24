import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { runUserAutomation } from "@/lib/automation/runner";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized", message: "Sign in required" },
        { status: 401 },
      );
    }

    const summary = await runUserAutomation(session.user.id);

    return NextResponse.json({
      ok: true,
      offline: summary.offline,
      message: summary.message,
      summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline =
      /econnrefused|unreachable|fetch failed|timeout|not listening|cannot reach/i.test(
        message,
      );

    // Never empty body; never hard-500 on client offline
    return NextResponse.json(
      {
        ok: false,
        offline,
        error: offline ? "Client offline" : "Automation failed",
        message: offline
          ? "Cannot reach torrent client. Is it running? Check Host URL in Settings."
          : message,
        summary: {
          rules: { ran: 0, matched: 0, messages: [] },
          library: { checked: 0, sent: 0, skipped: 0, failed: 0 },
          offline,
          message,
        },
      },
      { status: offline ? 503 : 500 },
    );
  }
}
