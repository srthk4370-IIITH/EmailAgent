import { NextRequest, NextResponse } from "next/server";

import { db } from "../../../../db/client";
import { getConfig } from "../../../../db/config";
import { getDefaultEmailAccount } from "../../../../db/emailAccounts";
import { getDefaultSystemId } from "../../../../db/systems";
import { callLlm } from "../../../../services/llm";
import { mapSystemError } from "../../../../lib/errorMapper";
import { getRuntimeConfig } from "../../../../lib/runtimeConfig";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

function okResult() {
  return { ok: true, error: null, cause: null, fix: null, lastCheckedAt: new Date().toISOString() };
}

function failResult(error: string, cause: string, fix: string) {
  return { ok: false, error, cause, fix, lastCheckedAt: new Date().toISOString() };
}

async function checkDb() {
  try {
    await db.query("SELECT 1");
    return okResult();
  } catch (err) {
    const mapped = mapSystemError(err, {
      error: "DB_UNAVAILABLE",
      cause: err instanceof Error ? err.message : "connection_failed",
      fix: "Set a valid DATABASE_URL and ensure PostgreSQL is running.",
    });
    return failResult(mapped.error, mapped.cause, mapped.fix);
  }
}

async function checkOpenAi() {
  try {
    if (!(await getRuntimeConfig("OPENAI_API_KEY"))) {
      const mapped = mapSystemError("no_api_key", {
        error: "OPENAI_MISSING_KEY",
        cause: "missing_api_key",
        fix: "Set OPENAI_API_KEY in env and restart.",
      });
      return failResult(mapped.error, mapped.cause, mapped.fix);
    }
    const ping = await callLlm("Reply with: ok");
    if (ping.error) {
      const mapped = mapSystemError(ping.error, {
        error: "OPENAI_UNAVAILABLE",
        cause: ping.error,
        fix: "Verify API key, quota, and network connectivity, then retry.",
      });
      return failResult(mapped.error, mapped.cause, mapped.fix);
    }
    return okResult();
  } catch (err) {
    const mapped = mapSystemError(err, {
      error: "OPENAI_UNAVAILABLE",
      cause: err instanceof Error ? err.message : "unknown_error",
      fix: "Verify API key and retry diagnostics.",
    });
    return failResult(mapped.error, mapped.cause, mapped.fix);
  }
}

async function checkGmail() {
  try {
    const systemId = await getDefaultSystemId();
    const account = await getDefaultEmailAccount(systemId);
    if (!account) {
      const mapped = mapSystemError("gmail_account_missing", {
        error: "GMAIL_ACCOUNT_MISSING",
        cause: "no_default_account",
        fix: "Connect a Gmail account from onboarding Step 4.",
      });
      return failResult(mapped.error, mapped.cause, mapped.fix);
    }
    if (!account.oauth_refresh_token) {
      const mapped = mapSystemError("refresh_token_absent", {
        error: "GMAIL_OAUTH_MISSING",
        cause: "refresh_token_absent",
        fix: "Reconnect Gmail account to store refresh token.",
      });
      return failResult(mapped.error, mapped.cause, mapped.fix);
    }
    const config = await getConfig();
    const historyId = account ? account.last_history_id : config.last_gmail_history_id;
    if (!historyId) {
      const mapped = mapSystemError("history_cursor_missing", {
        error: "GMAIL_SYNC_NOT_INITIALIZED",
        cause: "history_cursor_missing",
        fix: "Run initial sync to initialize Gmail history cursor.",
      });
      return failResult(mapped.error, mapped.cause, mapped.fix);
    }
    return okResult();
  } catch (err) {
    const mapped = mapSystemError(err, {
      error: "GMAIL_CHECK_FAILED",
      cause: err instanceof Error ? err.message : "unknown_error",
      fix: "Reconnect Gmail account and retry diagnostics.",
    });
    return failResult(mapped.error, mapped.cause, mapped.fix);
  }
}

async function GETHandler() {
  const [dbStatus, openaiStatus, gmailStatus] = await Promise.all([checkDb(), checkOpenAi(), checkGmail()]);
  return NextResponse.json({ db: dbStatus, openai: openaiStatus, gmail: gmailStatus });
}

async function POSTHandler(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { targets?: string[] };
  const targets = new Set((body.targets ?? ["db", "openai", "gmail"]).map((x) => String(x).toLowerCase()));

  const result: Record<string, unknown> = {};
  if (targets.has("db")) result.db = await checkDb();
  if (targets.has("openai")) result.openai = await checkOpenAi();
  if (targets.has("gmail")) result.gmail = await checkGmail();

  return NextResponse.json(result);
}


export const GET = withApiRoute(GETHandler, { route: '/system/connections', operation: 'GET' });
export const POST = withApiRoute(POSTHandler, { route: '/system/connections', operation: 'POST' });
