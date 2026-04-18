import { NextResponse } from "next/server";

import { cleanupInjectedTestEmails } from "../../../../db/emails";
import { apiError } from "../../../../lib/apiError";
import { withApiRoute } from "../../../../lib/routeErrorHandler";
import { logSlowApi } from "../../../../utils/api";

async function POSTHandler() {
  const start = Date.now();
  try {
    const result = await cleanupInjectedTestEmails();
    const response = NextResponse.json({ ok: true, ...result });
    logSlowApi("/api/system/cleanup-injected", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "CLEANUP_INJECTED_EMAILS_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry cleanup. If it persists, verify database connectivity and table health.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/system/cleanup-injected", start);
    return response;
  }
}

export const POST = withApiRoute(POSTHandler, {
  route: "/system/cleanup-injected",
  operation: "POST",
});
