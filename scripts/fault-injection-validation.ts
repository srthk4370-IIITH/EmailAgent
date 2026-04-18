import { db, initDbSchema } from "../src/db/client";
import { getDefaultSystemId } from "../src/db/systems";
import {
  getDefaultEmailAccount,
  resolveDefaultAccountId,
} from "../src/db/emailAccounts";
import { ingestInboxEmails, processEmailById } from "../src/core/processor";
import {
  insertEmailIfNotExists,
  getEmailById,
  type EmailRecord,
} from "../src/db/emails";
import { getRelevantContext } from "../src/core/rag";
import { callLlm, getLlmFailureState } from "../src/services/llm";

function nowId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function logBlock(title: string, payload: unknown) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
}

async function insertInboundEmail(systemId: number, accountId: number, subject: string, body: string): Promise<number> {
  const inserted = await insertEmailIfNotExists({
    systemId,
    accountId,
    gmailId: nowId("fi-inbox"),
    traceId: nowId("trace"),
    threadId: nowId("thread"),
    fromEmail: "fault.inject@example.com",
    subject,
    body,
    snippet: body.slice(0, 140),
    internalDate: Date.now(),
    source: "inbox",
    state: "INGESTED",
  });
  if (!inserted) throw new Error("insertInboundEmail failed");
  return inserted.id;
}

async function processUntilSettled(emailId: number, loops = 18): Promise<EmailRecord | null> {
  let out: EmailRecord | null = null;
  for (let i = 0; i < loops; i++) {
    await processEmailById(emailId);
    await new Promise((r) => setTimeout(r, 300));
    out = await getEmailById(emailId);
    if (!out) return out;
    if (["SENT", "READY_TO_SEND", "AWAITING_REVIEW", "ERROR_FATAL", "DEAD", "GENERATED", "READY_TO_GENERATE", "ERROR_TEMP"].includes(out.state)) {
      return out;
    }
  }
  return out;
}

async function runScenario(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    logBlock(`${name}_ERROR`, {
      error: String(error),
    });
  }
}

async function main() {
  await initDbSchema();
  const systemId = await getDefaultSystemId();
  const accountId = await resolveDefaultAccountId(systemId);
  if (!accountId) throw new Error("No default account_id");

  const accountBefore = await getDefaultEmailAccount(systemId);
  if (!accountBefore) throw new Error("No default email account row");

  const envSnapshot = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
  };

  logBlock("CONTEXT", {
    systemId,
    accountId,
    accountBefore: {
      id: accountBefore.id,
      status: accountBefore.status,
      hasRefreshToken: Boolean(accountBefore.oauth_refresh_token),
      last_history_id: accountBefore.last_history_id,
    },
    env: {
      hasOpenAiKey: Boolean(envSnapshot.OPENAI_API_KEY),
      httpProxy: envSnapshot.HTTP_PROXY ?? null,
      httpsProxy: envSnapshot.HTTPS_PROXY ?? null,
    },
  });

  await runScenario("SCENARIO_1_GMAIL_INVALID_GRANT", async () => {
    // Scenario 1: Gmail invalid_grant
    await db.query(
    `UPDATE email_accounts
       SET oauth_refresh_token = $1,
           oauth_token_expiry = NOW() - INTERVAL '1 day',
           status = 'active',
           updated_at = NOW()
     WHERE id = $2`,
    ["invalid-grant-fi-token", accountId],
    );
    await ingestInboxEmails();
    await ingestInboxEmails();

    const s1Account = await db.query(
    `SELECT id, status, oauth_refresh_token IS NULL AS token_cleared, last_history_id
     FROM email_accounts WHERE id = $1`,
    [accountId],
    );
    const s1Health = await db.query(
    `SELECT service, status, error_message, last_checked_at
     FROM system_health WHERE service = 'gmail'`,
    );
    const s1UiAccounts = await db.query(
    `SELECT id, email_address, status, last_sync_at FROM email_accounts WHERE system_id = $1 ORDER BY id ASC`,
    [systemId],
    );
    logBlock("SCENARIO_1_GMAIL_INVALID_GRANT", {
      account: s1Account.rows,
      gmail_health: s1Health.rows,
      ui_accounts: s1UiAccounts.rows,
    });
  });

  // Restore account token state for next scenarios
  await db.query(
    `UPDATE email_accounts
       SET oauth_refresh_token = $1,
           oauth_token_expiry = $2,
           status = $3,
           last_history_id = $4,
           updated_at = NOW()
     WHERE id = $5`,
    [
      accountBefore.oauth_refresh_token,
      accountBefore.oauth_token_expiry,
      accountBefore.status,
      accountBefore.last_history_id,
      accountId,
    ],
  );

  // Scenario 2: startHistoryId failure (best-effort; requires valid Gmail token)
  await runScenario("SCENARIO_2_START_HISTORY_ID", async () => {
    if (!accountBefore.oauth_refresh_token) {
      logBlock("SCENARIO_2_START_HISTORY_ID", {
        blocked: true,
        reason: "No valid oauth_refresh_token present; cannot deterministically hit Gmail History API invalid startHistoryId path.",
      });
      return;
    }
    await db.query(`UPDATE email_accounts SET status='active', last_history_id='1', updated_at=NOW() WHERE id = $1`, [accountId]);
    await ingestInboxEmails();
    const s2Logs = await db.query(
      `SELECT id, trace_id, step, state, error, created_at
       FROM logs
       WHERE step LIKE 'gmail_invalid_start_history_id%'
          OR step = 'gmail_full_resync_complete'
       ORDER BY id DESC
       LIMIT 20`,
    );
    const s2Account = await db.query(`SELECT id, status, last_history_id, last_sync_at FROM email_accounts WHERE id = $1`, [accountId]);
    const s2Health = await db.query(`SELECT service, status, error_message, meta, last_checked_at FROM system_health WHERE service='gmail'`);
    logBlock("SCENARIO_2_START_HISTORY_ID", {
      logs: s2Logs.rows,
      account: s2Account.rows,
      gmail_health: s2Health.rows,
    });
    await db.query(`UPDATE email_accounts SET last_history_id = $1, updated_at=NOW() WHERE id = $2`, [accountBefore.last_history_id, accountId]);
  });

  await runScenario("SCENARIO_3_OPENAI_FAILURE", async () => {
    // Scenario 3: OpenAI hard failure fallback path
    process.env.OPENAI_API_KEY = "sk-fi-invalid-key";
    const s3EmailId = await insertInboundEmail(systemId, accountId, "OpenAI fail path", "Please draft a response for account billing question.");
    const s3Row = await processUntilSettled(s3EmailId);
    const s3Db = await db.query(
    `SELECT id, state, decision, last_step, decision_reason, retry_count, attempt_count, next_attempt_at
     FROM emails WHERE id = $1`,
    [s3EmailId],
    );
    const s3Trace = await db.query(
    `SELECT id, step, state, error, created_at
     FROM logs
     WHERE trace_id = (SELECT trace_id FROM emails WHERE id = $1)
       AND (step LIKE '%llm%' OR step LIKE '%manual%' OR step LIKE '%generate%')
     ORDER BY id ASC`,
    [s3EmailId],
    );
    const s3Health = await db.query(`SELECT service, status, error_message, last_checked_at FROM system_health WHERE service='openai'`);
    logBlock("SCENARIO_3_OPENAI_FAILURE", {
      email: s3Db.rows,
      trace: s3Trace.rows,
      openai_health: s3Health.rows,
      llm_failure_state: getLlmFailureState(),
      settled_snapshot: s3Row
        ? {
            state: s3Row.state,
            decision: s3Row.decision,
            last_step: s3Row.last_step,
            decision_reason: s3Row.decision_reason,
          }
        : null,
    });
  });

  await runScenario("SCENARIO_4_NETWORK_DROP", async () => {
    // Scenario 4: Network drop (proxy blackhole)
    process.env.OPENAI_API_KEY = envSnapshot.OPENAI_API_KEY;
    process.env.HTTP_PROXY = "http://127.0.0.1:9";
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    const s4a = await callLlm("Reply with exactly: ok", { task: "fi_network_drop_a" });
    const s4b = await callLlm("Reply with exactly: ok", { task: "fi_network_drop_b" });
    logBlock("SCENARIO_4_NETWORK_DROP", {
      attemptA: s4a,
      attemptB: s4b,
      llm_failure_state: getLlmFailureState(),
    });
    process.env.HTTP_PROXY = envSnapshot.HTTP_PROXY;
    process.env.HTTPS_PROXY = envSnapshot.HTTPS_PROXY;
  });

  await runScenario("SCENARIO_5_RAG_FAILURE", async () => {
    // Scenario 5: RAG failure -> fallback metadata/log
    process.env.OPENAI_API_KEY = "sk-fi-invalid-key";
    const s5EmailId = await insertInboundEmail(systemId, accountId, "RAG fail path", "Need precise pricing and discount policy details.");
    await db.query(
    `UPDATE emails
       SET state='READY_TO_GENERATE', decision='auto', category='Asking about my product/business', confidence=0.95, last_step='decide', updated_at=NOW()
     WHERE id = $1`,
    [s5EmailId],
    );
    await processEmailById(s5EmailId);
    const s5Trace = await db.query(
    `SELECT id, step, state, error, created_at
     FROM logs
     WHERE trace_id = (SELECT trace_id FROM emails WHERE id = $1)
       AND (step LIKE '%rag%' OR step LIKE '%fallback%' OR step LIKE '%generate%' OR step LIKE '%manual%')
     ORDER BY id ASC`,
    [s5EmailId],
    );
    const s5Email = await db.query(`SELECT id, state, decision, last_step, decision_reason FROM emails WHERE id = $1`, [s5EmailId]);
    let s5Direct: unknown = null;
    try {
      s5Direct = await getRelevantContext(
        "Pricing",
        "Need pricing context",
        { accountId, threadId: nowId("fi-rag-thread") },
      );
    } catch (e) {
      s5Direct = { thrown: String(e) };
    }
    logBlock("SCENARIO_5_RAG_FAILURE", {
      email: s5Email.rows,
      trace: s5Trace.rows,
      direct_getRelevantContext: s5Direct,
    });
  });

  await runScenario("SCENARIO_6_WORKER_LOOP_STRESS", async () => {
    // Scenario 6: Worker loop stress without external breaker dependency.
    process.env.OPENAI_API_KEY = "sk-fi-invalid-key";
    const s6EmailId = await insertInboundEmail(systemId, accountId, "Loop stress seed", "Need answer for pricing quickly.");
    const s6Settled = await processUntilSettled(s6EmailId);
    const s6Before = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM logs
       WHERE trace_id = (SELECT trace_id FROM emails WHERE id = $1)
         AND step IN ('assist_stop_generated','manual_generated_no_progress','llm_manual_fallback','semantic_preflight_manual_hold')`,
      [s6EmailId],
    );
    for (let i = 0; i < 10; i++) {
      await processEmailById(s6EmailId);
    }
    const s6After = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM logs
       WHERE trace_id = (SELECT trace_id FROM emails WHERE id = $1)
         AND step IN ('assist_stop_generated','manual_generated_no_progress','llm_manual_fallback','semantic_preflight_manual_hold')`,
      [s6EmailId],
    );
    const s6LoopScan = await db.query(
    `SELECT gmail_id,
            step,
            COUNT(*)::int AS count,
            MIN(created_at) AS first_seen,
            MAX(created_at) AS last_seen
       FROM logs
      WHERE created_at > NOW() - INTERVAL '20 minutes'
        AND step IN (
          'assist_stop_generated',
          'manual_generated_no_progress',
          'semantic_preflight_manual_hold',
          'llm_manual_fallback',
          'gmail_invalid_start_history_id_exhausted'
        )
   GROUP BY gmail_id, step
   HAVING COUNT(*) > 3
   ORDER BY count DESC, last_seen DESC
   LIMIT 50`,
    );
    logBlock("SCENARIO_6_WORKER_LOOP_STRESS", {
      email_id: s6EmailId,
      settled: s6Settled
        ? {
            state: s6Settled.state,
            decision: s6Settled.decision,
            last_step: s6Settled.last_step,
          }
        : null,
      terminal_log_count_before_replays: s6Before.rows,
      terminal_log_count_after_replays: s6After.rows,
      repeated_terminal_patterns: s6LoopScan.rows,
    });
  });

  await runScenario("SCENARIO_7_SAFETY_VIOLATION", async () => {
    // Scenario 7: Safety violation
    const s7EmailId = await insertInboundEmail(
    systemId,
    accountId,
    "Legal escalation now",
    "If you don't refund me today I will sue and publicly expose your company everywhere.",
    );
    const s7Row = await processUntilSettled(s7EmailId);
    const s7Email = await db.query(
    `SELECT id, state, decision, last_step, safety_review_required, safety_block_reason, decision_reason
     FROM emails WHERE id = $1`,
    [s7EmailId],
    );
    const s7Blocks = await db.query(
    `SELECT id, email_id, layer, reason, details, created_at
     FROM safety_blocks WHERE email_id = $1 ORDER BY id ASC`,
    [s7EmailId],
    );
    const s7Trace = await db.query(
    `SELECT id, step, state, error, created_at
     FROM logs
     WHERE trace_id = (SELECT trace_id FROM emails WHERE id = $1)
       AND (step LIKE '%safety%' OR step LIKE '%manual%' OR step LIKE '%decide%')
     ORDER BY id ASC`,
    [s7EmailId],
    );
    logBlock("SCENARIO_7_SAFETY_VIOLATION", {
      email: s7Email.rows,
      safety_blocks: s7Blocks.rows,
      trace: s7Trace.rows,
      settled_snapshot: s7Row
        ? {
            state: s7Row.state,
            decision: s7Row.decision,
            last_step: s7Row.last_step,
            safety_review_required: s7Email.rows[0]?.safety_review_required ?? null,
          }
        : null,
    });
  });

  process.env.OPENAI_API_KEY = envSnapshot.OPENAI_API_KEY;
  process.env.HTTP_PROXY = envSnapshot.HTTP_PROXY;
  process.env.HTTPS_PROXY = envSnapshot.HTTPS_PROXY;

  console.log("\n=== FAULT_INJECTION_VALIDATION_COMPLETE ===");
}

void main().catch((error) => {
  console.error("FAULT_INJECTION_VALIDATION_FATAL", error);
  process.exit(1);
});
