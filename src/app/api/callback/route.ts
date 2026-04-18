import { NextRequest, NextResponse } from "next/server";

import { exchangeCodeForTokens } from "../../../services/oauth";
import { apiError } from "../../../lib/apiError";
import { logSlowApi } from "../../../utils/api";
import { withApiRoute } from "../../../lib/routeErrorHandler";

async function GETHandler(request: NextRequest) {
  const start = Date.now();
  try {
    const code = request.nextUrl.searchParams.get("code");
    if (!code) {
      return NextResponse.json({ error: "Missing code" }, { status: 400 });
    }

    const tokens = await exchangeCodeForTokens(code);
    const response = NextResponse.json(tokens);
    logSlowApi("/api/callback", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "OAUTH_CALLBACK_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry OAuth callback. If it persists, reconnect your account.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/callback", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/callback', operation: 'GET' });
