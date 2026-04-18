import { NextRequest, NextResponse } from "next/server";

import { apiError } from "../../../../../lib/apiError";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";

const scenarios: Record<string, { error: string; cause: string; fix: string }> = {
  oauth_invalid_grant: {
    error: "OAUTH_REFRESH_FAILED",
    cause: "invalid_grant",
    fix: "Reconnect Gmail account to renew authorization.",
  },
  db_unreachable: {
    error: "DB_QUERY_FAILED",
    cause: "connection_timeout",
    fix: "Verify DATABASE_URL and database availability.",
  },
  llm_timeout: {
    error: "GENERATION_FAILED",
    cause: "llm_timeout_or_rate_limit",
    fix: "Retry with lower concurrency and check OpenAI quota.",
  },
  sync_history_404: {
    error: "SYNC_CURSOR_INVALID",
    cause: "gmail_history_404",
    fix: "Run Gmail history reset diagnostics and resync.",
  },
};

async function POSTHandler(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { scenario?: string };
  const scenario = (body.scenario ?? "").trim();
  const item = scenarios[scenario];
  if (!item) {
    return NextResponse.json(
      apiError(
        "UNKNOWN_SCENARIO",
        "unsupported_simulation",
        "Use one of: oauth_invalid_grant, db_unreachable, llm_timeout, sync_history_404",
      ),
      { status: 400 },
    );
  }

  return NextResponse.json(apiError(item.error, item.cause, item.fix), { status: 500 });
}


export const POST = withApiRoute(POSTHandler, { route: '/system/diagnostics/simulate', operation: 'POST' });
