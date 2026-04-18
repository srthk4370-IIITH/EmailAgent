import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import OpenAI from "openai";
import { Pool } from "pg";
import { z } from "zod";
import { google } from "googleapis";

import {
  clearOnboardingDraft,
  getDefaultSystemId,
  getOnboardingDraft,
  getSystemById,
  saveOnboardingDraft,
  updateOnboardingState,
} from "../../../../db/systems";
import { getDefaultEmailAccount } from "../../../../db/emailAccounts";
import { db } from "../../../../db/client";
import { apiError } from "../../../../lib/apiError";
import { callLlm } from "../../../../services/llm";
import { getOAuthClient } from "../../../../services/oauth";
import { getConfig } from "../../../../db/config";
import { mapSystemError } from "../../../../lib/errorMapper";
import { decryptOnboardingDraft, encryptOnboardingDraft, type OnboardingDraft } from "../../../../lib/onboardingDraftCrypto";
import { maskSecretPreview, redactSensitiveText } from "../../../../lib/redaction";
import { getRuntimeConfig, setRuntimeConfigValues } from "../../../../lib/runtimeConfig";
import { sendManualGmailEmail } from "../../../../services/sendManual";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

const stateOrder = [
  "system_created",
  "openai_ready",
  "db_ready",
  "oauth_ready",
  "gmail_connected",
  "final_validation_complete",
] as const;

const onboardingSteps = ["openai", "database", "oauth", "gmail", "final_validation"] as const;
type OnboardingStep = (typeof onboardingSteps)[number];

const requiredScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
];

const requiredDatabaseTables = ["systems", "email_accounts", "emails", "config", "logs"] as const;

const bodySchema = z.object({
  action: z
    .enum(["validate", "validate_step", "advance", "retry", "run_final_validation", "save_step_input", "readiness"])
    .default("validate"),
  step: z.enum(onboardingSteps).optional(),
  payload: z
    .object({
      openaiKey: z.string().optional(),
      databaseProvider: z.enum(["postgresql", "supabase", "firebase"]).optional(),
      databaseUrl: z.string().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      redirectUri: z.string().optional(),
    })
    .optional(),
});

type ReadinessIssue = {
  code: string;
  cause: string;
  fix: string;
  step: OnboardingStep;
};

type ReadinessStatus = {
  ready: boolean;
  issues: ReadinessIssue[];
};

function rank(state: string) {
  const idx = stateOrder.indexOf(state as (typeof stateOrder)[number]);
  return idx >= 0 ? idx : 0;
}

function mapStateToStepIndex(state: string): number {
  if (state === "openai_ready") return 1;
  if (state === "db_ready") return 2;
  if (state === "oauth_ready") return 3;
  if (state === "gmail_connected") return 4;
  if (state === "final_validation_complete") return 5;
  return 0;
}

function withDebug(traceId: string, endpoint: string) {
  return {
    debug: {
      traceId,
      endpoint,
      timestamp: new Date().toISOString(),
    },
  };
}

function sanitizeMessage(value: string | undefined) {
  if (!value) return value;
  return redactSensitiveText(value);
}

function sanitizeValidationResult<T extends Record<string, unknown>>(result: T): T {
  return {
    ...result,
    ...(typeof result.cause === "string" ? { cause: sanitizeMessage(result.cause) } : {}),
    ...(typeof result.message === "string" ? { message: sanitizeMessage(result.message) } : {}),
    ...(typeof result.fix === "string" ? { fix: sanitizeMessage(result.fix) } : {}),
  };
}

async function listMissingDatabaseTables(overrideDatabaseUrl?: string): Promise<string[]> {
  const localPool =
    overrideDatabaseUrl && overrideDatabaseUrl.length > 0
      ? new Pool({ connectionString: overrideDatabaseUrl })
      : null;
  const client = localPool ?? db;

  try {
    const rows = await Promise.all(
      requiredDatabaseTables.map(async (table) => {
        const lookup = await client.query<{ exists: string | null }>("SELECT to_regclass($1)::text AS exists", [
          `public.${table}`,
        ]);
        return { table, exists: Boolean(lookup.rows[0]?.exists) };
      }),
    );
    return rows.filter((item) => !item.exists).map((item) => item.table);
  } finally {
    await localPool?.end().catch(() => undefined);
  }
}

async function buildReadinessStatus(origin: string): Promise<ReadinessStatus> {
  const issues: ReadinessIssue[] = [];
  const [openAiKey, clientId, clientSecret, redirectUri] = await Promise.all([
    getRuntimeConfig("OPENAI_API_KEY"),
    getRuntimeConfig("GMAIL_CLIENT_ID"),
    getRuntimeConfig("GMAIL_CLIENT_SECRET"),
    getRuntimeConfig("GMAIL_REDIRECT_URI"),
  ]);

  if (!openAiKey) {
    issues.push({
      code: "OPENAI_ENV_MISSING",
      cause: "OpenAI key is not configured yet.",
      fix: "Create an OpenAI secret key and paste it into step 1.",
      step: "openai",
    });
  }

  const databaseReady = await db.query("SELECT 1").then(() => true).catch(() => false);
  if (!databaseReady) {
    issues.push({
      code: "DATABASE_UNAVAILABLE",
      cause: "Database is unreachable with current settings.",
      fix: "Confirm DATABASE_URL, database host availability, and SSL settings.",
      step: "database",
    });
  }

  const expectedRedirect = `${origin}/api/auth/google/callback`;
  if (!clientId || !clientSecret || !redirectUri) {
    issues.push({
      code: "OAUTH_ENV_MISSING",
      cause: "Google OAuth credentials are incomplete.",
      fix: "Fill client ID, client secret, and redirect URI in step 3.",
      step: "oauth",
    });
  } else if (redirectUri !== expectedRedirect) {
    issues.push({
      code: "OAUTH_REDIRECT_MISMATCH",
      cause: "Configured redirect URI does not match the current app callback.",
      fix: `Use this exact value in Google Cloud and onboarding: ${expectedRedirect}`,
      step: "oauth",
    });
  }

  const systemId = await getDefaultSystemId();
  const account = await getDefaultEmailAccount(systemId);
  if (!account?.oauth_refresh_token) {
    issues.push({
      code: "GMAIL_NOT_CONNECTED",
      cause: "No connected Gmail account found for this system.",
      fix: "Use the Connect Gmail button in step 4 and grant all required scopes.",
      step: "gmail",
    });
  }

  return {
    ready: issues.length === 0,
    issues,
  };
}

function toClientSafeDraft(draft: OnboardingDraft | null) {
  if (!draft) return null;
  return {
    databaseProvider: draft.databaseProvider,
    redirectUri: draft.redirectUri,
    clientId: draft.clientId,
    updatedAt: draft.updatedAt,
    hasOpenAiKey: Boolean(draft.openaiKey),
    hasDatabaseUrl: Boolean(draft.databaseUrl),
    hasClientSecret: Boolean(draft.clientSecret),
    openaiKeyPreview: draft.openaiKey ? maskSecretPreview(draft.openaiKey) : "",
    databaseUrlPreview: draft.databaseUrl ? maskSecretPreview(draft.databaseUrl) : "",
    clientSecretPreview: draft.clientSecret ? maskSecretPreview(draft.clientSecret) : "",
  };
}

async function persistRuntimeConfigFromDraft(draft: OnboardingDraft | undefined): Promise<void> {
  if (!draft) return;

  await setRuntimeConfigValues({
    ...(draft.openaiKey ? { OPENAI_API_KEY: draft.openaiKey } : {}),
    ...(draft.databaseUrl ? { DATABASE_URL: draft.databaseUrl } : {}),
    ...(draft.clientId ? { GMAIL_CLIENT_ID: draft.clientId } : {}),
    ...(draft.clientSecret ? { GMAIL_CLIENT_SECRET: draft.clientSecret } : {}),
    ...(draft.redirectUri ? { GMAIL_REDIRECT_URI: draft.redirectUri } : {}),
  });
}

async function pingOpenAiWithKey(apiKey: string): Promise<string | null> {
  try {
    const client = new OpenAI({ apiKey });
    await client.responses.create({
      model: "gpt-4.1-mini",
      input: "Reply with only: ok",
      max_output_tokens: 5,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "openai_unavailable";
  }
}

async function validateOpenAi(overrideKey?: string) {
  const openAiKey = overrideKey || (await getRuntimeConfig("OPENAI_API_KEY"));
  if (!openAiKey) {
    return {
      ok: false,
      ...mapSystemError("no_api_key", {
        error: "OPENAI_MISSING_KEY",
        cause: "missing_api_key",
        fix: "Add your OpenAI key in onboarding Step 1 and retry.",
      }),
    };
  }

  const overridePingError = overrideKey ? await pingOpenAiWithKey(overrideKey) : null;
  const ping = overrideKey ? null : await callLlm("Reply with only: ok");
  const pingError = overridePingError ?? ping?.error;

  if (pingError) {
    return {
      ok: false,
      ...mapSystemError(pingError, {
        error: "OPENAI_UNAVAILABLE",
        cause: pingError,
        fix: "Verify OpenAI key and billing, then retry.",
      }),
      remediationStep: "openai",
    };
  }

  if (overrideKey) {
    await setRuntimeConfigValues({ OPENAI_API_KEY: overrideKey });
  }

  return {
    ok: true,
    message: "OpenAI is connected and responding.",
    remediationStep: "openai",
  };
}

async function validateDatabase(overrideDatabaseUrl?: string) {
  const localPool =
    overrideDatabaseUrl && overrideDatabaseUrl.length > 0
      ? new Pool({ connectionString: overrideDatabaseUrl })
      : null;
  const queryRunner = localPool ? (sql: string) => localPool.query(sql) : (sql: string) => db.query(sql);

  try {
    await queryRunner("SELECT 1");
    await queryRunner("BEGIN");
    await queryRunner("CREATE TEMP TABLE onboarding_validation_temp (id INTEGER)");
    await queryRunner("INSERT INTO onboarding_validation_temp (id) VALUES (1)");
    const read = localPool
      ? await localPool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM onboarding_validation_temp")
      : await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM onboarding_validation_temp");
    await queryRunner("ROLLBACK");
    await localPool?.end();
    const ok = Number(read.rows[0]?.count ?? 0) === 1;
    if (!ok) {
      return {
        ok: false,
        ...mapSystemError("db_read_write_failed", {
          error: "DATABASE_READ_WRITE_FAILED",
          cause: "Validation insert/read test did not return expected results.",
          fix: "Ensure DB user has create/insert/select privileges and retry.",
        }),
      };
    }
    const missingTables = await listMissingDatabaseTables(overrideDatabaseUrl);
    if (missingTables.length > 0) {
      return {
        ok: false,
        ...mapSystemError("missing_tables", {
          error: "DATABASE_SCHEMA_MISSING",
          cause: `Database is reachable, but required tables are missing: ${missingTables.join(", ")}.`,
          fix: "Run database initialization/migrations (for example: npm run db:init) and retry.",
        }),
        remediationStep: "database",
      };
    }

    return {
      ok: true,
      message: "Database connection, read/write, and schema checks passed.",
      remediationStep: "database",
    };
  } catch (err) {
    await queryRunner("ROLLBACK").catch(() => undefined);
    await localPool?.end().catch(() => undefined);
    return {
      ok: false,
      ...mapSystemError(err, {
        error: "DATABASE_UNAVAILABLE",
        cause: err instanceof Error ? err.message : "connection_failed",
        fix: "Check DATABASE_URL and PostgreSQL availability.",
      }),
      remediationStep: "database",
    };
  }
}

async function validateOAuth(origin: string, draft?: OnboardingDraft) {
  try {
    const clientId = draft?.clientId || (await getRuntimeConfig("GMAIL_CLIENT_ID"));
    const clientSecret = draft?.clientSecret || (await getRuntimeConfig("GMAIL_CLIENT_SECRET"));
    const redirectUri = draft?.redirectUri || (await getRuntimeConfig("GMAIL_REDIRECT_URI"));
    const expected = `${origin}/api/auth/google/callback`;

    if (!clientId || !clientSecret || !redirectUri) {
      return {
        ok: false,
        ...mapSystemError("missing_oauth_env", {
          error: "OAUTH_ENV_MISSING",
          cause: "Missing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, or GMAIL_REDIRECT_URI.",
          fix: "Enter Google OAuth Client ID, Client Secret, and Redirect URI in onboarding Step 3.",
        }),
        expectedRedirectUri: expected,
        remediationStep: "oauth",
      };
    }

    if (redirectUri !== expected) {
      return {
        ok: false,
        ...mapSystemError("redirect_mismatch", {
          error: "OAUTH_REDIRECT_MISMATCH",
          cause: `Configured redirect URI (${redirectUri}) does not match expected callback (${expected}).`,
          fix: "Update GMAIL_REDIRECT_URI and Google Cloud OAuth redirect URI to exactly match the expected callback.",
        }),
        expectedRedirectUri: expected,
        remediationStep: "oauth",
      };
    }

    // Validate creds with a dry OAuth client construction.
    new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    if (draft) {
      await persistRuntimeConfigFromDraft(draft);
    }

    return {
      ok: true,
      message: "Google OAuth configuration is valid.",
      expectedRedirectUri: expected,
      remediationStep: "oauth",
    };
  } catch (err) {
    return {
      ok: false,
      ...mapSystemError(err, {
        error: "OAUTH_VALIDATION_FAILED",
        cause: err instanceof Error ? err.message : "oauth_validation_failed",
        fix: "Review Google OAuth app settings and retry.",
      }),
      expectedRedirectUri: `${origin}/api/auth/google/callback`,
      remediationStep: "oauth",
    };
  }
}

async function validateGmail() {
  try {
    const systemId = await getDefaultSystemId();
    const account = await getDefaultEmailAccount(systemId);

    if (!account?.oauth_refresh_token) {
      return {
        ok: false,
        ...mapSystemError("missing_refresh_token", {
          error: "GMAIL_OAUTH_MISSING",
          cause: "No Gmail refresh token found for the default account.",
          fix: "Connect Gmail from onboarding and approve requested permissions.",
        }),
        remediationStep: "gmail",
      };
    }

    const oauth = getOAuthClient();
    oauth.setCredentials({ refresh_token: account.oauth_refresh_token });
    const { credentials } = await oauth.refreshAccessToken();
    const accessToken = credentials.access_token;
    if (!accessToken) {
      return {
        ok: false,
        ...mapSystemError("access_token_missing", {
          error: "GMAIL_TOKEN_REFRESH_FAILED",
          cause: "Unable to refresh Gmail access token.",
          fix: "Reconnect Gmail and ensure consent was granted.",
        }),
        remediationStep: "gmail",
      };
    }

    const info = await oauth.getTokenInfo(accessToken);
    const granted = new Set(info.scopes ?? []);
    const missingScopes = requiredScopes.filter((scope) => !granted.has(scope));
    if (missingScopes.length > 0) {
      return {
        ok: false,
        ...mapSystemError("missing_scopes", {
          error: "GMAIL_SCOPES_MISSING",
          cause: `Missing required Gmail scopes: ${missingScopes.join(", ")}`,
          fix: "Reconnect Gmail and grant all required scopes shown in onboarding.",
        }),
        missingScopes,
        remediationStep: "gmail",
      };
    }

    const gmail = google.gmail({ version: "v1", auth: oauth });
    await gmail.users.getProfile({ userId: "me" });

    const config = await getConfig();
    const historyId = account ? account.last_history_id : config.last_gmail_history_id;
    if (!historyId) {
      return {
        ok: false,
        ...mapSystemError("history_cursor_missing", {
          error: "GMAIL_SYNC_NOT_INITIALIZED",
          cause: "History cursor is missing. Initial Gmail sync has not completed.",
          fix: "Run initial sync from onboarding and retry.",
        }),
        remediationStep: "gmail",
      };
    }

    return {
      ok: true,
      message: "Gmail account, scopes, and sync cursor are valid.",
      remediationStep: "gmail",
    };
  } catch (err) {
    return {
      ok: false,
      ...mapSystemError(err, {
        error: "GMAIL_VALIDATION_FAILED",
        cause: err instanceof Error ? err.message : "gmail_validation_failed",
        fix: "Reconnect Gmail and retry validation.",
      }),
      remediationStep: "gmail",
    };
  }
}

async function validateGmailSendProbe() {
  try {
    const systemId = await getDefaultSystemId();
    const account = await getDefaultEmailAccount(systemId);
    if (!account?.id || !account.email_address) {
      return {
        ok: false,
        ...mapSystemError("missing_default_account", {
          error: "GMAIL_SEND_PROBE_ACCOUNT_MISSING",
          cause: "No default Gmail account is available for send verification.",
          fix: "Reconnect Gmail in step 4 and retry final validation.",
        }),
        remediationStep: "gmail",
      };
    }

    const token = Math.random().toString(36).slice(2, 8).toUpperCase();
    await sendManualGmailEmail({
      accountId: account.id,
      to: account.email_address,
      subject: `[EmailAgent Validation] ${new Date().toISOString()}`,
      body: `This is an automated onboarding delivery test. Token: ${token}.`,
    });

    return {
      ok: true,
      message: "Gmail send probe succeeded by delivering a test message to the connected inbox.",
      remediationStep: "gmail",
    };
  } catch (err) {
    return {
      ok: false,
      ...mapSystemError(err, {
        error: "GMAIL_SEND_PROBE_FAILED",
        cause: err instanceof Error ? err.message : "gmail_send_probe_failed",
        fix: "Reconnect Gmail and confirm send permission is granted, then retry final validation.",
      }),
      remediationStep: "gmail",
    };
  }
}

async function validateFinal(origin: string, draft?: OnboardingDraft) {
  const [openai, database, oauth, gmail, gmailSendProbe] = await Promise.all([
    validateOpenAi(draft?.openaiKey),
    validateDatabase(draft?.databaseUrl),
    validateOAuth(origin, draft),
    validateGmail(),
    validateGmailSendProbe(),
  ]);

  const checks = { openai, database, oauth, gmail, gmailSendProbe };
  const ok = openai.ok && database.ok && oauth.ok && gmail.ok && gmailSendProbe.ok;
  return { ok, checks };
}

function getCurrentStateFromChecks(checks: {
  openai: boolean;
  database: boolean;
  oauth: boolean;
  gmail: boolean;
  finalValidation: boolean;
}) {
  if (checks.finalValidation) return "final_validation_complete";
  if (checks.gmail) return "gmail_connected";
  if (checks.oauth) return "oauth_ready";
  if (checks.database) return "db_ready";
  if (checks.openai) return "openai_ready";
  return "system_created";
}

async function GETHandler(request: NextRequest) {
  const traceId = randomUUID();
  try {
    const systemId = await getDefaultSystemId();
    const system = await getSystemById(systemId);
    const account = await getDefaultEmailAccount(systemId);
    const encryptedDraft = await getOnboardingDraft(systemId);
    const draft = decryptOnboardingDraft(encryptedDraft);
    if (encryptedDraft && !draft) {
      await clearOnboardingDraft(systemId);
    }

    const dbReady = await db.query("SELECT 1").then(() => true).catch(() => false);
    const [openAiKey, clientId, clientSecret, redirectUri] = await Promise.all([
      getRuntimeConfig("OPENAI_API_KEY"),
      getRuntimeConfig("GMAIL_CLIENT_ID"),
      getRuntimeConfig("GMAIL_CLIENT_SECRET"),
      getRuntimeConfig("GMAIL_REDIRECT_URI"),
    ]);
    const openAiReady = Boolean(openAiKey);
    const oauthReady = Boolean(clientId && clientSecret && redirectUri);
    const gmailConnected = Boolean(account?.oauth_refresh_token);
    const finalValidation = rank(system?.onboarding_state ?? "system_created") >= rank("final_validation_complete");

    const steps = onboardingSteps.map((step, idx) => ({
      id: step,
      order: idx + 1,
      title:
        step === "openai"
          ? "OpenAI API Key"
          : step === "database"
            ? "Database setup"
            : step === "oauth"
              ? "OAuth setup"
              : step === "gmail"
                ? "Gmail integration"
                : "Final system validation",
    }));

    const derivedState = getCurrentStateFromChecks({
      openai: openAiReady,
      database: dbReady,
      oauth: oauthReady,
      gmail: gmailConnected,
      finalValidation,
    });

    const readiness = await buildReadinessStatus(request.nextUrl.origin);

    return NextResponse.json({
      systemId,
      current: derivedState,
      persistedState: system?.onboarding_state ?? "system_created",
      currentStepIndex: mapStateToStepIndex(derivedState),
      completed: derivedState === "final_validation_complete",
      checks: {
        openai: openAiReady,
        database: dbReady,
        oauth: oauthReady,
        gmail: gmailConnected,
        final_validation: finalValidation,
      },
      steps,
      draft: toClientSafeDraft(draft),
      readiness,
      ...withDebug(traceId, "GET /api/system/onboarding"),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ...apiError(
          "ONBOARDING_STATUS_FAILED",
          sanitizeMessage(err instanceof Error ? err.message : "unknown_error") ?? "unknown_error",
          "Retry onboarding status check after verifying DB health.",
        ),
        ...withDebug(traceId, "GET /api/system/onboarding"),
      },
      { status: 500 },
    );
  }
}

async function POSTHandler(request: NextRequest) {
  const traceId = randomUUID();
  try {
    const payload = bodySchema.parse(await request.json().catch(() => ({})));
    const systemId = await getDefaultSystemId();
    const origin = request.nextUrl.origin;
    const requestDraft: OnboardingDraft | undefined = payload.payload
      ? {
          ...(payload.payload.openaiKey ? { openaiKey: payload.payload.openaiKey } : {}),
          ...(payload.payload.databaseProvider ? { databaseProvider: payload.payload.databaseProvider } : {}),
          ...(payload.payload.databaseUrl ? { databaseUrl: payload.payload.databaseUrl } : {}),
          ...(payload.payload.clientId ? { clientId: payload.payload.clientId } : {}),
          ...(payload.payload.clientSecret ? { clientSecret: payload.payload.clientSecret } : {}),
          ...(payload.payload.redirectUri ? { redirectUri: payload.payload.redirectUri } : {}),
          updatedAt: new Date().toISOString(),
        }
      : undefined;

    if (payload.action === "retry" || payload.action === "validate") {
      return GET(request);
    }

    if (payload.action === "readiness") {
      const readiness = await buildReadinessStatus(origin);
      return NextResponse.json({ readiness, ...withDebug(traceId, "POST /api/system/onboarding readiness") });
    }

    if (payload.action === "save_step_input") {
      if (requestDraft) {
        await persistRuntimeConfigFromDraft(requestDraft);
        await saveOnboardingDraft(systemId, encryptOnboardingDraft(requestDraft));
      }
      return NextResponse.json({ ok: true, ...withDebug(traceId, "POST /api/system/onboarding save_step_input") });
    }

    if (payload.action === "validate_step") {
      if (!payload.step) {
        return NextResponse.json(
          apiError("STEP_REQUIRED", "Missing onboarding step identifier.", "Retry and select a step to validate."),
          { status: 400 },
        );
      }

      const readiness = await buildReadinessStatus(origin);

      const result =
        payload.step === "openai"
          ? await validateOpenAi(requestDraft?.openaiKey)
          : payload.step === "database"
            ? await validateDatabase(requestDraft?.databaseUrl)
            : payload.step === "oauth"
              ? await validateOAuth(origin, requestDraft)
              : payload.step === "gmail"
                ? await validateGmail()
                : await validateFinal(origin, requestDraft);

      const sanitized = sanitizeValidationResult(result);

      if (sanitized.ok) {
        await persistRuntimeConfigFromDraft(requestDraft);
        const nextState =
          payload.step === "openai"
            ? "openai_ready"
            : payload.step === "database"
              ? "db_ready"
              : payload.step === "oauth"
                ? "oauth_ready"
                : payload.step === "gmail"
                  ? "gmail_connected"
                  : "final_validation_complete";
        await updateOnboardingState(systemId, nextState);
        if (payload.step === "final_validation") {
          await clearOnboardingDraft(systemId);
        }
      }

      return NextResponse.json({
        step: payload.step,
        ...sanitized,
        readiness,
        ...withDebug(traceId, "POST /api/system/onboarding validate_step"),
      });
    }

    if (payload.action === "run_final_validation") {
      const readiness = await buildReadinessStatus(origin);
      const finalResult = await validateFinal(origin, requestDraft);
      const sanitizedFinal = sanitizeValidationResult(finalResult);
      if (sanitizedFinal.ok) {
        await persistRuntimeConfigFromDraft(requestDraft);
        await updateOnboardingState(systemId, "final_validation_complete");
        await clearOnboardingDraft(systemId);
      }
      return NextResponse.json({
        ...sanitizedFinal,
        readiness,
        ...withDebug(traceId, "POST /api/system/onboarding run_final_validation"),
      });
    }

    const system = await getSystemById(systemId);
    const current = system?.onboarding_state ?? "system_created";

    const currentIdx = rank(current);
    const next = stateOrder[Math.min(currentIdx + 1, stateOrder.length - 1)] ?? "final_validation_complete";
    await updateOnboardingState(systemId, next);

    return NextResponse.json({ ok: true, state: next, ...withDebug(traceId, "POST /api/system/onboarding advance") });
  } catch (err) {
    return NextResponse.json(
      {
        ...apiError(
          "ONBOARDING_UPDATE_FAILED",
          sanitizeMessage(err instanceof Error ? err.message : "invalid_request") ?? "invalid_request",
          "Retry onboarding progression; if it fails, run diagnostics.",
        ),
        ...withDebug(traceId, "POST /api/system/onboarding"),
      },
      { status: 400 },
    );
  }
}


export const GET = withApiRoute(GETHandler, { route: '/system/onboarding', operation: 'GET' });
export const POST = withApiRoute(POSTHandler, { route: '/system/onboarding', operation: 'POST' });
