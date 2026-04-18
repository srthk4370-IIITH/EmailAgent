import { NextResponse } from "next/server";

import { db } from "../../../../../db/client";
import { getDefaultSystemId } from "../../../../../db/systems";
import { getDefaultEmailAccount } from "../../../../../db/emailAccounts";
import { apiError } from "../../../../../lib/apiError";
import { getRuntimeConfig } from "../../../../../lib/runtimeConfig";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";

async function POSTHandler() {
  try {
    const systemId = await getDefaultSystemId();
    const account = await getDefaultEmailAccount(systemId);
    const openAiReady = Boolean(await getRuntimeConfig("OPENAI_API_KEY"));

    const checks: Array<{ check: string; ok: boolean; error?: string; cause?: string; fix?: string }> = [];

    try {
      await db.query("SELECT 1");
      checks.push({ check: "db_ping", ok: true });
    } catch (err) {
      checks.push({
        check: "db_ping",
        ok: false,
        error: "DB_QUERY_FAILED",
        cause: err instanceof Error ? err.message : "db_unreachable",
        fix: "Verify DATABASE_URL and database service health.",
      });
    }

    checks.push({
      check: "openai_key_present",
      ok: openAiReady,
      ...(openAiReady
        ? {}
        : {
            error: "OPENAI_MISSING_KEY",
            cause: "missing_api_key",
            fix: "Set OPENAI_API_KEY and retry diagnostics.",
          }),
    });

    checks.push({
      check: "gmail_account_token",
      ok: Boolean(account?.oauth_refresh_token),
      ...(account?.oauth_refresh_token
        ? {}
        : {
            error: "OAUTH_REFRESH_FAILED",
            cause: "missing_refresh_token",
            fix: "Reconnect Gmail account from onboarding.",
          }),
    });

    for (const c of checks) {
      await db.query(
        `INSERT INTO system_diagnostics (system_id, account_id, check_type, ok, error, cause, fix, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [systemId, account?.id ?? null, c.check, c.ok, c.error ?? null, c.cause ?? null, c.fix ?? null, JSON.stringify({})],
      );
    }

    return NextResponse.json({ ok: true, checks });
  } catch (err) {
    return NextResponse.json(
      apiError(
        "DIAGNOSTICS_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry diagnostics after checking DB connectivity.",
      ),
      { status: 500 },
    );
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/system/diagnostics/run', operation: 'POST' });
