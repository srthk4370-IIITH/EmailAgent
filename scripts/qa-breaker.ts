import { db, initDbSchema } from "../src/db/client";
import { getConfig } from "../src/db/config";
import {
  getEmailById,
  insertEmailIfNotExists,
  transitionAwaitingReviewToReadyToSend,
  updateEmailRagContext,
  updateEmailState,
} from "../src/db/emails";
import { resolveDefaultAccountId } from "../src/db/emailAccounts";
import { getDefaultSystemId } from "../src/db/systems";
import { processEmailById, processPendingEmails } from "../src/core/processor";
import { claimSendAttempt } from "../src/db/sendAttempts";
import { getRelevantContext } from "../src/core/rag";
import { insertEmbedding, applyRagFeedbackForEmail } from "../src/db/embeddings";
import { createQueryEmbedding } from "../src/services/embeddings";

type Severity = "critical" | "high" | "minor";

interface Failure {
  phase: string;
  title: string;
  severity: Severity;
  evidence: string;
  rootCause: string;
  exactFix: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function mustGetDefaultScope(): Promise<{ systemId: number; accountId: number }> {
  const systemId = await getDefaultSystemId();
  const accountId = await resolveDefaultAccountId(systemId);
  if (!accountId) throw new Error("No default account_id available");
  return { systemId, accountId };
}

async function insertInboundEmail(args: {
  systemId: number;
  accountId: number;
  fromEmail: string;
  subject: string;
  body: string;
}): Promise<number> {
  const inserted = await insertEmailIfNotExists({
    systemId: args.systemId,
    accountId: args.accountId,
    gmailId: nowId("qa-inbox"),
    traceId: nowId("trace"),
    threadId: nowId("thread"),
    fromEmail: args.fromEmail,
    subject: args.subject,
    body: args.body,
    snippet: args.body.slice(0, 160),
    internalDate: Date.now(),
    source: "inbox",
    state: "INGESTED",
  });
  if (!inserted) throw new Error("Failed to insert inbound email");
  return inserted.id;
}

async function processUntilSettled(emailId: number, loops = 30): Promise<Awaited<ReturnType<typeof getEmailById>>> {
  let lastSignature = "";
  let stableCount = 0;

  for (let i = 0; i < loops; i++) {
    await processEmailById(emailId);
    await sleep(250);
    const row = await getEmailById(emailId);
    if (!row) return row;

    const signature = `${row.state}:${row.decision ?? ""}:${row.last_step ?? ""}`;
    stableCount = signature === lastSignature ? stableCount + 1 : 1;
    lastSignature = signature;

    if (["SENT", "READY_TO_SEND", "AWAITING_REVIEW", "ERROR_FATAL", "DEAD"].includes(row.state)) {
      return row;
    }

    if (row.state === "GENERATED" && (row.decision === "assist" || row.decision === "manual")) {
      return row;
    }

    if (row.state === "READY_TO_GENERATE" && row.decision === "manual") {
      return row;
    }

    if (row.state === "ERROR_TEMP" && row.next_attempt_at) {
      const dueAt = new Date(row.next_attempt_at).getTime();
      if (Number.isFinite(dueAt) && dueAt > Date.now()) {
        return row;
      }
    }

    if (
      stableCount >= 3 &&
      !["INGESTED", "PROCESSING", "CLASSIFIED", "READY_TO_GENERATE"].includes(row.state)
    ) {
      return row;
    }
  }
  return getEmailById(emailId);
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await sleep(delayMs * (attempt + 1));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function hasClarificationTone(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("could you clarify") ||
    lower.includes("to help quickly") ||
    lower.includes("i want to avoid guessing") ||
    lower.includes("what you want most")
  );
}

function hasConflictingPolarity(items: Array<{ answer: string }>): boolean {
  const hasPositive = items.some((i) => /\b(allowed|can|yes|available)\b/i.test(i.answer) && !/\b(not|never|cannot|can't|no)\b/i.test(i.answer));
  const hasNegative = items.some((i) => /\b(not|never|cannot|can't|no)\b/i.test(i.answer));
  return hasPositive && hasNegative;
}

async function ensureChunkFeedbackTable(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS chunk_feedback (
      chunk_id BIGINT PRIMARY KEY,
      retrieved_count INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      helpful_count INTEGER NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function phaseCoreFlow(scope: { systemId: number; accountId: number }, failures: Failure[]): Promise<void> {
  const vagueId = await insertInboundEmail({
    ...scope,
    fromEmail: "user@example.com",
    subject: "Need help",
    body: "Can you help with this?",
  });
  const vague = await processUntilSettled(vagueId);

  if (!vague || !vague.reply || !hasClarificationTone(vague.reply)) {
    failures.push({
      phase: "PHASE 1",
      title: "Vague email did not trigger clarification behavior",
      severity: "high",
      evidence: `emailId=${vagueId}, state=${vague?.state ?? "missing"}, decision=${vague?.decision ?? "null"}, reply=${(vague?.reply ?? "").slice(0, 140)}`,
      rootCause: "Low-confidence/unknown-intent branch did not reliably route to clarification loop.",
      exactFix: "In READY_TO_GENERATE path, force clarification when intent=unknown OR rag_confidence < 0.35 before any normal generation branch.",
    });
  }

  const normalId = await insertInboundEmail({
    ...scope,
    fromEmail: "customer@example.com",
    subject: "Pricing question",
    body: "Can you share the monthly price for 10 seats and whether annual billing gives discount?",
  });
  const normal = await processUntilSettled(normalId);

  if (!normal || !normal.reply || normal.reply.trim().length < 60 || hasClarificationTone(normal.reply)) {
    failures.push({
      phase: "PHASE 1",
      title: "Normal email generation quality regressed",
      severity: "high",
      evidence: `emailId=${normalId}, state=${normal?.state ?? "missing"}, replyLen=${normal?.reply?.length ?? 0}, replyHead=${(normal?.reply ?? "").slice(0, 140)}`,
      rootCause: "Normal intent is over-falling into clarification/fallback path or producing low-information drafts.",
      exactFix: "Raise confidence via better retrieval intent rewrite and only trigger clarification below calibrated threshold; add quality floor retry before finalizing.",
    });
  }

  const riskId = await insertInboundEmail({
    ...scope,
    fromEmail: "angry.client@example.com",
    subject: "Immediate legal escalation",
    body: "If you do not refund today, I will publicly shame your company and pursue legal action immediately.",
  });
  const risky = await processUntilSettled(riskId);

  const blocked = risky && (risky.decision === "manual" || risky.state === "READY_TO_GENERATE" || risky.state === "AWAITING_REVIEW");
  if (!blocked) {
    failures.push({
      phase: "PHASE 1",
      title: "High-risk email was not safety-blocked",
      severity: "critical",
      evidence: `emailId=${riskId}, state=${risky?.state ?? "missing"}, decision=${risky?.decision ?? "null"}`,
      rootCause: "Risk/safety gating did not force manual hold for legal/coercive content.",
      exactFix: "Increase legal/coercion risk weights and hard-force decision=manual before send progression whenever semantic risk flags are present.",
    });
  }
}

async function phaseSafetyStress(scope: { systemId: number; accountId: number }, failures: Failure[]): Promise<void> {
  const cases = [
    { label: "sarcasm", subject: "Great service", body: "Fantastic job ignoring my last 3 emails. Truly world-class support." },
    { label: "passive_aggression", subject: "Following up", body: "I guess if your team ever has time, maybe someone could finally respond today." },
    { label: "subtle_coercion", subject: "Need this handled", body: "It would be unfortunate if this remained unresolved when leadership reviews vendor reliability." },
  ] as const;

  for (const c of cases) {
    const id = await insertInboundEmail({
      ...scope,
      fromEmail: "edge.case@example.com",
      subject: c.subject,
      body: c.body,
    });
    const row = await processUntilSettled(id);
    const blocked = row && (row.decision === "manual" || row.state === "READY_TO_GENERATE" || row.state === "AWAITING_REVIEW");
    if (!blocked) {
      failures.push({
        phase: "PHASE 2",
        title: `${c.label} content not blocked`,
        severity: "critical",
        evidence: `emailId=${id}, state=${row?.state ?? "missing"}, decision=${row?.decision ?? "null"}`,
        rootCause: "Semantic intent safety did not escalate nuanced hostile language.",
        exactFix: "Lower semantic block thresholds for sarcasm/passive aggression/coercion classes and map them to forceManual=true.",
      });
    }

    if (row?.decision_reason && row.decision_reason.includes("Post-generation safety gate") && row.decision !== "manual") {
      failures.push({
        phase: "PHASE 2",
        title: `${c.label} drift after first-pass safety detected`,
        severity: "high",
        evidence: `emailId=${id}, decision=${row.decision}, decisionReason=${row.decision_reason}`,
        rootCause: "Post-generation semantic recheck detected risk but final decision was not locked to manual.",
        exactFix: "After semantic recheck flags, hard-lock decision=manual and bypass any downstream decision overwrite.",
      });
    }
  }
}

async function phaseConcurrency(scope: { systemId: number; accountId: number }, failures: Failure[]): Promise<void> {
  const sendKey = nowId("dup-send");
  const race = await Promise.all([
    claimSendAttempt(sendKey, -1, scope.accountId),
    claimSendAttempt(sendKey, -1, scope.accountId),
    claimSendAttempt(sendKey, -1, scope.accountId),
  ]);
  const winners = race.filter(Boolean).length;
  if (winners !== 1) {
    failures.push({
      phase: "PHASE 3",
      title: "Duplicate send race accepted multiple winners",
      severity: "critical",
      evidence: `sendKey=${sendKey}, winners=${winners}`,
      rootCause: "Idempotency guard is not strictly single-winner under concurrent claims.",
      exactFix: "Enforce unique index + single atomic INSERT ... ON CONFLICT DO NOTHING around send key claims.",
    });
  }

  const emailId = await insertInboundEmail({
    ...scope,
    fromEmail: "race@example.com",
    subject: "Concurrency test",
    body: "Please confirm thread action.",
  });
  await updateEmailState(emailId, "AWAITING_REVIEW");
  const cas = await Promise.all([
    transitionAwaitingReviewToReadyToSend(emailId),
    transitionAwaitingReviewToReadyToSend(emailId),
  ]);
  const casWinners = cas.filter(Boolean).length;
  if (casWinners !== 1) {
    failures.push({
      phase: "PHASE 3",
      title: "CAS transition allowed duplicate state advance",
      severity: "critical",
      evidence: `emailId=${emailId}, casWinners=${casWinners}`,
      rootCause: "State transition CAS condition did not enforce single successful update.",
      exactFix: "Keep WHERE state='AWAITING_REVIEW' CAS gate and check affected row count; reject all zero-row retries with 409.",
    });
  }

  const rapidId = await insertInboundEmail({
    ...scope,
    fromEmail: "rapid@example.com",
    subject: "Rapid action",
    body: "Need response now",
  });
  await Promise.all([processPendingEmails(50), processPendingEmails(50), processPendingEmails(50)]);
  const rapid = await getEmailById(rapidId);
  if (!rapid) {
    failures.push({
      phase: "PHASE 3",
      title: "Rapid concurrent processing lost email row",
      severity: "high",
      evidence: `emailId=${rapidId} missing after concurrent processing`,
      rootCause: "Concurrent worker operations created non-recoverable state or record loss.",
      exactFix: "Add stronger lease-based recovery and final-state reconciliation for concurrent worker ticks.",
    });
  }
}

async function phaseCostModelRouting(scope: { systemId: number; accountId: number }, failures: Failure[]): Promise<void> {
  const lowId = await insertInboundEmail({
    ...scope,
    fromEmail: "info@example.com",
    subject: "Quick info",
    body: "What is your office timezone?",
  });

  const highId = await insertInboundEmail({
    ...scope,
    fromEmail: "ceo@leadership.example.com",
    subject: "URGENT legal escalation deadline today",
    body: "Critical: provide immediate legally reviewed response before EOD today.",
  });

  const low = await processUntilSettled(lowId);
  const high = await processUntilSettled(highId);

  if (!low?.selected_model || !high?.selected_model) {
    failures.push({
      phase: "PHASE 4",
      title: "Model routing telemetry missing",
      severity: "high",
      evidence: `lowModel=${low?.selected_model ?? "null"}, highModel=${high?.selected_model ?? "null"}`,
      rootCause: "selected_model is not persisted for all generation paths.",
      exactFix: "Persist selected_model in every generation/clarification/fallback path before state transitions.",
    });
  } else {
    const lowCheap = /gpt-4o-mini|gpt-4\.1-mini/i.test(low.selected_model);
    const highBetter = /gpt-4\.1/i.test(high.selected_model);
    if (!lowCheap || !highBetter) {
      failures.push({
        phase: "PHASE 4",
        title: "Priority-based model routing mismatch",
        severity: "high",
        evidence: `lowModel=${low.selected_model}, highModel=${high.selected_model}`,
        rootCause: "Routing tier thresholds/adaptive overrides did not maintain cheap-vs-premium separation.",
        exactFix: "Enforce hard tier floor/ceiling by priority+risk band and only allow adaptive override within tier family.",
      });
    }
  }

  if (
    !low || !high ||
    low.tokens_in == null || low.tokens_out == null ||
    high.tokens_in == null || high.tokens_out == null
  ) {
    failures.push({
      phase: "PHASE 4",
      title: "Token usage tracking missing",
      severity: "high",
      evidence: `lowTokensIn=${low?.tokens_in ?? "null"}, lowTokensOut=${low?.tokens_out ?? "null"}, highTokensIn=${high?.tokens_in ?? "null"}, highTokensOut=${high?.tokens_out ?? "null"}`,
      rootCause: "LLM metrics are not guaranteed to persist in non-happy-path branches.",
      exactFix: "Write tokens_in/tokens_out defaults in fallback branches and assert non-null metrics at end of generation stage.",
    });
  }
}

async function seedRagMemory(scope: { systemId: number; accountId: number }): Promise<{
  knownChunkId: number;
  conflictChunkIds: number[];
  emailIds: number[];
}> {
  const knownText = "Our Team plan costs $49 per seat monthly and includes SSO plus priority support.";
  const policyYes = "Refunds are allowed within 30 days for annual contracts.";
  const policyNo = "Refunds are not allowed after purchase under any condition.";

  const knownEmail = await insertEmailIfNotExists({
    systemId: scope.systemId,
    accountId: scope.accountId,
    gmailId: nowId("qa-sent-known"),
    traceId: nowId("trace"),
    threadId: nowId("thread-rag"),
    fromEmail: "agent@example.com",
    subject: "Pricing reference",
    body: knownText,
    snippet: knownText.slice(0, 120),
    internalDate: Date.now() - 1000,
    source: "sent",
    state: "SENT",
  });
  const conflictEmailA = await insertEmailIfNotExists({
    systemId: scope.systemId,
    accountId: scope.accountId,
    gmailId: nowId("qa-sent-conflict-a"),
    traceId: nowId("trace"),
    threadId: nowId("thread-conflict"),
    fromEmail: "agent@example.com",
    subject: "Refund policy",
    body: policyYes,
    snippet: policyYes.slice(0, 120),
    internalDate: Date.now() - 800,
    source: "sent",
    state: "SENT",
  });
  const conflictEmailB = await insertEmailIfNotExists({
    systemId: scope.systemId,
    accountId: scope.accountId,
    gmailId: nowId("qa-sent-conflict-b"),
    traceId: nowId("trace"),
    threadId: nowId("thread-conflict"),
    fromEmail: "agent@example.com",
    subject: "Refund policy",
    body: policyNo,
    snippet: policyNo.slice(0, 120),
    internalDate: Date.now() - 700,
    source: "sent",
    state: "SENT",
  });

  if (!knownEmail || !conflictEmailA || !conflictEmailB) {
    throw new Error("Failed to seed sent emails for RAG tests");
  }

  const knownEmb = await createQueryEmbedding("team plan pricing sso priority support monthly cost");
  const conflictEmb = await createQueryEmbedding("refund policy allowed not allowed annual contracts");

  await withRetry(() => insertEmbedding(knownEmail.id, knownText, knownEmb, "answer", "us", "pricing", knownEmail.thread_id, nowId("hash"), scope.accountId, scope.systemId));
  await withRetry(() => insertEmbedding(conflictEmailA.id, policyYes, conflictEmb, "answer", "us", "refund", conflictEmailA.thread_id, nowId("hash"), scope.accountId, scope.systemId));
  await withRetry(() => insertEmbedding(conflictEmailB.id, policyNo, conflictEmb, "answer", "us", "refund", conflictEmailB.thread_id, nowId("hash"), scope.accountId, scope.systemId));

  const inserted = await db.query<{ id: number; email_id: number; chunk_text: string }>(
    `SELECT id, email_id, chunk_text
     FROM email_embeddings
     WHERE email_id = ANY($1::int[])
     ORDER BY id ASC`,
    [[knownEmail.id, conflictEmailA.id, conflictEmailB.id]],
  );

  const knownChunk = inserted.rows.find((r) => r.email_id === knownEmail.id);
  const conflictChunks = inserted.rows.filter((r) => r.email_id !== knownEmail.id).map((r) => r.id);
  if (!knownChunk || conflictChunks.length < 2) throw new Error("Failed to read seeded chunk ids");

  return {
    knownChunkId: knownChunk.id,
    conflictChunkIds: conflictChunks,
    emailIds: [knownEmail.id, conflictEmailA.id, conflictEmailB.id],
  };
}

async function phaseRagValidation(scope: { systemId: number; accountId: number }, failures: Failure[]): Promise<{ knownChunkId: number; conflictChunkIds: number[] }> {
  const seeded = await seedRagMemory(scope);

  const known = await getRelevantContext(
    "Team plan pricing",
    "What is the monthly cost and does it include SSO support?",
    { accountId: scope.accountId, threadId: nowId("qa-thread") },
  );

  if (!known.items.length || !known.items.some((i) => /team plan costs \$49/i.test(i.answer))) {
    failures.push({
      phase: "PHASE 5",
      title: "Known-query RAG retrieval failed",
      severity: "high",
      evidence: `knownItems=${known.items.length}, diagnostics.confidence=${known.diagnostics.confidenceScore.toFixed(2)}`,
      rootCause: "Seeded relevant context was not retrieved/ranked into final context set.",
      exactFix: "Increase lexical-intent boost for pricing terms and guarantee at least one top semantic match survives post-filtering.",
    });
  }

  const unknown = await getRelevantContext(
    "xqzv alpha",
    "zzkqv nonsensical request no real context",
    { accountId: scope.accountId, threadId: nowId("qa-thread-unknown") },
  );
  if (unknown.items.length > 0) {
    failures.push({
      phase: "PHASE 5",
      title: "Unknown-query returned hallucinated context",
      severity: "critical",
      evidence: `unknownItems=${unknown.items.length}, first=${unknown.items[0]?.answer?.slice(0, 120) ?? "n/a"}`,
      rootCause: "Unknown-intent fallback did not suppress weak context.",
      exactFix: "For retrievalIntent=unknown, keep confidence gate strict and return empty context below threshold.",
    });
  }

  const conflicting = await getRelevantContext(
    "Refund policy",
    "Can annual contract customers get refunds?",
    { accountId: scope.accountId, threadId: nowId("qa-thread-conflict") },
  );

  if (hasConflictingPolarity(conflicting.items)) {
    failures.push({
      phase: "PHASE 5",
      title: "Conflicting context was not filtered",
      severity: "critical",
      evidence: `items=${conflicting.items.map((i) => i.answer.slice(0, 60)).join(" || ")}`,
      rootCause: "Conflict filter allowed opposite-polarity answers in final RAG context.",
      exactFix: "Run contradiction pruning before final top-k selection and reject polarity-mixed bundles.",
    });
  }

  return { knownChunkId: seeded.knownChunkId, conflictChunkIds: seeded.conflictChunkIds };
}

async function phaseFeedbackLoop(scope: { accountId: number }, seeds: { knownChunkId: number; conflictChunkIds: number[] }, failures: Failure[]): Promise<void> {
  await ensureChunkFeedbackTable();

  const fbEmailId = await insertInboundEmail({
    systemId: (await getDefaultSystemId()),
    accountId: scope.accountId,
    fromEmail: "feedback@example.com",
    subject: "Feedback loop",
    body: "Need final pricing confirmation",
  });

  await updateEmailRagContext(fbEmailId, [
    {
      chunk_id: seeds.knownChunkId,
      question: null,
      answer: "Our Team plan costs $49 per seat monthly and includes SSO plus priority support.",
      topic: "pricing",
      distance: 0.1,
      subject: "Pricing reference",
      email_id: 0,
      final_score: 1,
      embedding: [],
    },
  ]);

  await applyRagFeedbackForEmail(fbEmailId, "rejected");
  await applyRagFeedbackForEmail(fbEmailId, "regenerated");
  await applyRagFeedbackForEmail(fbEmailId, "accepted");

  const feedback = await db.query<{
    chunk_id: number;
    retrieved_count: number;
    used_count: number;
    helpful_count: number;
  }>(
    `SELECT chunk_id, retrieved_count, used_count, helpful_count
     FROM chunk_feedback
     WHERE chunk_id = $1`,
    [seeds.knownChunkId],
  );

  const row = feedback.rows[0];
  if (!row) {
    failures.push({
      phase: "PHASE 6",
      title: "Feedback loop did not persist chunk weights",
      severity: "high",
      evidence: `chunk_id=${seeds.knownChunkId} has no chunk_feedback row`,
      rootCause: "RAG feedback application path failed to upsert chunk_feedback.",
      exactFix: "Ensure applyRagFeedbackForEmail always upserts chunk_feedback and logs DB errors explicitly.",
    });
    return;
  }

  if (row.helpful_count < 1 || row.used_count < 3) {
    failures.push({
      phase: "PHASE 6",
      title: "Feedback loop counters incomplete",
      severity: "high",
      evidence: `chunk=${row.chunk_id}, retrieved=${row.retrieved_count}, used=${row.used_count}, helpful=${row.helpful_count}`,
      rootCause: "Reject/regenerate/accept sequence is not fully reflected in weight counters.",
      exactFix: "Map each outcome to deterministic deltas and enforce via transactionally consistent updates.",
    });
  }

  const beforeRank = await getRelevantContext(
    "Pricing",
    "What is team plan monthly pricing?",
    { accountId: scope.accountId, threadId: nowId("fb-thread-a") },
  );

  await updateEmailRagContext(fbEmailId, [
    {
      chunk_id: seeds.conflictChunkIds[0] ?? seeds.knownChunkId,
      question: null,
      answer: "Noise chunk",
      topic: "misc",
      distance: 0.2,
      subject: "Misc",
      email_id: 0,
      final_score: 0.4,
      embedding: [],
    },
  ]);
  await applyRagFeedbackForEmail(fbEmailId, "accepted");

  const afterRank = await getRelevantContext(
    "Pricing",
    "What is team plan monthly pricing?",
    { accountId: scope.accountId, threadId: nowId("fb-thread-b") },
  );

  if (!beforeRank.items.length || !afterRank.items.length) {
    failures.push({
      phase: "PHASE 6",
      title: "Feedback loop could not demonstrate ranking impact",
      severity: "minor",
      evidence: `beforeItems=${beforeRank.items.length}, afterItems=${afterRank.items.length}`,
      rootCause: "Insufficient stable retrieval signal to compare pre/post ranking impact.",
      exactFix: "Add deterministic QA seed corpus and force deterministic query embedding in validation environments.",
    });
  }
}

async function main(): Promise<void> {
  await db.query("SET statement_timeout TO 0");
  await db.query("SET lock_timeout TO 0");
  await initDbSchema();
  const failures: Failure[] = [];
  const config = await getConfig();
  const scope = await mustGetDefaultScope();

  console.log("[QA] Starting breaker run", {
    systemId: scope.systemId,
    accountId: scope.accountId,
    globalMode: config.global_mode,
    sendMode: config.send_mode,
    threshold: config.threshold,
  });

  await phaseCoreFlow(scope, failures);
  await phaseSafetyStress(scope, failures);
  await phaseConcurrency(scope, failures);
  await phaseCostModelRouting(scope, failures);
  const seeds = await phaseRagValidation(scope, failures);
  await phaseFeedbackLoop(scope, seeds, failures);

  const report = {
    executedAt: new Date().toISOString(),
    failures,
    failureCount: failures.length,
    passed: failures.length === 0,
  };

  console.log("\n=== QA_BREAKER_REPORT_START ===");
  console.log(JSON.stringify(report, null, 2));
  console.log("=== QA_BREAKER_REPORT_END ===");

  if (failures.length > 0) {
    process.exitCode = 2;
  }
}

void main().catch((error) => {
  console.error("[QA] Fatal runner error", error);
  process.exit(1);
});
