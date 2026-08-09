import { NextRequest } from "next/server";
import { rateLimit } from "@/lib/torrents/search-cache";
import { collectSuggestions, suggestFailureShapeFor } from "@/lib/search/suggest";
import { jsonResponse, observeRequest } from "@/lib/observability/logging";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const observer = observeRequest(request, "title-search", "suggest");
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(`suggest:${ip}`, 60)) {
    return jsonResponse(observer, { suggestions: [] });
  }

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return jsonResponse(observer, { suggestions: [] });
  }
  if (q.length > 200) {
    return jsonResponse(
      observer,
      { error: "Query too long", suggestions: [] },
      { status: 400 },
    );
  }

  try {
    const outcome = await collectSuggestions(q);
    if (outcome.partial) {
      observer.degraded("TITLE_SEARCH_FAILED", {
        status: `partial:${outcome.failed.join(",")}`,
        resultCount: outcome.suggestions.length,
      });
    } else {
      observer.success(
        "TITLE_SEARCH_SUCCEEDED",
        { resultCount: outcome.suggestions.length },
        { emit: false },
      );
    }
    return jsonResponse(observer, {
      suggestions: outcome.suggestions,
      query: outcome.displayQuery,
      canonicalQuery: outcome.query,
      partial: outcome.partial,
      failedProviders: outcome.failed,
    });
  } catch (err) {
    // Every failure is observed before it is answered; the classification below
    // decides only *what the user is told*, never whether it is logged.
    const safeError = observer.failure("TITLE_SEARCH_FAILED", err);
    const shape = suggestFailureShapeFor(err);

    // 502 = a genuine outage where every provider rejected, named truthfully.
    // 500 = our own bug, reported without blaming upstream.
    return jsonResponse(
      observer,
      {
        error: shape.providerOutage
          ? "Suggest failed"
          : "Suggest could not be completed",
        code: safeError.code,
        message: safeError.message,
        suggestions: [],
        partial: false,
        failedProviders: shape.failedProviders,
      },
      { status: shape.status },
    );
  }
}
