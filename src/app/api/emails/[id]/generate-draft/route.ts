import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "../../../../../db/client";
import { getIdempotentResponse, saveIdempotentResponse } from "../../../../../db/idempotency";
import { getThreadMessages } from "../../../../../db/threads";
import {
  getEmailById,
  incrementEmailFeedbackCounter,
  updateEmailIntelligence,
  updateEmailLlmMetrics,
} from "../../../../../db/emails";
import { getRelevantContext } from "../../../../../core/rag";
import { generateReply } from "../../../../../core/generator";
import { calculateAndSaveTrace } from "../../../../../core/ragObserver";
import { applyRagFeedbackForEmail, recordRagRetrievalForEmail } from "../../../../../db/embeddings";
import type { StructuredContextItem } from "../../../../../core/ragRanker";
import { getEmailAccountById } from "../../../../../db/emailAccounts";
import { chooseAdaptiveModel } from "../../../../../core/modelLearning";
import { modelForTask, selectModelTier } from "../../../../../core/modelRouter";

import { runSafetyChecks } from "../../../../../core/safety";
import { sanitizeStoredEmailText } from "../../../../../utils/sanitizeEmail";
import { logSlowApi } from "../../../../../utils/api";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";

const paramsSchema = z.object({
  id: z.string().regex(/^\d+$/),
});

async function POSTHandler(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const start = Date.now();
  try {
    const { id } = await context.params;
    const parsedId = paramsSchema.safeParse({ id });
    if (!parsedId.success) {
      return NextResponse.json({ error: "Invalid email id" }, { status: 400 });
    }
    const emailId = Number(parsedId.data.id);

    const email = await getEmailById(emailId);
    if (!email) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
    if (idempotencyKey) {
      const existing = await getIdempotentResponse(emailId, "generate-draft", idempotencyKey);
      if (existing) {
        return NextResponse.json(existing.response_json, { status: existing.status_code });
      }
    }
    if (email.state !== "READY_TO_GENERATE") {
      return NextResponse.json({ error: "Email is not ready for draft generation" }, { status: 400 });
    }

    console.log("[generate-draft] route hit", { emailId });
    if (email.decision !== "manual") {
      return NextResponse.json({ error: "Generate draft requires manual decision" }, { status: 400 });
    }

    // Guarantee fallback content even if the LLM fails.
    let content: string | null = null;
    let llmMetrics: { tokensIn: number; tokensOut: number; latencyMs: number; promptVersion: string } | null = null;
    let usedFallback = false;
    let ragContext: StructuredContextItem[] = [];
    let ragTraceBuilder: any = null;
    let selectedModel: string | null = null;
    const fallback = sanitizeStoredEmailText(`
Hi,

Thanks for your email. I'll review this and get back to you shortly.

Best regards,
`);

    try {
      console.log("[generate-draft] Step 1: fetching email context");
      const ragOptions = {
        emailId,
        ...(email.trace_id ? { traceId: email.trace_id } : {}),
        ...(email.account_id ? { accountId: email.account_id } : {}),
        ...(email.thread_id ? { threadId: email.thread_id } : {}),
      };
      const [ragResponse, threadMessages] = await Promise.all([
        getRelevantContext(email.subject, email.body, ragOptions).catch(() => ({
          items: [] as StructuredContextItem[],
          builder: null,
          diagnostics: {
            confidenceScore: 0,
            conflictDetected: false,
            staleFilteredCount: 0,
            retrievalIntent: "unknown" as const,
          },
        })),
        getThreadMessages(email.thread_id, 5, email.account_id ?? undefined).catch(() => []),
      ]);
      ragContext = ragResponse.items;
      ragTraceBuilder = ragResponse.builder;
      await recordRagRetrievalForEmail(emailId).catch(() => {});



      console.log("[generate-draft] Step 2: generating draft content");
      const account = email.account_id ? await getEmailAccountById(email.account_id) : null;
      const generationTier = selectModelTier({
        priorityScore: email.priority_score ?? 0.5,
        riskScore: email.risk_score ?? 0,
        costScore: email.cost_score ?? 0,
      });
      selectedModel = await chooseAdaptiveModel(
        "generation",
        generationTier,
        modelForTask("generation", generationTier),
      );

      await updateEmailIntelligence(emailId, {
        selectedModel,
        clarificationMode: false,
      }).catch(() => {});

      const generation = await generateReply(email, ragContext, threadMessages, {
        displayName: account?.email_address ?? null,
        email: account?.email_address ?? null,
      }, selectedModel ?? undefined, account?.user_id ?? null);
      const candidate = (generation.reply ?? "").trim();
      if (candidate) {
        content = candidate;
        usedFallback = Boolean(generation.isFallback);
        llmMetrics = {
          tokensIn: generation.tokensIn,
          tokensOut: generation.tokensOut,
          latencyMs: generation.latencyMs,
          promptVersion: generation.promptVersion,
        };
      }
    } catch (err) {
      console.error("[generate-draft] AI failed, using fallback", err);
    }

    if (!content || content.trim() === "") {
      console.log("[generate-draft] Using fallback draft");
      content = fallback;
      usedFallback = true;
    }

    content = sanitizeStoredEmailText(content);

    console.log("[generate-draft] Step 3: saving draft");
    const safety = runSafetyChecks(content);
    await incrementEmailFeedbackCounter(emailId, "regenerated_count").catch(() => {});
    await applyRagFeedbackForEmail(emailId, "regenerated").catch(() => {});

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        "UPDATE emails SET state = 'GENERATED', reply = $1, last_step = 'generate', updated_at = NOW() WHERE id = $2",
        [content, emailId],
      );

      await client.query(
        `
        INSERT INTO drafts (email_id, reply, edited_body, status, is_fallback, updated_at)
        VALUES ($1, $2, NULL, 'pending', $3, NOW())
        ON CONFLICT (email_id) DO UPDATE SET
          reply = CASE WHEN drafts.status = 'approved' THEN drafts.reply ELSE EXCLUDED.reply END,
          edited_body = CASE WHEN drafts.status = 'approved' THEN drafts.edited_body ELSE NULL END,
          status = CASE WHEN drafts.status = 'approved' THEN 'approved' ELSE 'pending' END,
          is_fallback = CASE WHEN drafts.status = 'approved' THEN drafts.is_fallback ELSE EXCLUDED.is_fallback END,
          updated_at = NOW()
        `,
        [emailId, content, usedFallback],
      );

      await client.query(
        "UPDATE emails SET state = 'AWAITING_REVIEW', review_outcome = NULL, updated_at = NOW() WHERE id = $1",
        [emailId],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (llmMetrics && ragTraceBuilder) {
      await updateEmailLlmMetrics(emailId, llmMetrics).catch(() => {});
      await calculateAndSaveTrace(
        content,
        { subject: email.subject, body: email.body },
        ragContext,
        ragTraceBuilder,
        emailId
      );
    } else if (llmMetrics) {
      await updateEmailLlmMetrics(emailId, llmMetrics).catch(() => {});
    } else {
      // Keep metrics fields sane even when we used fallback.
      await updateEmailLlmMetrics(emailId, {
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        promptVersion: "manual_fallback",
      }).catch(() => {});
    }

    logSlowApi("/api/emails/:id/generate-draft", start);
    const payload = {
      ok: true,
      emailId,
      draft: {
        status: "pending",
        safety_ok: safety.ok,
        content,
      },
    };

    if (idempotencyKey) {
      await saveIdempotentResponse(emailId, "generate-draft", idempotencyKey, 200, payload).catch(() => {});
    }

    return NextResponse.json(payload);
  } catch {
    const response = NextResponse.json({ error: "Request failed" }, { status: 500 });
    logSlowApi("/api/emails/:id/generate-draft", start);
    return response;
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/emails/[id]/generate-draft', operation: 'POST' });
