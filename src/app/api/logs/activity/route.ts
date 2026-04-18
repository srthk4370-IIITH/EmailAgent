import { NextRequest, NextResponse } from "next/server";

import { listRecentLogs } from "../../../../db/logs";
import { withApiRoute } from "../../../../lib/routeErrorHandler";
import { logSlowApi } from "../../../../utils/api";

async function GETHandler(request: NextRequest) {
  const start = Date.now();
  try {
    const rawLimit = Number(request.nextUrl.searchParams.get("limit") ?? 120);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 20), 400) : 120;
    const logs = await listRecentLogs(limit);
    const response = NextResponse.json(
      { logs },
      { headers: { "Cache-Control": "private, max-age=3, stale-while-revalidate=20" } },
    );
    logSlowApi("/api/logs/activity", start);
    return response;
  } catch {
    const response = NextResponse.json({ error: "Failed to load activity" }, { status: 500 });
    logSlowApi("/api/logs/activity", start);
    return response;
  }
}

export const GET = withApiRoute(GETHandler, { route: "/logs/activity", operation: "GET" });
