import { NextRequest, NextResponse } from "next/server";

import { lookupLogsByTrace } from "../../../db/logs";
import { apiError } from "../../../lib/apiError";
import { logSlowApi } from "../../../utils/api";
import { withApiRoute } from "../../../lib/routeErrorHandler";

async function GETHandler(request: NextRequest) {
  const start = Date.now();
  try {
    const traceId =
      request.nextUrl.searchParams.get("trace_id") ??
      request.nextUrl.searchParams.get("trace") ??
      request.nextUrl.searchParams.get("gmail_id") ??
      "";

    if (!traceId.trim()) {
      const response = NextResponse.json({
        logs: [],
        resolved_trace_id: null,
        candidates: [],
        matched_by: "none",
        hint: "Enter a trace id or Gmail id to inspect logs.",
      });
      logSlowApi("/api/logs", start);
      return response;
    }

    const lookup = await lookupLogsByTrace(traceId);
    const hint =
      lookup.logs.length === 0
        ? "No logs found for that value. Try a longer trace fragment or full Gmail id."
        : lookup.candidates.length > 1
        ? `Matched by ${lookup.matchedBy}. Showing ${lookup.resolvedTraceId}.`
        : undefined;

    const response = NextResponse.json({
      logs: lookup.logs,
      resolved_trace_id: lookup.resolvedTraceId,
      candidates: lookup.candidates,
      matched_by: lookup.matchedBy,
      normalized_query: lookup.normalizedQuery,
      ...(hint ? { hint } : {}),
    });
    logSlowApi("/api/logs", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "LOGS_FETCH_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry log fetch. If it persists, verify database health.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/logs", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/logs', operation: 'GET' });
