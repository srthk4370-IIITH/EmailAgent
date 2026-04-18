import { NextResponse } from "next/server";

import { getOAuthUrl } from "../../../services/oauth";
import { apiError } from "../../../lib/apiError";
import { logSlowApi } from "../../../utils/api";
import { withApiRoute } from "../../../lib/routeErrorHandler";

async function GETHandler() {
  const start = Date.now();
  try {
    const url = getOAuthUrl();
    const response = NextResponse.json({ url });
    logSlowApi("/api/connect", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "CONNECT_URL_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry connect action. If it persists, verify OAuth configuration.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/connect", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/connect', operation: 'GET' });
