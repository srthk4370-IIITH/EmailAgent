import crypto from "crypto";
import type { AppConfig } from "../db/config";
import { getConfig, updateConfig } from "../db/config";
import {
  createSession,
  getPrimaryUser,
  upsertUserByGoogle,
} from "../db/auth";
import {
  approveDraft,
  createDraft,
  createDraftFallback,
  deleteDraftsByEmailId,
  getDraftByEmailId,
} from "../db/drafts";
import {
  claimEmailForProcessing,
  getEmailById,
  getEmailByGmailId,
  incrementEmailFeedbackCounter,
  insertComposeEmail,
  insertEmailIfNotExists,
  isManualGenerateRequested,
  isProcessingLeaseCurrent,
  markAwaitingReview,
  listProcessableEmails,
  markReadyToGenerate,
  markReadyToSend,
  scheduleEmailRetry,
  transitionGeneratedToAwaitingReview,
  transitionReadyToSendToSent,
  reconcileThreadStates,
  setManualGenerateRequested,
  setReviewOutcome,
  updateEmailDecision,
  updateEmailIntelligence,
  updateEmailClassification,
  updateEmailLlmMetrics,
  updateParsedContent,
  updateEmailRagContext,
  updateEmailReply,
  updateEmailState,
} from "../db/emails";
import type { EmailRecord } from "../db/emails";
import { upsertThread } from "../db/threads";
import { getThreadMessages } from "../db/threads";
import { queueEmbeddingJob } from "./jobQueue";
import { classifyEmailWithThread, type ClassificationResult } from "./classifier";
import { decideAction } from "./decision";
import { generateReply } from "./generator";
import { getRelevantContext } from "./rag";
import { getDynamicWorkerBatchSize } from "../services/llm";
import { runSafetyChecks, runFullSafetyCheck } from "./safety";
import { extractVoiceStyleFeatures } from "./voiceCloner";
import { type GmailEmail, performFullResync, syncGmailMailbox } from "../services/gmail";
import { sendGmailEmail } from "../services/gmail";
import { logger, logStep } from "../utils/logger";
import { createTraceId, withTrace } from "../utils/trace";
import { evaluateErrorRecovery, toRecoveryMeta } from "../lib/errorIntelligence";
import { claimComposeRequest, markComposeRequestDone } from "../db/composeRequests";
import { sanitizeStoredEmailText } from "../utils/sanitizeEmail";
import { createEmbedding } from "../services/embeddings";
import { cosineSimilarity } from "../utils/math";
import { evaluateCase } from "./ragEvaluator";
import { saveRagTrace, calculateAndSaveTrace } from "./ragObserver";
import { type StructuredContextItem } from "./ragRanker";
import {
  clearAccountHistoryCursor,
  resolveDefaultAccountId,
  getEmailAccountById,
  updateAccountHistoryCursor,
} from "../db/emailAccounts";
import { getDefaultSystemId } from "../db/systems";
import { claimSendAttempt, completeSendAttempt, failSendAttempt } from "../db/sendAttempts";
import { isBudgetAvailable, resetDailyTokensIfNeeded } from "./costControl";
import { updateServiceHealth, recordWorkerHeartbeat } from "../db/systemHealth";
import { computePriorityScore } from "./priorityScore";
import { estimateGenerationCost } from "./costEstimate";
import { computeRiskScore } from "./riskScore";
import { checkBudget } from "./costControl";
import { countJobsByStatus } from "../db/jobs";
import { modelForTask, selectModelTier } from "./modelRouter";
import { classifyIntentRisks } from "./intentClassifier";
import { chooseAdaptiveModel } from "./modelLearning";
import { mergeStyleSignature, type StyleSignature } from "./styleSignature";
import { getUserStyleSignature, saveUserStyleSignature } from "../db/auth";
import { applyRagFeedbackForEmail, recordRagRetrievalForEmail } from "../db/embeddings";

const MAX_PROCESS_ATTEMPTS = 6;

function readParsedBoolean(parsedContent: unknown, key: "app_generated" | "sent_by_user" | "user_edited"): boolean {
  if (!parsedContent || typeof parsedContent !== "object" || Array.isArray(parsedContent)) {
    return false;
  }
  const value = (parsedContent as Record<string, unknown>)[key];
  return value === true || value === "true";
}

function isEligibleSentMemoryEmail(email: EmailRecord): boolean {
  if (email.source !== "sent" && email.state !== "SENT") {
    return false;
  }

  const appGenerated = readParsedBoolean(email.parsed_content, "app_generated");
  const sentByUser = readParsedBoolean(email.parsed_content, "sent_by_user");
  const userEdited = readParsedBoolean(email.parsed_content, "user_edited");

  if (appGenerated && !userEdited) {
    return false;
  }

  if (!appGenerated && !sentByUser && !userEdited) {
    return false;
  }

  return true;
}


async function maybeAutoApproveDraft(emailId: number, traceId: string, config: AppConfig): Promise<void> {
  const row = await getEmailById(emailId);
  if (!row || row.decision !== "auto" || config.global_mode !== "auto") return;
  const d = await getDraftByEmailId(emailId);
  if (!d) return;
  await approveDraft(d.id);
  const movedToReview = await transitionGeneratedToAwaitingReview(emailId);
  if (!movedToReview && row.state !== "AWAITING_REVIEW" && row.state !== "READY_TO_SEND") {
    await logStep({
      trace_id: traceId,
      gmail_id: row.gmail_id,
      step: "cas_abort_generated_to_awaiting_review",
      state: row.state,
      latency_ms: 0,
    });
    return;
  }
  if (row.state !== "READY_TO_SEND") {
    await markReadyToSend(emailId);
  }
  await logStep({
    trace_id: traceId,
    gmail_id: row.gmail_id,
    step: "auto_mode_approve",
    state: "READY_TO_SEND",
    latency_ms: 0,
  });
}

async function onDraftCreatedSuccess(
  email: EmailRecord,
  traceId: string,
  config: AppConfig,
  safety: { ok: boolean; reasons: string[] },
  decision: "manual" | "assist" | "auto",
): Promise<void> {

  // MANUAL → should not even reach here, but keep safe
  if (decision === "manual") {
    await markReadyToGenerate(email.id, email.decision ?? "manual");

    await logStep({
      trace_id: traceId,
      gmail_id: email.gmail_id,
      step: "manual_mode_skip_draft",
      state: "READY_TO_GENERATE",
      latency_ms: 0,
    });

    return;
  }

  // ASSIST → generate + wait for approval
  if (decision === "assist") {
    const movedToReview = await transitionGeneratedToAwaitingReview(email.id);
    if (!movedToReview && email.state !== "AWAITING_REVIEW") {
      await logStep({
        trace_id: traceId,
        gmail_id: email.gmail_id,
        step: "cas_abort_generated_to_awaiting_review",
        state: email.state,
        latency_ms: 0,
      });
      return;
    }

    await setReviewOutcome(email.id, null);

    await logStep({
      trace_id: traceId,
      gmail_id: email.gmail_id,
      step: safety.ok ? "assist_ready_for_review" : "assist_ready_for_review_safety_note",
      state: "AWAITING_REVIEW",
      latency_ms: 0,
      ...(safety.ok ? {} : { error: safety.reasons.join(",") }),
    });

    return;
  }

  // AUTO → skip review entirely
  if (decision === "auto") {
    const d = await getDraftByEmailId(email.id);
    if (d && d.status !== "approved") {
      await approveDraft(d.id);
    }

    const movedToReview = await transitionGeneratedToAwaitingReview(email.id);
    if (!movedToReview && email.state !== "AWAITING_REVIEW" && email.state !== "READY_TO_SEND") {
      await logStep({
        trace_id: traceId,
        gmail_id: email.gmail_id,
        step: "cas_abort_generated_to_awaiting_review",
        state: email.state,
        latency_ms: 0,
      });
      return;
    }

    await markReadyToSend(email.id);

    await setReviewOutcome(email.id, null);

    await logStep({
      trace_id: traceId,
      gmail_id: email.gmail_id,
      step: "auto_ready_to_send",
      state: "READY_TO_SEND",
      latency_ms: 0,
    });

    return;
  }
}

function isValidClassification(c: { category: string; confidence: number }): boolean {
  return (
    typeof c.category === "string" &&
    c.category.length > 0 &&
    typeof c.confidence === "number" &&
    Number.isFinite(c.confidence)
  );
}

function buildClarificationReply(input: {
  subject: string;
  retrievalIntent: string;
  ragConfidence: number;
}): string {
  const greeting = "Thanks for your message.";
  if (input.retrievalIntent === "product_query") {
    return `${greeting} To give the most accurate answer, are you asking about pricing, features, or integration details?`;
  }
  if (input.retrievalIntent === "support_query") {
    return `${greeting} To help quickly, can you share whether this is a login issue, an error message, or a workflow problem?`;
  }
  if (input.ragConfidence < 0.3) {
    return `${greeting} I want to avoid guessing. Do you want details about pricing, features, or usage?`;
  }
  return `${greeting} Could you clarify what you want most: a short summary, a detailed explanation, or next-step guidance?`;
}

export async function ingestInboxEmails(): Promise<void> {
  const user = await getPrimaryUser();
  if (!user) {
    logger.warn("Ingest skip: no primary user found");
    return;
  }

  const config = await getConfig();
  const systemId = await getDefaultSystemId();
  const accountId = await resolveDefaultAccountId(systemId);
  const account = accountId ? await getEmailAccountById(accountId) : null;
  
  // TIER 3 HARDENING: Reconcile local thread states before ingestion
  try {
    const reconciled = await reconcileThreadStates(accountId ?? undefined);
    if (reconciled > 0) {
      logger.info(`Reconciled ${reconciled} thread states to REPLIED`);
    }
  } catch (err) {
    logger.error("Reconciliation failed", { error: err instanceof Error ? err.message : String(err) });
  }

  const effectiveCursor = accountId
    ? (account?.last_history_id ?? null)
    : (config.last_gmail_history_id ?? null);
  const sync = await syncGmailMailbox(config, user.id, effectiveCursor, accountId ?? undefined);

  if (sync.kind === "disabled") {
    try { await updateServiceHealth("gmail", "down", "Gmail sync disabled — no valid credentials"); } catch { /* non-critical */ }
    return;
  }

  if (sync.kind === "first_run") {
    if (accountId) {
      await updateAccountHistoryCursor(accountId, sync.profileHistoryId);
    } else {
      await updateConfig({ last_gmail_history_id: sync.profileHistoryId });
    }
    await logStep({
      trace_id: createTraceId(),
      gmail_id: null,
      step: "gmail_first_run_skip",
      state: "INGESTED",
      latency_ms: 0,
    });
    return;
  }

  if (sync.kind === "history_reset") {
    if (accountId) {
      await updateAccountHistoryCursor(accountId, sync.profileHistoryId);
    } else {
      await updateConfig({ last_gmail_history_id: sync.profileHistoryId });
    }
    await logStep({
      trace_id: createTraceId(),
      gmail_id: null,
      step: "gmail_history_reset",
      state: "INGESTED",
      latency_ms: 0,
    });
    return;
  }

  let emailsToIngest: GmailEmail[] = [];
  let nextHistoryId: string | null = null;
  let noNewMessages = false;

  if (sync.kind === "invalid_history_id") {
    const recoveryTraceId = createTraceId();
    const recovery = evaluateErrorRecovery(
      {
        code: "INVALID_HISTORY_CURSOR",
        category: "DATA_INCONSISTENCY",
        severity: "high",
        retryable: true,
        autoRecoverable: true,
        message: "Gmail history cursor invalidated",
        reason: sync.summary,
        fix: "Reset cursor and perform full mailbox resync.",
        status: 400,
      },
      {
        source: "worker",
        subsystem: "gmail",
        operation: "ingest_gmail_history_cursor",
        resourceId: accountId ?? user.id,
        maxAttempts: 2,
      },
    );
    const recoveryMeta = toRecoveryMeta(recovery);

    if (recovery.action === "escalate" || !recovery.appError.autoRecoverable) {
      await logStep({
        trace_id: recoveryTraceId,
        gmail_id: null,
        step: "gmail_invalid_start_history_id_exhausted",
        state: "ERROR_TEMP",
        latency_ms: 0,
        error: `${sync.summary} | recovery=${JSON.stringify(recoveryMeta)}`,
      });

      try {
        await updateServiceHealth("gmail", "down", recovery.appError.reason, {
          recovery: recoveryMeta,
        });
      } catch {
        // non-critical
      }
      return;
    }

    if (accountId) {
      await clearAccountHistoryCursor(accountId);
    } else {
      await updateConfig({ last_gmail_history_id: null });
    }

    await logStep({
      trace_id: recoveryTraceId,
      gmail_id: null,
      step: "gmail_invalid_start_history_id",
      state: "INGESTED",
      latency_ms: 0,
      error: `${sync.summary} | recovery=${JSON.stringify(recoveryMeta)}`,
    });

    try {
      await updateServiceHealth("gmail", "degraded", "Invalid startHistoryId detected, running full resync", {
        recovery: recoveryMeta,
      });
    } catch {
      // non-critical
    }

    const resync = await performFullResync(user.id, accountId ?? undefined);
    if (!resync) {
      try {
        await updateServiceHealth("gmail", "down", "Gmail full resync failed — no valid credentials", {
          recovery: recoveryMeta,
        });
      } catch {
        // non-critical
      }
      return;
    }

    emailsToIngest = resync.emails;
    nextHistoryId = resync.latestHistoryId;
    noNewMessages = emailsToIngest.length === 0;

    logger.warn("Gmail history cursor invalidated; full resync complete", {
      traceId: recoveryTraceId,
      accountId: accountId ?? null,
      fetchedCount: resync.fetchedMessageCount,
      ingestedCandidateCount: emailsToIngest.length,
      baselineHistoryId: nextHistoryId,
    });

    await logStep({
      trace_id: recoveryTraceId,
      gmail_id: null,
      step: "gmail_full_resync_complete",
      state: "INGESTED",
      latency_ms: 0,
      error: `recovery=${JSON.stringify(recoveryMeta)}`,
    });
  } else {
    emailsToIngest = sync.emails;
    nextHistoryId = sync.nextHistoryId;
    noNewMessages = sync.noNewMessages;
  }

  if (noNewMessages) {
    await logStep({
      trace_id: createTraceId(),
      gmail_id: null,
      step: "gmail_no_new_messages",
      state: "INGESTED",
      latency_ms: 0,
    });
  }

  // Report successful Gmail sync to system_health
  try { await updateServiceHealth("gmail", "ok"); } catch { /* non-critical */ }

  for (const email of emailsToIngest) {
    const traceId = createTraceId();

    // CRITICAL FIX 6: Self-loop prevention.
    // Never re-ingest emails generated by the app.
    if (email.appGenerated) {
      logger.info("Ingest skip: app-generated email", { gmailId: email.gmailId, traceId });
      continue;
    }

    // CRITICAL FIX 1 & 6: Strictly handle source based on labels.
    // If it's a sent email, it should NOT enter the inbox 'INGESTED' flow for classification/reply.
    const isSent = email.source === "sent";
    const initialState = isSent ? "SENT" : "INGESTED";

    await upsertThread(email.threadId, email.threadMessages, accountId ?? undefined, systemId);

    const inserted = await insertEmailIfNotExists({
      systemId,
      accountId,
      gmailId: email.gmailId,
      traceId,
      threadId: email.threadId,
      fromEmail: sanitizeStoredEmailText(email.from || ""),
      subject: sanitizeStoredEmailText(email.subject || "(no subject)"),
      body: sanitizeStoredEmailText(email.body || ""),
      snippet: sanitizeStoredEmailText(email.snippet || ""),
      internalDate: email.internalDate,
      source: email.source,
      state: initialState,
    });

    if (inserted) {
      // Logic for new emails.
      await updateParsedContent(inserted.id, {
        subject: inserted.subject,
        from: inserted.from_email,
        body: inserted.body,
        snippet: inserted.snippet,
        thread_id: inserted.thread_id,
        app_generated: email.appGenerated, // Ensure appGenerated flag is preserved in parsed_content
        sent_by_user: email.source === "sent" && !email.appGenerated,
        user_edited: email.userEdited,
      });

      // CRITICAL FIX 3 & 4: Index into RAG.
      // Queue sent-memory indexing off the hot path. The worker processes it separately.
      const fresh = await getEmailById(inserted.id);
      if (fresh && isEligibleSentMemoryEmail(fresh)) {
        await queueEmbeddingJob(fresh.id, traceId, {
          accountId,
          systemId,
          priority: Math.max(1, Math.min(10, Math.round((fresh.priority_score ?? 0.5) * 10))),
        });
      }

      logger.info("Email ingested", { 
        gmailId: email.gmailId, 
        traceId, 
        source: email.source, 
        state: initialState 
      });

      await logStep({
        trace_id: traceId,
        gmail_id: email.gmailId,
        step: isSent ? "ingest_sent_knowledge" : "ingest",
        state: initialState,
        latency_ms: 0,
      });
    } else {
      // DUPLICATE SKIP (CRITICAL FIX 2)
      // verify if it needs RAG despite being duplicate (e.g. if previous ingestion failed rag)
      const existing = await getEmailByGmailId(email.gmailId, accountId ?? undefined);
      if (existing && isEligibleSentMemoryEmail(existing) && existing.embedding_status !== "embedded") {
        await queueEmbeddingJob(existing.id, traceId, {
          accountId,
          systemId,
          priority: Math.max(1, Math.min(10, Math.round((existing.priority_score ?? 0.5) * 10))),
        });
      }
    }
  }

  // Commit cursor only after all ingestion writes succeed.
  if (nextHistoryId) {
    if (accountId) {
      await updateAccountHistoryCursor(accountId, nextHistoryId);
    } else {
      await updateConfig({ last_gmail_history_id: nextHistoryId });
    }
  }
}

export async function processComposeRequests(): Promise<void> {
  const req = await claimComposeRequest();
  if (!req) return;

  const traceId = req.trace_id;
  try {
    const email = await insertComposeEmail({
      gmailId: `compose-${Date.now()}-${req.id}`,
      traceId,
      category: req.category,
      context: req.context,
    });

    await logStep({
      trace_id: traceId,
      gmail_id: email.gmail_id,
      step: "compose_queued",
      state: email.state,
      latency_ms: 0,
    });

    // Let normal worker loop handle READY_TO_GENERATE -> GENERATED -> AWAITING_REVIEW draft.
    await markComposeRequestDone(req.id);
  } catch (error) {
    await logStep({
      trace_id: traceId,
      gmail_id: null,
      step: "compose_error",
      state: "ERROR_TEMP",
      latency_ms: 0,
      error: error instanceof Error ? error.message : "unknown_error",
    });
  }
}

async function processOneEmail(email: EmailRecord): Promise<void> {
  const emailId = email.id;
  const traceId = email.trace_id ?? createTraceId();
  let leaseAborted = false;
  let enteredPipeline = false;

  const leaseOk = async (leaseVersion: number): Promise<boolean> => {
    if (await isProcessingLeaseCurrent(emailId, leaseVersion)) return true;
    leaseAborted = true;
    const row = await getEmailById(emailId);
    await logStep({
      trace_id: traceId,
      gmail_id: row?.gmail_id ?? null,
      step: "lease_aborted",
      state: row?.state ?? "PROCESSING",
      latency_ms: 0,
    });

    return false;
  };

  try {
    const working = await getEmailById(emailId);
    if (!working) return;
    if (working.state !== email.state) {
      logger.info("processOneEmail skip stale snapshot", {
        id: emailId,
        listState: email.state,
        dbState: working.state,
      });

      return;
    }

    email = working;
    const leaseVersion = email.processing_version ?? 0;
    const config = await getConfig();

    await withTrace(traceId, async () => {
      enteredPipeline = true;

      if (!(await leaseOk(leaseVersion))) return;

    if (email.state === "PROCESSING" || email.state === "ERROR_TEMP") {
      const t0 = Date.now();
      const threadMessages = await getThreadMessages(email.thread_id, 5, email.account_id ?? undefined);
      const preClassPriority = computePriorityScore({
        fromEmail: email.from_email,
        subject: email.subject,
        body: email.body,
        threadActivityCount: threadMessages.length,
      });
      const classTier = selectModelTier({
        priorityScore: preClassPriority.score,
        riskScore: email.risk_score ?? 0,
        costScore: email.cost_score ?? 0,
      });
      const classModel = await chooseAdaptiveModel(
        "classification",
        classTier,
        modelForTask("classification", classTier),
      );
      let classification: Awaited<ReturnType<typeof classifyEmailWithThread>>;
      try {
        classification = await classifyEmailWithThread(email, config, threadMessages, classModel);
        if (classification.fallbackError) {
          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "llm_fallback",
            state: email.state,
            latency_ms: 0,
            error: classification.fallbackError,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        classification = {
          category: "unknown",
          confidence: 0,
          tokensIn: 0,
          tokensOut: 0,
          latencyMs: 0,
          promptVersion: "classifier.catch.v1",
          reason: "fallback_llm_failure",
        };
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "classification_fallback",
          state: "CLASSIFIED",
          latency_ms: Date.now() - t0,
          error: message,
        });
      }
      if (!isValidClassification(classification)) {
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "classification_fallback_invalid",
          state: email.state,
          latency_ms: 0,
        });
        const fallbackClass: ClassificationResult = {
          category: "unknown",
          confidence: 0,
          tokensIn: 0,
          tokensOut: 0,
          latencyMs: 0,
          promptVersion: "classification.invalid_fallback.v1",
          reason: "invalid_classification_fallback",
        };
        classification = fallbackClass;
      }
      try {
        await updateEmailClassification(email.id, classification.category, classification.confidence);
        await updateEmailLlmMetrics(email.id, {
          tokensIn: classification.tokensIn,
          tokensOut: classification.tokensOut,
          latencyMs: classification.latencyMs,
          promptVersion: classification.promptVersion,
        });
      } catch {
        /* DB errors: still advance state so email does not stick */
      }
      email.state = "CLASSIFIED";
      email.category = classification.category;
      email.confidence = classification.confidence;

      await logStep({
        trace_id: traceId,
        gmail_id: email.gmail_id,
        step: "classify",
        state: "CLASSIFIED",
        latency_ms: Date.now() - t0,
      });
    }

    if (!(await leaseOk(leaseVersion))) return;

    if (email.state === "CLASSIFIED") {
      const threadMessages = await getThreadMessages(email.thread_id, 10, email.account_id ?? undefined);
      const priority = computePriorityScore({
        fromEmail: email.from_email,
        subject: email.subject,
        body: email.body,
        threadActivityCount: threadMessages.length,
      });

      const decisionOutput = decideAction({
        category: email.category ?? "general",
        confidence: email.confidence ?? 0,
        config,
        priorityScore: priority.score,
        riskScore: email.risk_score ?? 0,
        costScore: email.cost_score ?? 0,
        ragConfidence: email.rag_confidence ?? 0.5,
      });
      try {
        await markReadyToGenerate(email.id, decisionOutput.decision);
        await updateEmailIntelligence(email.id, {
          priorityScore: priority.score,
          decisionReason: decisionOutput.reason,
        });
      } catch {
        /* ignore */
      }
      email.state = "READY_TO_GENERATE";
      email.decision = decisionOutput.decision;
      await logStep({
        trace_id: traceId,
        gmail_id: email.gmail_id,
        step: "decide",
        state: "READY_TO_GENERATE",
        latency_ms: 0,
      });
    }

    if (!(await leaseOk(leaseVersion))) return;

    if (email.state === "READY_TO_GENERATE") {
      const manualRequested = isManualGenerateRequested(email.parsed_content, email.manual_generate_requested ?? null);
      const confidence = email.confidence ?? 0;

      if (confidence === 0) {
        try {
          await updateEmailDecision(email.id, "manual");
          await setManualGenerateRequested(email.id, false);
        } catch {
          /* ignore */
        }
        email.decision = "manual";
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "confidence_zero_stop_ready_to_generate",
          state: "READY_TO_GENERATE",
          latency_ms: 0,
        });
        return;
      }

      // Hard manual-mode guarantee: manual global mode must NEVER auto-generate.
      if (config.global_mode === "manual") {
        if (!manualRequested) {
          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "manual_mode_wait_generate",
            state: email.state,
            latency_ms: 0,
          });
          return;
        }
      }

      const t0 = Date.now();

      // ── Budget gate: stop generation if daily token limit exceeded ──
      const budgetOk = await isBudgetAvailable();
      if (!budgetOk) {
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "generation_paused_budget",
          state: email.state,
          latency_ms: 0,
          error: "Daily token budget exceeded — generation paused until next day",
        });
        return; // Stay in READY_TO_GENERATE, will retry when budget resets
      }

      const budgetStatus = await checkBudget();
      const accountProfile = email.account_id ? await getEmailAccountById(email.account_id) : null;

      const preflightPriority = email.priority_score ?? 0.5;
      const preflightIntentTier = selectModelTier({
        priorityScore: preflightPriority,
        riskScore: email.risk_score ?? 0,
        costScore: email.cost_score ?? 0,
      });
      const preflightIntentModel = await chooseAdaptiveModel(
        "intent",
        preflightIntentTier,
        modelForTask("intent", preflightIntentTier),
      );

      const preflightSemanticIntent = await classifyIntentRisks({
        message: `${email.subject}\n${email.body}`,
        recipientEmail: email.from_email,
        model: preflightIntentModel,
        ...(accountProfile?.email_address ? { senderEmail: accountProfile.email_address } : {}),
      });

      if (preflightSemanticIntent.blockAutoSend || preflightSemanticIntent.forceManual) {
        const reason = `Inbound safety preflight: ${preflightSemanticIntent.reasons.join(", ") || "semantic_risk"}`;
        const manualHoldModel = modelForTask("generation", "high");
        try {
          await updateEmailDecision(email.id, "manual");
          await updateEmailIntelligence(email.id, {
            riskReasons: preflightSemanticIntent.reasons,
            decisionReason: reason,
            selectedModel: manualHoldModel,
          });
        } catch {
          /* ignore */
        }

        email.decision = "manual";
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "semantic_preflight_manual_hold",
          state: email.state,
          latency_ms: 0,
          error: reason,
        });
        return;
      }

      // Normal generation path.
      let ragContext: StructuredContextItem[] = [];
      let ragTraceBuilder: any = null; // Typing loosely because RagTraceBuilder is internal to rag.ts exports
      let ragConfidence = 0;
      let ragConflictDetected = false;
      let retrievalIntent = "unknown";
      try {
        const ragOptions = {
          emailId: email.id,
          ...(traceId ? { traceId } : {}),
          ...(email.account_id ? { accountId: email.account_id } : {}),
          ...(email.thread_id ? { threadId: email.thread_id } : {}),
        };
        const ragResponse = await getRelevantContext(email.subject, email.body, ragOptions);
        ragContext = ragResponse.items;
        ragTraceBuilder = ragResponse.builder;
        ragConfidence = ragResponse.diagnostics.confidenceScore;
        ragConflictDetected = ragResponse.diagnostics.conflictDetected;
        retrievalIntent = ragResponse.diagnostics.retrievalIntent;
      } catch (err) {
        const ragRecovery = evaluateErrorRecovery(err, {
          source: "worker",
          subsystem: "rag",
          operation: "retrieve_context",
          resourceId: email.id,
        });
        ragContext = [];
        ragConfidence = 0;
        retrievalIntent = "unknown";
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "rag_fallback_without_context",
          state: email.state,
          latency_ms: 0,
          error: `${ragRecovery.appError.code} | action=${ragRecovery.action}`,
        });
      }

      const priorityScore = email.priority_score ?? 0.5;
      const estimate = estimateGenerationCost({
        subject: email.subject,
        body: email.body,
        ragContext,
        model: "gpt-4.1-mini",
        priorityScore,
        budgetRemainingTokens: budgetStatus.budget_remaining,
      });

      // RAG confidence decision engine: high=strong, medium=partial, low=none/clarify.
      if (ragConfidence >= 0.7) {
        ragContext = ragContext.slice(0, 4);
      } else if (ragConfidence >= 0.4) {
        ragContext = ragContext.slice(0, 2);
      } else {
        ragContext = [];
      }

      if (estimate.skipRag) {
        ragContext = [];
        ragConfidence = 0;
      } else if (estimate.compressPrompt && ragContext.length > 2) {
        ragContext = ragContext.slice(0, 2);
      }

      const needsClarification =
        email.category === "unknown" || retrievalIntent === "unknown" || ragConfidence < 0.32;
      if (config.global_mode !== "manual" && needsClarification && !manualRequested) {
        const clarificationTier = selectModelTier({
          priorityScore,
          riskScore: email.risk_score ?? 0,
          costScore: estimate.costScore,
        });
        const clarificationModel = await chooseAdaptiveModel(
          "generation",
          clarificationTier,
          modelForTask("generation", clarificationTier),
        );
        const clarificationReply = buildClarificationReply({
          subject: email.subject,
          retrievalIntent,
          ragConfidence,
        });
        try {
          await updateEmailReply(email.id, clarificationReply);
          await updateEmailLlmMetrics(email.id, {
            tokensIn: 0,
            tokensOut: 0,
            latencyMs: 0,
            promptVersion: "clarification.loop.v1",
          });
          await updateEmailDecision(email.id, "assist");
          await updateEmailIntelligence(email.id, {
            ragConfidence,
            ragConflictDetected,
            decisionReason: `Clarification loop triggered: intent=${retrievalIntent}, rag_confidence=${ragConfidence.toFixed(2)}`,
            clarificationMode: true,
            selectedModel: clarificationModel,
          });
        } catch {
          /* ignore */
        }

        email.state = "GENERATED";
        email.reply = clarificationReply;
        email.decision = "assist";

        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "clarification_loop_generated",
          state: "GENERATED",
          latency_ms: 0,
        });
        return;
      }

      const preGenDecision = decideAction({
        category: email.category ?? "general",
        confidence: email.confidence ?? 0,
        config,
        riskScore: email.risk_score ?? 0,
        costScore: estimate.costScore,
        priorityScore,
        ragConfidence,
      });

      try {
        await updateEmailIntelligence(email.id, {
          costEstimateTokens: estimate.estimatedTotalTokens,
          costScore: estimate.costScore,
          ragConfidence,
          ragConflictDetected,
          decisionReason: preGenDecision.reason,
          clarificationMode: false,
        });
      } catch {
        /* ignore */
      }

      if (preGenDecision.decision !== email.decision) {
        email.decision = preGenDecision.decision;
        try {
          await updateEmailDecision(email.id, preGenDecision.decision);
        } catch {
          /* ignore */
        }
      }

      if (preGenDecision.decision === "manual" && !manualRequested && !needsClarification) {
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "intelligence_manual_hold",
          state: email.state,
          latency_ms: 0,
          error: preGenDecision.reason,
        });
        return;
      }

      const threadMessages = await getThreadMessages(email.thread_id, 5, email.account_id ?? undefined);
      const genTier = selectModelTier({
        priorityScore,
        riskScore: email.risk_score ?? 0,
        costScore: estimate.costScore,
      });
      const generationModel = await chooseAdaptiveModel(
        "generation",
        genTier,
        modelForTask("generation", genTier),
      );
      let selectedModel = generationModel;
      try {
        await updateEmailIntelligence(email.id, {
          selectedModel,
        });
      } catch {
        /* ignore */
      }
      try {
        await updateEmailRagContext(email.id, ragContext);
        await recordRagRetrievalForEmail(email.id);
      } catch {
        /* ignore */
      }

      let generation: Awaited<ReturnType<typeof generateReply>>;
      let forceManualFromLlmFallback = false;
      try {
        generation = await generateReply(email, ragContext, threadMessages, {
          displayName: accountProfile?.email_address ?? null,
          email: accountProfile?.email_address ?? null,
        }, generationModel, accountProfile?.user_id ?? null);

        if ((generation.styleConfidence ?? 0.6) < 0.5) {
          const retryModel = await chooseAdaptiveModel("generation", "high", modelForTask("generation", "high"));
          const secondTry = await generateReply(email, ragContext, threadMessages, {
            displayName: accountProfile?.email_address ?? null,
            email: accountProfile?.email_address ?? null,
          }, retryModel, accountProfile?.user_id ?? null);
          if ((secondTry.styleConfidence ?? 0) >= (generation.styleConfidence ?? 0)) {
            generation = secondTry;
            selectedModel = retryModel;
          }
        }

        if (generation.fallbackError) {
          const llmRecovery = evaluateErrorRecovery(
            {
              code: "LLM_GENERATION_FAILED",
              category: "API",
              severity: "high",
              retryable: true,
              autoRecoverable: true,
              message: "LLM generation failed",
              reason: generation.fallbackError,
              fix: "Switch to manual draft handling and retry once dependencies recover.",
              status: 503,
            },
            {
              source: "worker",
              subsystem: "llm",
              operation: "generate_reply",
              resourceId: email.id,
            },
          );
          forceManualFromLlmFallback = llmRecovery.action === "fallback_manual_mode";

          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "llm_fallback",
            state: email.state,
            latency_ms: 0,
            error: `${generation.fallbackError} | action=${llmRecovery.action}`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const llmRecovery = evaluateErrorRecovery(err, {
          source: "worker",
          subsystem: "llm",
          operation: "generate_reply_thrown",
          resourceId: email.id,
        });
        forceManualFromLlmFallback = llmRecovery.action === "fallback_manual_mode";
        generation = {
          reply: "We received your message. Our team will respond shortly.",
          tokensIn: 0,
          tokensOut: 0,
          latencyMs: 0,
          promptVersion: "generator.catch.v1",
          fallbackError: message,
        };
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "generation_fallback",
          state: "GENERATED",
          latency_ms: Date.now() - t0,
          error: `${message} | action=${llmRecovery.action}`,
        });
      }

      if (forceManualFromLlmFallback) {
        email.decision = "manual";
        try {
          await updateEmailDecision(email.id, "manual");
          await updateEmailIntelligence(email.id, {
            decisionReason: "LLM hard-failure fallback: manual review enforced",
            riskReasons: ["llm_fallback_manual"],
          });
        } catch {
          /* ignore */
        }
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "llm_manual_fallback",
          state: email.state,
          latency_ms: 0,
        });
      }

      let replyText = (generation.reply ?? "").trim();
      if (!replyText || replyText.length < 5) {
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "invalid_generation",
          state: email.state,
          latency_ms: Date.now() - t0,
        });
        replyText =
          "We received your message and will follow up with a detailed response shortly. Thank you for your patience.";
      }

      try {
        await updateEmailIntelligence(email.id, {
          selectedModel,
          ...(generation.styleConfidence !== undefined
            ? { styleConfidence: generation.styleConfidence }
            : {}),
          clarificationMode: false,
        });
      } catch {
        /* ignore */
      }

      try {
        await updateEmailReply(email.id, replyText);
        await updateEmailLlmMetrics(email.id, {
          tokensIn: generation.tokensIn,
          tokensOut: generation.tokensOut,
          latencyMs: generation.latencyMs,
          promptVersion: generation.promptVersion,
        });
        await setManualGenerateRequested(email.id, false);
        await updateEmailIntelligence(email.id, {
          selectedModel,
          ...(generation.styleConfidence !== undefined
            ? { styleConfidence: generation.styleConfidence }
            : {}),
          clarificationMode: false,
        });
      } catch {
        /* ignore */
      }

      email.state = "GENERATED";
      email.reply = replyText;

      const senderEmail = accountProfile?.email_address ?? undefined;
      const recipientEmail = email.from_email;
      const generatedVoice = extractVoiceStyleFeatures(replyText);
      const risk = await computeRiskScore({
        replyText,
        aggressionToneScore: generatedVoice.aggression_level,
        recipientEmail,
        ...(senderEmail ? { senderEmail } : {}),
      });

      const postIntentModel = await chooseAdaptiveModel("intent", "mid", modelForTask("intent", "mid"));
      const semanticRecheck = await classifyIntentRisks({
        message: replyText,
        recipientEmail,
        ...(senderEmail ? { senderEmail } : {}),
        model: postIntentModel,
      });
      const regexRecheck = runSafetyChecks(replyText);
      if (semanticRecheck.blockAutoSend || semanticRecheck.forceManual || !regexRecheck.ok) {
        email.decision = "manual";
        await updateEmailDecision(email.id, "manual");
        await updateEmailIntelligence(email.id, {
          decisionReason: `Post-generation safety gate: ${[...semanticRecheck.reasons, ...regexRecheck.reasons].join(", ")}`,
          riskReasons: [...semanticRecheck.reasons, ...regexRecheck.reasons],
        });
      }

      const postGenDecision = decideAction({
        category: email.category ?? "general",
        confidence: email.confidence ?? 0,
        config,
        riskScore: risk.score,
        costScore: email.cost_score ?? 0,
        priorityScore: email.priority_score ?? 0.5,
        ragConfidence: email.rag_confidence ?? 0.5,
      });

      try {
        await updateEmailIntelligence(email.id, {
          riskScore: risk.score,
          riskReasons: risk.reasons,
          decisionReason: postGenDecision.reason,
        });
      } catch {
        /* ignore */
      }

      if (!forceManualFromLlmFallback && postGenDecision.decision !== email.decision) {
        email.decision = postGenDecision.decision;
        await updateEmailDecision(email.id, postGenDecision.decision);
      }

      if ((email.decision ?? "manual") === "auto") {
        const voiceScore = generation.voiceMatchScore ?? 0;
        const toneScore = generation.toneConsistency ?? 0;
        const minVoiceScore = 0.62;
        const minToneScore = 0.5;
        if (voiceScore < minVoiceScore || toneScore < minToneScore) {
          email.decision = "assist";
          await updateEmailDecision(email.id, "assist");
          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "auto_downgraded_voice_tone",
            state: email.state,
            latency_ms: 0,
            error: `voice=${voiceScore.toFixed(2)}, tone=${toneScore.toFixed(2)}`,
          });
        }
      }
      
      // Mechanism 1 & 2 & 5: Robust Adaptive Feedback Calculation
      if (ragTraceBuilder) {
        await calculateAndSaveTrace(
          replyText,
          { subject: email.subject, body: email.body },
          ragContext,
          ragTraceBuilder,
          email.id
        );
      }


      await logStep({
        trace_id: traceId,
        gmail_id: email.gmail_id,
        step: "generate",
        state: "GENERATED",
        latency_ms: Date.now() - t0,
      });
    }

    if (!(await leaseOk(leaseVersion))) return;

    if (email.state === "GENERATED" && email.reply) {
      const decision = (email.decision ?? "manual") as "manual" | "assist" | "auto";

      if (decision === "manual") {
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "manual_generated_no_progress",
          state: "GENERATED",
          latency_ms: 0,
        });
        return;
      }

      const replyBody =
        email.reply.trim().length >= 5
          ? email.reply
          : "We received your message and will follow up with a detailed response shortly. Thank you for your patience.";
      let draftCreated = false;
      try {
        const safety = runSafetyChecks(replyBody);
        const isFallbackDraft = (email.prompt_version ?? "").includes("fallback");
        await createDraft(email.id, replyBody, isFallbackDraft);
        draftCreated = true;
        await onDraftCreatedSuccess(
          email,
          traceId,
          config,
          { ok: safety.ok, reasons: safety.reasons },
          decision
        );
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "draft_stage_error",
          state: email.state,
          latency_ms: 0,
          error: message,
        });
        try {
          await createDraft(email.id, replyBody, true);
          draftCreated = true;
          const safety = runSafetyChecks(replyBody);
          await onDraftCreatedSuccess(
            email,
            traceId,
            config,
            { ok: safety.ok, reasons: safety.reasons },
            decision
          );
        } catch {
          /* handled below */
        }
      }
      if (!draftCreated) {
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "draft_final_failure",
          state: "GENERATED",
          latency_ms: 0,
        });
        const moved = await transitionGeneratedToAwaitingReview(email.id);
        if (!moved) {
          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "cas_abort_generated_to_awaiting_review",
            state: email.state,
            latency_ms: 0,
          });
          return;
        }
        await createDraftFallback(email.id, replyBody);
        await setReviewOutcome(email.id, null);
        await maybeAutoApproveDraft(email.id, traceId, config);
      }
      return;
    }

    if (!(await leaseOk(leaseVersion))) return;

    if (email.state === "READY_TO_SEND") {
      try {
        const draft = await getDraftByEmailId(email.id);

        if (!draft || draft.status !== "approved") {
          await markAwaitingReview(email.id);
          return;
        }

        // TIER 3 HARDENING: Send Guard (Truth-based sequence check)
        const threadMessages = await getThreadMessages(email.thread_id, 3, email.account_id ?? undefined);
        const lastMsg = Array.isArray(threadMessages) && threadMessages.length > 0 ? threadMessages[threadMessages.length - 1] : null;
        const accountProfile = email.account_id ? await getEmailAccountById(email.account_id) : null;
        const senderRaw =
          lastMsg && typeof lastMsg === "object" && "from" in (lastMsg as object)
            ? String((lastMsg as { from?: unknown }).from ?? "").toLowerCase()
            : "";
        const lastMessageId =
          lastMsg && typeof lastMsg === "object" && "message_id" in (lastMsg as object)
            ? String((lastMsg as { message_id?: unknown }).message_id ?? "")
            : "";
        const accountEmail = (accountProfile?.email_address ?? "").toLowerCase();
        const isDuplicate = Boolean(accountEmail) && senderRaw.includes(accountEmail) && lastMessageId !== email.gmail_id;

        // 30-second Send Buffer for AUTO mode
        const isAuto = email.decision === "auto" && config.global_mode === "auto";
        if (isAuto) {
          const readyAt = email.ready_to_send_at ? new Date(email.ready_to_send_at).getTime() : Date.now();
          const bufferRemaining = 30000 - (Date.now() - readyAt);
          if (bufferRemaining > 0) {
            // Buffer still active, skip this turn but keep in READY_TO_SEND
            return;
          }
        }

           const confidence = email.confidence ?? 0;
           const autoSendThreshold = typeof config.threshold === "number" ? config.threshold : 0.7;
           if (isAuto && confidence < autoSendThreshold) {
          await logStep({
             trace_id: traceId,
             gmail_id: email.gmail_id,
             step: "send_blocked_risk_or_confidence",
             state: "AWAITING_REVIEW",
             latency_ms: 0,
             error: `Confidence ${confidence.toFixed(2)} below auto-send threshold ${autoSendThreshold.toFixed(2)}`,
          });
          await markAwaitingReview(email.id);
          return;
        }

        if (isDuplicate) {
           await logStep({
             trace_id: traceId,
             gmail_id: email.gmail_id,
             step: "send_blocked_duplicate",
             state: "REPLIED",
             latency_ms: 0,
             error: "Last message in thread is already outbound",
          });
          await updateEmailState(email.id, "REPLIED");
          return;
        }

        if (config.send_mode === "dry") {
          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "send_skipped_dry_mode",
            state: "READY_TO_SEND",
            latency_ms: 0,
          });
          return;
        }

        // Some stored `from_email` values lose the `@...` part during sanitization (e.g. when From is "Name <addr>").
        // In that case, recover a valid recipient from the thread messages (already stored from Gmail headers).
        let recipientTo = email.from_email;
        const emailFromHasAt = (email.from_email ?? "").includes("@");
        if (!emailFromHasAt) {
          const threadMessages = await getThreadMessages(email.thread_id, 5, email.account_id ?? undefined);
          const candidate = (Array.isArray(threadMessages)
            ? threadMessages
            : [])
            .map((m) => (m && typeof m === "object" && "from" in m ? (m as any).from : ""))
            .find((v) => typeof v === "string" && v.trim().length > 0) as string | undefined;
          if (candidate) {
            recipientTo = candidate;
          }
        }

        const body = draft.edited_body ?? draft.reply;
        const userEdited = Boolean(draft.edited_body && draft.edited_body.trim() !== (draft.reply ?? "").trim());
        const sendKey = crypto
          .createHash("sha1")
          .update(`${email.account_id ?? 0}:${email.thread_id}:${body}`)
          .digest("hex");
        const claimedSend = await claimSendAttempt(sendKey, email.id, email.account_id ?? null);
        if (!claimedSend) {
          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "send_blocked_idempotent_duplicate",
            state: "READY_TO_SEND",
            latency_ms: 0,
            error: "duplicate_send_key",
          });
          return;
        }

        const user = await getPrimaryUser();
        if (!user && !email.account_id) throw new Error("No account identity available for sending");

        // ── MULTI-LAYER SAFETY CHECK (before send) ────────────────────
        const voiceFeatures = extractVoiceStyleFeatures(body);
        const safetyResult = await runFullSafetyCheck({
          replyText: body,
          recipientEmail: recipientTo ?? email.from_email,
          senderEmail: accountEmail || undefined,
          aggressionLevel: voiceFeatures.aggression_level,
          emailId: email.id,
        } as Parameters<typeof runFullSafetyCheck>[0]);

        const intentTier = selectModelTier({
          priorityScore: email.priority_score ?? 0.5,
          riskScore: email.risk_score ?? 0,
          costScore: email.cost_score ?? 0,
        });
        const intentModel = await chooseAdaptiveModel(
          "intent",
          intentTier,
          modelForTask("intent", intentTier),
        );
        const semanticIntent = await classifyIntentRisks({
          message: body,
          recipientEmail: recipientTo ?? email.from_email,
          ...(accountEmail ? { senderEmail: accountEmail } : {}),
          model: intentModel,
        });

        const semanticBlock =
          ((semanticIntent.blockAutoSend && isAuto) || semanticIntent.forceManual) && !userEdited;
        if (semanticBlock) {
          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "send_blocked_semantic_intent",
            state: "AWAITING_REVIEW",
            latency_ms: 0,
            error: semanticIntent.reasons.join(", "),
          });
          try {
            await updateEmailIntelligence(email.id, {
              riskReasons: semanticIntent.reasons,
              decisionReason: `Semantic safety gate: ${semanticIntent.reasons.join(", ")}`,
            });
          } catch {
            /* ignore */
          }
          try { await failSendAttempt(sendKey); } catch { /* best-effort */ }
          await markAwaitingReview(email.id);
          return;
        }

        if (!safetyResult.autoSendAllowed && !userEdited) {
          // Safety blocked auto-send. Route to manual review.
          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "send_blocked_safety",
            state: "AWAITING_REVIEW",
            latency_ms: 0,
            error: safetyResult.reasons.join(", "),
          });
          try { await failSendAttempt(sendKey); } catch { /* best-effort */ }
          await markAwaitingReview(email.id);
          return;
        }

        if (safetyResult.violations.length > 0 && userEdited) {
          // User-edited content: log but don't block (user explicitly chose this).
          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "safety_warning_user_override",
            state: "READY_TO_SEND",
            latency_ms: 0,
            error: `User-edited draft with safety flags: ${safetyResult.reasons.join(", ")}`,
          });
        }

        await sendGmailEmail({
          to: recipientTo ?? email.from_email,
          subject: email.subject,
          body,
          threadId: email.thread_id,
          userEdited,
          ...(email.account_id ? { accountId: email.account_id } : {}),
          ...(user?.id ? { userId: user.id } : {}),
        });

        if (accountProfile?.user_id) {
          try {
            const existingSignatureRaw = await getUserStyleSignature(accountProfile.user_id);
            const existingSignature = (existingSignatureRaw as StyleSignature | null) ?? null;
            const mergedSignature = mergeStyleSignature(existingSignature, extractVoiceStyleFeatures(body));
            await saveUserStyleSignature(accountProfile.user_id, mergedSignature as unknown as Record<string, unknown>);
          } catch {
            /* style signature update is best effort */
          }
        }

        await completeSendAttempt(sendKey);
        await incrementEmailFeedbackCounter(email.id, "accepted_count").catch(() => {});
        await applyRagFeedbackForEmail(email.id, "accepted");
        await deleteDraftsByEmailId(email.id);
        await setReviewOutcome(email.id, null);
        const sentRow = await transitionReadyToSendToSent(email.id);
        if (!sentRow) {
          await logStep({
            trace_id: traceId,
            gmail_id: email.gmail_id,
            step: "cas_abort_ready_to_send_to_sent",
            state: "READY_TO_SEND",
            latency_ms: 0,
          });
          return;
        }
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "send",
          state: "SENT",
          latency_ms: 0,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          const draft = await getDraftByEmailId(email.id);
          const body = draft?.edited_body ?? draft?.reply ?? email.reply ?? "";
          const sendKey = crypto
            .createHash("sha1")
            .update(`${email.account_id ?? 0}:${email.thread_id}:${body}`)
            .digest("hex");
          await failSendAttempt(sendKey);
        } catch {
          // best-effort only
        }
        console.error("[Worker] READY_TO_SEND send error", { emailId: email.id, error: message });
        await logStep({
          trace_id: traceId,
          gmail_id: email.gmail_id,
          step: "send_error",
          state: "READY_TO_SEND",
          latency_ms: 0,
          error: message,
        });
        throw err instanceof Error ? err : new Error(message);
      }
    }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const row = await getEmailById(emailId);
    await logStep({
      trace_id: traceId,
      gmail_id: row?.gmail_id ?? null,
      step: "process_one_email_caught",
      state: row?.state ?? "ERROR_TEMP",
      latency_ms: 0,
      error: message,
    });
    logger.error("processOneEmail caught", { emailId, message, traceId });
    throw err instanceof Error ? err : new Error(message);
  } finally {
    if (enteredPipeline && !leaseAborted) {
      const final = await getEmailById(emailId);
      if (!final) return;
      if (final.state === "GENERATED" && (final.decision === "auto" || final.decision === "assist")) {
        await logStep({
          trace_id: traceId,
          gmail_id: final.gmail_id,
          step: final.decision === "assist" ? "final_state_generated_assist_recovery" : "final_state_generated_recovery",
          state: final.state,
          latency_ms: 0,
        });
        await updateEmailState(final.id, "AWAITING_REVIEW");
        const replyBody =
          final.reply && final.reply.trim().length >= 5
            ? final.reply
            : "We received your message and will follow up with a detailed response shortly. Thank you for your patience.";
        await createDraftFallback(final.id, replyBody);
        await setReviewOutcome(final.id, null);
        if (final.decision === "auto") {
          const cfg = await getConfig();
          await maybeAutoApproveDraft(final.id, traceId, cfg);
        }
      } else if (final.state === "PROCESSING") {
        await logStep({
          trace_id: traceId,
          gmail_id: final.gmail_id,
          step: "final_state_processing_recovery",
          state: final.state,
          latency_ms: 0,
        });
        await updateEmailState(final.id, "INGESTED");
      }
    }
  }
}

const DEFAULT_WORKER_BATCH_SIZE = 5;

async function processEmailSlot(email: EmailRecord): Promise<void> {
  const snapshot = await getEmailById(email.id);
  if (!snapshot || snapshot.state !== email.state) {
    return;
  }

  if (snapshot.state === "DEAD" || snapshot.state === "ERROR_FATAL" || snapshot.state === "SENT" || snapshot.state === "REPLIED") {
    return;
  }

  // Skip terminal-generated/manual-hold states when processing by ID.
  // Worker list selection already excludes these, but direct calls should honor
  // the same non-progressing conditions to prevent hot-loop churn.
  if (snapshot.state === "GENERATED") {
    const lastStep = snapshot.last_step ?? "";
    const manualRequested = isManualGenerateRequested(snapshot.parsed_content, snapshot.manual_generate_requested ?? null);
    const terminalGeneratedStep = ["assist_stop_generated", "assist_generated_stop", "manual_generated_no_progress"].includes(lastStep);
    const nonProgressingManual = snapshot.decision === "manual" && !manualRequested;
    if (terminalGeneratedStep || nonProgressingManual) {
      return;
    }
  }

  if (
    snapshot.state === "READY_TO_GENERATE" &&
    snapshot.decision === "manual" &&
    !isManualGenerateRequested(snapshot.parsed_content, snapshot.manual_generate_requested ?? null)
  ) {
    return;
  }

  if (snapshot.next_attempt_at) {
    const dueAt = new Date(snapshot.next_attempt_at).getTime();
    if (Number.isFinite(dueAt) && dueAt > Date.now()) {
      return;
    }
  }

  if (snapshot.state === "INGESTED") {
    const claimed = await claimEmailForProcessing(snapshot.id);
    if (!claimed) {
      return;
    }
    const claimedFresh = await getEmailById(claimed.id);
    if (!claimedFresh || claimedFresh.state !== "PROCESSING") {
      return;
    }
    await processOneEmail(claimedFresh);
    return;
  }

  await processOneEmail(snapshot);
}

export async function processEmailById(emailId: number): Promise<void> {
  const snapshot = await getEmailById(emailId);
  if (!snapshot) return;
  await processEmailSlot(snapshot);
}

export interface ProcessPendingEmailsOptions {
  shouldStop?: () => boolean;
  maxParallel?: number;
}

export async function processPendingEmails(
  limit = 50,
  options: ProcessPendingEmailsOptions = {},
): Promise<void> {
  if (options.shouldStop?.()) {
    return;
  }

  const emails = await listProcessableEmails(limit);

  const jobCounts = await countJobsByStatus("embed_email");
  const queuePressure = jobCounts.pending > 150 ? 0.5 : jobCounts.pending > 75 ? 0.75 : 1;
  const dynamicBase = getDynamicWorkerBatchSize(DEFAULT_WORKER_BATCH_SIZE);
  const batchSize = Math.max(1, Math.floor(dynamicBase * queuePressure));
  const batch = emails.slice(0, batchSize);
  const maxParallel = Math.max(1, options.maxParallel ?? batch.length);

  for (let start = 0; start < batch.length; start += maxParallel) {
    if (options.shouldStop?.()) {
      break;
    }

    const chunk = batch.slice(start, start + maxParallel);
    const outcomes = await Promise.allSettled(chunk.map((email) => processEmailSlot(email)));

    for (let i = 0; i < outcomes.length; i++) {
      const out = outcomes[i];
      const email = chunk[i];
      if (!out || out.status !== "rejected" || !email) continue;

      const message = out.reason instanceof Error ? out.reason.message : "Unknown processing error";
      const retry = await scheduleEmailRetry(email.id, message, MAX_PROCESS_ATTEMPTS);
      await logStep({
        trace_id: email.trace_id ?? createTraceId(),
        gmail_id: email.gmail_id,
        step: "process_error",
        state: retry.state,
        latency_ms: 0,
        error: retry.nextAttemptAt ? `${message} | next_attempt_at=${retry.nextAttemptAt}` : message,
      });
      logger.error("Email processing failed", {
        emailId: email.id,
        message,
        traceId: email.trace_id,
        retryState: retry.state,
        attemptCount: retry.attemptCount,
        nextAttemptAt: retry.nextAttemptAt,
      });
    }
  }
}
