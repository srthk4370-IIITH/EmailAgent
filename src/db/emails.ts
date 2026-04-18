import { db } from "./client";
import { canTransition } from "../core/state";
import { logger } from "../utils/logger";
import { sanitizeStoredEmailText } from "../utils/sanitizeEmail";

export type EmailState =
  | "INGESTED"
  | "PROCESSING"
  | "CLASSIFIED"
  | "READY_TO_GENERATE"
  | "GENERATED"
  | "AWAITING_REVIEW"
  | "READY_TO_SEND"
  | "SENT"
  | "REPLIED"
  | "ERROR_TEMP"
  | "ERROR_FATAL"
  | "DEAD";

export interface EmailRecord {
  id: number;
  system_id?: number | null;
  account_id?: number | null;
  gmail_id: string;
  source: string;
  trace_id: string | null;
  thread_id: string;
  from_email: string;
  subject: string;
  body: string;
  snippet: string;
  internal_date: number | null;
  state: EmailState;
  category: string | null;
  confidence: number | null;
  decision: string | null;
  reply: string | null;
  parsed_content: unknown | null;
  classification_output: unknown | null;
  rag_context: unknown | null;
  prompt_version: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  llm_latency_ms: number | null;
  retry_count: number;
  attempt_count: number;
  next_attempt_at?: string | null;
  last_error: string | null;
  last_step: string | null;
  processing_version: number;
  review_outcome: string | null;
  embedding_status: string;
  is_seen: boolean;
  ready_to_send_at?: string | null;
  manual_generate_requested?: boolean;
  embedding_error?: string | null;
  risk_score?: number | null;
  risk_reasons?: unknown | null;
  cost_estimate_tokens?: number | null;
  cost_score?: number | null;
  priority_score?: number | null;
  rag_confidence?: number | null;
  rag_conflict_detected?: boolean;
  decision_reason?: string | null;
  selected_model?: string | null;
  style_confidence?: number | null;
  clarification_mode?: boolean;
  edited_count?: number;
  rejected_count?: number;
  regenerated_count?: number;
  accepted_count?: number;
  created_at: string;
  updated_at: string;
}

interface InsertEmailInput {
  systemId?: number | null;
  accountId?: number | null;
  gmailId: string;
  traceId: string;
  threadId: string;
  fromEmail: string;
  subject: string;
  body: string;
  snippet: string;
  internalDate: number | null;
  source: "inbox" | "sent" | "compose";
  state: EmailState;
}

function normalizeEmailTimestamp(input: number | null | undefined): number | null {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return Math.floor(Date.now());
  }
  return Math.floor(input);
}

export async function insertEmailIfNotExists(input: InsertEmailInput): Promise<EmailRecord | null> {
  const internalDate = normalizeEmailTimestamp(input.internalDate);
  const isSeen = input.source !== "inbox";
  const result = await db.query<EmailRecord>(
    `
      WITH existing AS (
        SELECT id
        FROM emails
        WHERE gmail_id = $3
          AND (
            ($2::integer IS NULL AND account_id IS NULL)
            OR account_id = $2::integer
          )
        LIMIT 1
      )
      INSERT INTO emails (system_id, account_id, gmail_id, source, trace_id, thread_id, from_email, subject, body, snippet, internal_date, state, is_seen)
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING *
    `,
    [
      input.systemId ?? null,
      input.accountId ?? null,
      input.gmailId,
      input.source,
      input.traceId,
      input.threadId,
      input.fromEmail,
      input.subject,
      input.body,
      input.snippet,
      internalDate,
      input.state,
      isSeen,
    ],
  );

  return result.rows[0] ?? null;
}

export async function insertComposeEmail(input: {
  systemId?: number | null;
  accountId?: number | null;
  gmailId: string;
  traceId: string;
  category: string;
  context: string;
}): Promise<EmailRecord> {
  const category = sanitizeStoredEmailText(input.category);
  const context = sanitizeStoredEmailText(input.context);
  const internalDate = normalizeEmailTimestamp(Date.now()) ?? Date.now();
  const result = await db.query<EmailRecord>(
    `
      INSERT INTO emails (system_id, account_id, gmail_id, source, trace_id, thread_id, from_email, subject, body, snippet, internal_date, state, category, confidence, decision)
      VALUES ($1, $2, $3, 'compose', $4, '', '', $5, $6, $7, $8, 'READY_TO_GENERATE', $9, 1.0, 'assist')
      RETURNING *
    `,
    [
      input.systemId ?? null,
      input.accountId ?? null,
      input.gmailId,
      input.traceId,
      `Compose: ${category}`,
      context,
      context.slice(0, 120),
      internalDate,
      category,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to insert compose email");
  return row;
}

export async function getEmailByGmailId(gmailId: string, accountId?: number | null): Promise<EmailRecord | null> {
  const result = accountId
    ? await db.query<EmailRecord>(
        "SELECT * FROM emails WHERE gmail_id = $1 AND account_id = $2 LIMIT 1",
        [gmailId, accountId],
      )
    : await db.query<EmailRecord>("SELECT * FROM emails WHERE gmail_id = $1 ORDER BY id DESC LIMIT 1", [gmailId]);
  return result.rows[0] ?? null;
}

export async function getEmailById(id: number): Promise<EmailRecord | null> {
  const result = await db.query<EmailRecord>("SELECT * FROM emails WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] ?? null;
}

export async function listProcessableEmails(limit = 50, accountId?: number | null): Promise<EmailRecord[]> {
  const result = await db.query<EmailRecord>(
    `
      SELECT * FROM emails
      WHERE state IN ('INGESTED', 'PROCESSING', 'CLASSIFIED', 'READY_TO_GENERATE', 'GENERATED', 'AWAITING_REVIEW', 'READY_TO_SEND', 'ERROR_TEMP')
        AND ($2::int IS NULL OR account_id = $2)
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        AND review_outcome IS DISTINCT FROM 'rejected'
        AND (state = 'READY_TO_SEND' OR decision IS DISTINCT FROM 'manual')
        AND NOT (
          state = 'READY_TO_GENERATE'
          AND COALESCE(last_step, '') = 'semantic_preflight_manual_hold'
          AND COALESCE(manual_generate_requested, false) = false
        )
        AND NOT (
          state = 'GENERATED'
          AND (
            COALESCE(last_step, '') IN ('assist_stop_generated', 'assist_generated_stop', 'manual_generated_no_progress')
            OR (
              decision = 'manual'
              AND COALESCE(manual_generate_requested, false) = false
            )
          )
        )
      ORDER BY
        CASE state
          -- Always prioritize READY_TO_SEND so queued approvals get flushed quickly.
          WHEN 'READY_TO_SEND' THEN 0
          WHEN 'INGESTED' THEN 1
          WHEN 'PROCESSING' THEN 2
          WHEN 'ERROR_TEMP' THEN 3
          WHEN 'CLASSIFIED' THEN 4
          WHEN 'READY_TO_GENERATE' THEN 5
          WHEN 'GENERATED' THEN 6
          WHEN 'AWAITING_REVIEW' THEN 7
          ELSE 99
        END,
        id ASC
      LIMIT $1
    `,
    [limit, accountId ?? null],
  );

  return result.rows;
}

export async function countProcessableEmails(accountId?: number | null): Promise<number> {
  const result = await db.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count FROM emails
      WHERE state IN (
        'INGESTED', 'PROCESSING', 'CLASSIFIED', 'READY_TO_GENERATE', 'GENERATED',
        'AWAITING_REVIEW', 'READY_TO_SEND', 'ERROR_TEMP'
      )
      AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      AND review_outcome IS DISTINCT FROM 'rejected'
      AND (state = 'READY_TO_SEND' OR decision IS DISTINCT FROM 'manual')
      AND NOT (
        state = 'READY_TO_GENERATE'
        AND COALESCE(last_step, '') = 'semantic_preflight_manual_hold'
        AND COALESCE(manual_generate_requested, false) = false
      )
      AND NOT (
        state = 'GENERATED'
        AND (
          COALESCE(last_step, '') IN ('assist_stop_generated', 'assist_generated_stop', 'manual_generated_no_progress')
          OR (
            decision = 'manual'
            AND COALESCE(manual_generate_requested, false) = false
          )
        )
      )
      AND ($1::int IS NULL OR account_id = $1)
    `,
    [accountId ?? null],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function updateEmailState(id: number, state: EmailState): Promise<void> {
  const result = await db.query<{ prev_state: EmailState }>(
    `
      WITH current AS (
        SELECT state AS prev_state
        FROM emails
        WHERE id = $2
        FOR UPDATE
      ), updated AS (
        UPDATE emails
        SET state = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id
      )
      SELECT prev_state FROM current
    `,
    [state, id],
  );

  const previous = result.rows[0]?.prev_state;
  if (!previous) {
    logger.warn("updateEmailState: email not found", { id, state });
    return;
  }
  if (previous !== state && !canTransition(previous, state)) {
    logger.warn("updateEmailState: non-canonical transition (applying anyway)", {
      id,
      from: previous,
      to: state,
    });
  }
}

async function transitionEmailStateCas(
  id: number,
  fromState: EmailState,
  toState: EmailState,
  updateSql = "",
  updateParams: unknown[] = [],
): Promise<EmailRecord | null> {
  const result = await db.query<EmailRecord>(
    `UPDATE emails
     SET state = $3,
         updated_at = NOW()
         ${updateSql}
     WHERE id = $1
       AND state = $2
     RETURNING *`,
    [id, fromState, toState, ...updateParams],
  );

  return result.rows[0] ?? null;
}

export async function transitionReadyToGenerateToGenerated(id: number, reply: string): Promise<EmailRecord | null> {
  return transitionEmailStateCas(
    id,
    "READY_TO_GENERATE",
    "GENERATED",
    ", reply = $4, last_step = 'generate'",
    [reply],
  );
}

export async function transitionGeneratedToAwaitingReview(id: number): Promise<EmailRecord | null> {
  return transitionEmailStateCas(id, "GENERATED", "AWAITING_REVIEW", ", last_step = 'awaiting_review'");
}

export async function transitionAwaitingReviewToReadyToSend(id: number): Promise<EmailRecord | null> {
  return transitionEmailStateCas(
    id,
    "AWAITING_REVIEW",
    "READY_TO_SEND",
    ", ready_to_send_at = NOW(), review_outcome = NULL, last_step = 'approve_draft'",
  );
}

export async function transitionReadyToSendToSent(id: number): Promise<EmailRecord | null> {
  return transitionEmailStateCas(id, "READY_TO_SEND", "SENT", ", last_step = 'send'");
}

/** 
 * TIER 3 HARDENING: Mark inbound emails as 'REPLIED' if a subsequent outbound message exists in the thread. 
 * This ensures the UI stays in sync with manual Gmail actions.
 */
export async function reconcileThreadStates(accountId?: number | null): Promise<number> {
  const result = await db.query(`
    UPDATE emails i
    SET state = 'REPLIED', updated_at = NOW()
    WHERE i.source = 'inbox'
      AND i.state NOT IN ('SENT', 'REPLIED', 'ERROR_FATAL', 'DEAD')
      AND ($1::int IS NULL OR i.account_id = $1)
      AND EXISTS (
        SELECT 1
        FROM emails o
        WHERE o.account_id = i.account_id
          AND o.thread_id = i.thread_id
          AND (o.source = 'sent' OR o.source = 'compose' OR o.state = 'SENT')
          AND COALESCE(o.internal_date, (EXTRACT(EPOCH FROM o.created_at) * 1000)::bigint) > COALESCE(i.internal_date, (EXTRACT(EPOCH FROM i.created_at) * 1000)::bigint)
      )
    RETURNING i.id
  `, [accountId ?? null]);
  return result.rowCount ?? 0;
}

/** Recover worker crashes: stuck PROCESSING → INGESTED for re-claim. */
export async function resetStuckProcessingEmails(): Promise<number> {
  const result = await db.query(
    `
      UPDATE emails
      SET state = 'INGESTED', last_step = 'stuck_recovery', updated_at = NOW()
      WHERE state = 'PROCESSING'
        AND updated_at < NOW() - INTERVAL '2 minutes'
      RETURNING id
    `,
  );
  return result.rowCount ?? 0;
}

export async function claimEmailForProcessing(id: number): Promise<EmailRecord | null> {
  const result = await db.query<EmailRecord>(
    `
      UPDATE emails
      SET state = 'PROCESSING',
          last_step = 'processing_lock',
          processing_version = processing_version + 1,
          updated_at = NOW()
      WHERE id = $1 AND state = 'INGESTED'
      RETURNING *
    `,
    [id],
  );
  return result.rows[0] ?? null;
}

/** True if this processing lease is still current (no newer claim / reset). */
export async function isProcessingLeaseCurrent(
  id: number,
  expectedVersion: number,
): Promise<boolean> {
  const row = await getEmailById(id);
  return row !== null && row.processing_version === expectedVersion;
}

export async function updateEmailClassification(
  id: number,
  category: string,
  confidence: number,
): Promise<void> {
  await updateEmailState(id, "CLASSIFIED");
  await db.query(
    "UPDATE emails SET category = $1, confidence = $2, classification_output = $3::jsonb, last_step = 'classify', updated_at = NOW() WHERE id = $4",
    [category, confidence, JSON.stringify({ category, confidence }), id],
  );
}

export async function markReadyToGenerate(id: number, decision: string): Promise<void> {
  await updateEmailState(id, "READY_TO_GENERATE");
  await db.query(
    "UPDATE emails SET decision = $1, last_step = 'decide', updated_at = NOW() WHERE id = $2",
    [decision, id],
  );
}

export async function updateEmailDecision(id: number, decision: string): Promise<void> {
  await db.query(
    "UPDATE emails SET decision = $1, last_step = 'decide', updated_at = NOW() WHERE id = $2",
    [decision, id],
  );
}

export async function updateEmailIntelligence(
  id: number,
  input: {
    riskScore?: number;
    riskReasons?: string[];
    costEstimateTokens?: number;
    costScore?: number;
    priorityScore?: number;
    ragConfidence?: number;
    ragConflictDetected?: boolean;
    decisionReason?: string;
    selectedModel?: string;
    styleConfidence?: number;
    clarificationMode?: boolean;
  },
): Promise<void> {
  await db.query(
    `UPDATE emails
     SET risk_score = COALESCE($1, risk_score),
         risk_reasons = COALESCE($2::jsonb, risk_reasons),
         cost_estimate_tokens = COALESCE($3, cost_estimate_tokens),
         cost_score = COALESCE($4, cost_score),
         priority_score = COALESCE($5, priority_score),
         rag_confidence = COALESCE($6, rag_confidence),
         rag_conflict_detected = COALESCE($7, rag_conflict_detected),
         decision_reason = COALESCE($8, decision_reason),
         selected_model = COALESCE($9, selected_model),
         style_confidence = COALESCE($10, style_confidence),
         clarification_mode = COALESCE($11, clarification_mode),
         updated_at = NOW()
       WHERE id = $12`,
    [
      input.riskScore ?? null,
      input.riskReasons ? JSON.stringify(input.riskReasons) : null,
      input.costEstimateTokens ?? null,
      input.costScore ?? null,
      input.priorityScore ?? null,
      input.ragConfidence ?? null,
      input.ragConflictDetected ?? null,
      input.decisionReason ?? null,
      input.selectedModel ?? null,
      input.styleConfidence ?? null,
      input.clarificationMode ?? null,
      id,
    ],
  );
}

export async function incrementEmailFeedbackCounter(
  id: number,
  counter: "edited_count" | "rejected_count" | "regenerated_count" | "accepted_count",
): Promise<void> {
  await db.query(
    `UPDATE emails
     SET ${counter} = ${counter} + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

export async function updateEmailReply(id: number, reply: string): Promise<void> {
  const transitioned = await transitionReadyToGenerateToGenerated(id, reply);
  if (!transitioned) {
    throw new Error(`CAS_ABORT_READY_TO_GENERATE_TO_GENERATED:${id}`);
  }
}

export async function updateEmailRagContext(id: number, ragContext: unknown): Promise<void> {
  await db.query("UPDATE emails SET rag_context = $1::jsonb, updated_at = NOW() WHERE id = $2", [
    JSON.stringify(ragContext),
    id,
  ]);
}

export async function updateEmailLlmMetrics(
  id: number,
  metrics: { tokensIn: number; tokensOut: number; latencyMs: number; promptVersion: string },
): Promise<void> {
  await db.query(
    `
      UPDATE emails
      SET tokens_in = $1, tokens_out = $2, llm_latency_ms = $3, prompt_version = $4, updated_at = NOW()
      WHERE id = $5
    `,
    [metrics.tokensIn, metrics.tokensOut, metrics.latencyMs, metrics.promptVersion, id],
  );
}

export async function updateParsedContent(
  id: number,
  parsedContent: {
    subject: string;
    from: string;
    body: string;
    snippet: string;
    thread_id: string;
    app_generated?: boolean;
    sent_by_user?: boolean;
    user_edited?: boolean;
  },
): Promise<void> {
  await db.query("UPDATE emails SET parsed_content = $1::jsonb, updated_at = NOW() WHERE id = $2", [
    JSON.stringify(parsedContent),
    id,
  ]);
}

export type EmbeddingStatus = 'pending' | 'embedded' | 'skipped_duplicate' | 'skipped_filter' | 'skipped_short' | 'failed';

export async function updateEmbeddingStatus(id: number, status: EmbeddingStatus, error?: string): Promise<void> {
  await db.query(
    `UPDATE emails
     SET embedding_status = $1,
         embedding_error = $3,
         updated_at = NOW()
     WHERE id = $2`,
    [status, id, error ?? null],
  );
}

export async function markEmailSeen(id: number): Promise<void> {
  await setEmailSeenState(id, true);
}

export async function setEmailSeenState(id: number, isSeen: boolean): Promise<void> {
  await db.query(
    `UPDATE emails SET is_seen = $2, updated_at = NOW() WHERE id = $1`,
    [id, isSeen],
  );
}

export async function getEmbeddingCountForEmail(emailId: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM email_embeddings WHERE email_id = $1",
    [emailId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function incrementEmailRetry(id: number, errorMessage: string): Promise<void> {
  await db.query(
    `
      UPDATE emails
      SET retry_count = retry_count + 1, state = 'ERROR_TEMP', last_error = $1, last_step = 'retry', updated_at = NOW()
      WHERE id = $2
    `,
    [errorMessage, id],
  );
}

const DEFAULT_MAX_ATTEMPTS = 6;

function computeRetryDelaySeconds(attempt: number): number {
  const boundedAttempt = Math.max(1, Math.min(attempt, 8));
  return Math.min(30 * 60, 30 * 2 ** (boundedAttempt - 1));
}

export async function scheduleEmailRetry(
  id: number,
  errorMessage: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<{ state: "ERROR_TEMP" | "READY_TO_SEND" | "DEAD"; attemptCount: number; nextAttemptAt: string | null }> {
  const current = await db.query<{ attempt_count: number; state: EmailState }>(
    `SELECT COALESCE(attempt_count, 0) AS attempt_count, state FROM emails WHERE id = $1 LIMIT 1`,
    [id],
  );
  const previousAttemptCount = Number(current.rows[0]?.attempt_count ?? 0);
  const previousState = current.rows[0]?.state;
  const attemptCount = previousAttemptCount + 1;

  if (attemptCount >= maxAttempts) {
    await db.query(
      `UPDATE emails
       SET state = 'DEAD',
           attempt_count = $1,
           retry_count = retry_count + 1,
           next_attempt_at = NULL,
           last_error = $2,
           last_step = 'dead_letter',
           updated_at = NOW()
       WHERE id = $3`,
      [attemptCount, errorMessage, id],
    );
    return { state: "DEAD", attemptCount, nextAttemptAt: null };
  }

  const delaySeconds = computeRetryDelaySeconds(attemptCount);
  const retryState: EmailState = previousState === "READY_TO_SEND" ? "READY_TO_SEND" : "ERROR_TEMP";
  const delayed = await db.query<{ next_attempt_at: string }>(
    `UPDATE emails
     SET state = $5,
         attempt_count = $1,
         retry_count = retry_count + 1,
         next_attempt_at = NOW() + ($2 * INTERVAL '1 second'),
         last_error = $3,
         last_step = 'retry_scheduled',
         updated_at = NOW()
     WHERE id = $4
     RETURNING to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at`,
    [attemptCount, delaySeconds, errorMessage, id, retryState],
  );

  return {
    state: retryState,
    attemptCount,
    nextAttemptAt: delayed.rows[0]?.next_attempt_at ?? null,
  };
}

export async function markEmailFailed(id: number, errorMessage: string): Promise<void> {
  await db.query(
    "UPDATE emails SET state = 'DEAD', next_attempt_at = NULL, last_error = $1, last_step = 'dead_letter', updated_at = NOW() WHERE id = $2",
    [errorMessage, id],
  );
}

export async function markAwaitingReview(id: number): Promise<void> {
  const fromGenerated = await transitionGeneratedToAwaitingReview(id);
  if (fromGenerated) return;

  const fromReadyToSend = await transitionEmailStateCas(
    id,
    "READY_TO_SEND",
    "AWAITING_REVIEW",
    ", review_outcome = NULL, last_step = 'awaiting_review'",
  );
  if (fromReadyToSend) return;

  const current = await getEmailById(id);
  if (current?.state === "AWAITING_REVIEW") return;

  throw new Error(`CAS_ABORT_TO_AWAITING_REVIEW:${id}`);
}

export async function markReadyToSend(id: number): Promise<void> {
  const transitioned = await transitionAwaitingReviewToReadyToSend(id);
  if (!transitioned) {
    throw new Error(`CAS_ABORT_AWAITING_REVIEW_TO_READY_TO_SEND:${id}`);
  }
}

export type EmailListFilter = "all" | "inbox" | "sent" | "rejected";

export async function listEmails(limit = 100): Promise<EmailRecord[]> {
  const result = await db.query<EmailRecord>("SELECT * FROM emails ORDER BY id DESC LIMIT $1", [limit]);
  return result.rows;
}

export async function listEmailsFiltered(
  filter: EmailListFilter = "all",
  limit = 20,
  cursorDate?: number,
  cursorId?: number,
  accountId?: number | null,
): Promise<EmailRecord[]> {
  if (filter === "all") {
    const result = await db.query<EmailRecord>(
      `SELECT * FROM emails
       WHERE ($2::int IS NULL OR account_id = $2)
       ORDER BY id DESC LIMIT $1`,
      [limit, accountId ?? null],
    );
    return result.rows;
  }
  if (filter === "sent") {
    let query = "SELECT * FROM emails WHERE ($2::int IS NULL OR account_id = $2) AND (source = 'sent' OR state = 'SENT' OR source = 'compose')";
    const params: (string | number | null)[] = [limit];
    params.push(accountId ?? null);
    
    if (cursorDate && cursorId) {
      query += " AND (COALESCE(internal_date, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint) < $3 OR (COALESCE(internal_date, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint) = $3 AND id < $4))";
      params.push(cursorDate, cursorId);
    }
    
    query += " ORDER BY COALESCE(internal_date, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint) DESC, id DESC LIMIT $1";
    const result = await db.query<EmailRecord>(query, params);
    return result.rows;
  }
  if (filter === "rejected") {
    let query = "SELECT * FROM emails WHERE ($2::int IS NULL OR account_id = $2) AND review_outcome = 'rejected'";
    const params: (string | number | null)[] = [limit];
    params.push(accountId ?? null);
    
    if (cursorDate && cursorId) {
      query += " AND (COALESCE(internal_date, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint) < $3 OR (COALESCE(internal_date, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint) = $3 AND id < $4))";
      params.push(cursorDate, cursorId);
    }
    
    query += " ORDER BY COALESCE(internal_date, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint) DESC, id DESC LIMIT $1";
    const result = await db.query<EmailRecord>(query, params);
    return result.rows;
  }
  
  // TRUTH-BASED INBOX: Shown if source is inbox AND no newer outbound exists in thread.
  let query = `
    SELECT * FROM emails e
    WHERE e.source = 'inbox'
      AND ($2::int IS NULL OR e.account_id = $2)
      AND e.state NOT IN ('SENT', 'REPLIED', 'ERROR_FATAL', 'DEAD')
      AND (
        review_outcome IS DISTINCT FROM 'rejected'
        OR state = 'READY_TO_GENERATE'
      )
      AND NOT EXISTS (
        SELECT 1 FROM emails o
        WHERE o.thread_id = e.thread_id
          AND o.account_id = e.account_id
          AND (o.source = 'sent' OR o.source = 'compose' OR o.state = 'SENT')
            AND COALESCE(o.internal_date, (EXTRACT(EPOCH FROM o.created_at) * 1000)::bigint) > COALESCE(e.internal_date, (EXTRACT(EPOCH FROM e.created_at) * 1000)::bigint)
      )
  `;
  const params: (string | number | null)[] = [limit, accountId ?? null];
  
  if (cursorDate && cursorId) {
    query += " AND (COALESCE(e.internal_date, (EXTRACT(EPOCH FROM e.created_at) * 1000)::bigint) < $3 OR (COALESCE(e.internal_date, (EXTRACT(EPOCH FROM e.created_at) * 1000)::bigint) = $3 AND e.id < $4))";
    params.push(cursorDate, cursorId);
  }
  
  query += " ORDER BY COALESCE(e.internal_date, (EXTRACT(EPOCH FROM e.created_at) * 1000)::bigint) DESC, e.id DESC LIMIT $1";
  const result = await db.query<EmailRecord>(query, params);
  return result.rows;
}

export interface CleanupInjectedTestEmailsResult {
  deletedEmails: number;
  deletedLogs: number;
  deletedErrorLogs: number;
  deletedThreads: number;
  affectedTraceIds: number;
}

export async function cleanupInjectedTestEmails(): Promise<CleanupInjectedTestEmailsResult> {
  const targets = await db.query<{ id: number; gmail_id: string | null; trace_id: string | null; thread_id: string }>(
    `SELECT id, gmail_id, trace_id, thread_id
     FROM emails
     WHERE source = 'inbox'
       AND (
         from_email = $1
         OR gmail_id LIKE $2
       )`,
    ["fault.inject@example.com", "fi-inbox-%"],
  );

  if (targets.rows.length === 0) {
    return {
      deletedEmails: 0,
      deletedLogs: 0,
      deletedErrorLogs: 0,
      deletedThreads: 0,
      affectedTraceIds: 0,
    };
  }

  const emailIds = Array.from(new Set(targets.rows.map((row) => row.id)));
  const gmailIds = Array.from(
    new Set(
      targets.rows
        .map((row) => row.gmail_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );
  const traceIds = Array.from(
    new Set(
      targets.rows
        .map((row) => row.trace_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );
  const threadIds = Array.from(
    new Set(
      targets.rows
        .map((row) => row.thread_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );

  await db.query("BEGIN");
  try {
    const deletedLogs = await db.query(
      `DELETE FROM logs
       WHERE (cardinality($1::text[]) > 0 AND gmail_id = ANY($1::text[]))
          OR (cardinality($2::text[]) > 0 AND trace_id = ANY($2::text[]))`,
      [gmailIds, traceIds],
    );

    const deletedErrorLogs = await db.query(
      `DELETE FROM error_logs
       WHERE (cardinality($1::int[]) > 0 AND email_id = ANY($1::int[]))
          OR (cardinality($2::text[]) > 0 AND trace_id = ANY($2::text[]))`,
      [emailIds, traceIds],
    );

    const deletedEmails = await db.query("DELETE FROM emails WHERE id = ANY($1::int[])", [emailIds]);

    const deletedThreads = await db.query(
      `DELETE FROM email_threads t
       WHERE cardinality($1::text[]) > 0
         AND t.thread_id = ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1
           FROM emails e
           WHERE e.thread_id = t.thread_id
             AND (
               (e.account_id IS NULL AND t.account_id IS NULL)
               OR e.account_id = t.account_id
             )
         )`,
      [threadIds],
    );

    await db.query("COMMIT");

    return {
      deletedEmails: deletedEmails.rowCount ?? 0,
      deletedLogs: deletedLogs.rowCount ?? 0,
      deletedErrorLogs: deletedErrorLogs.rowCount ?? 0,
      deletedThreads: deletedThreads.rowCount ?? 0,
      affectedTraceIds: traceIds.length,
    };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function setManualGenerateRequested(id: number, requested: boolean): Promise<void> {
  await db.query(`UPDATE emails SET manual_generate_requested = $1, updated_at = NOW() WHERE id = $2`, [
    requested,
    id,
  ]);
}

export function isManualGenerateRequested(parsed: unknown, explicitFlag?: boolean | null): boolean {
  if (typeof explicitFlag === "boolean") return explicitFlag;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return Boolean((parsed as Record<string, unknown>).manual_generate_requested);
}

export async function setReviewOutcome(id: number, outcome: string | null): Promise<void> {
  await db.query(`UPDATE emails SET review_outcome = $1, updated_at = NOW() WHERE id = $2`, [
    outcome,
    id,
  ]);
}

export async function revertEmailAfterDraftReject(emailId: number): Promise<void> {
  await updateEmailState(emailId, "READY_TO_GENERATE");
  await db.query(
    `UPDATE emails SET reply = NULL, last_step = 'draft_rejected', updated_at = NOW() WHERE id = $1`,
    [emailId],
  );
}
