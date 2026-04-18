import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "../../../../db/client";
import { getEmbeddingCountForEmail } from "../../../../db/emails";
import { getEmailById } from "../../../../db/emails";
import { listLogsByTraceId } from "../../../../db/logs";
import { getThreadMessages } from "../../../../db/threads";
import { logSlowApi } from "../../../../utils/api";
import { withTimeout } from "../../../../utils/withTimeout";
import type { EmailRecord } from "../../../../db/emails";
import { apiError } from "../../../../lib/apiError";
import { assessThreadToneConsistency } from "../../../../core/toneSignature";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

const paramsSchema = z.object({ id: z.string().regex(/^\d+$/) });

async function GETHandler(_request: Request, context: { params: Promise<{ id: string }> }) {
  const start = Date.now();
  try {
    const { id } = await context.params;
    const parsed = paramsSchema.safeParse({ id });
    if (!parsed.success) {
      return NextResponse.json(
        apiError("INVALID_EMAIL_ID", "invalid_id", "Use a numeric email id."),
        { status: 400 },
      );
    }

    const emailId = Number(parsed.data.id);

    const email = await withTimeout(getEmailById(emailId), 10_000);
    if (!email) {
      return NextResponse.json(
        apiError("EMAIL_NOT_FOUND", "not_found", "Refresh list and retry."),
        { status: 404 },
      );
    }

    const draftResult = await withTimeout(
      db.query(
        "SELECT id, reply, edited_body, status, is_fallback FROM drafts WHERE email_id = $1 ORDER BY id DESC LIMIT 1",
        [emailId],
      ),
      10_000,
    );

    const draftRow = draftResult.rows[0] as
      | { id: number; reply: string; edited_body: string | null; status: string; is_fallback: boolean }
      | undefined;

    const logs =
      email.trace_id != null && email.trace_id !== ""
        ? await withTimeout(listLogsByTraceId(email.trace_id), 10_000)
        : [];

    const threadMessages = email.thread_id
      ? await withTimeout(getThreadMessages(email.thread_id, 20, email.account_id ?? undefined), 10_000)
      : [];
    const embeddingChunkCount = await withTimeout(getEmbeddingCountForEmail(emailId), 10_000);

    const e = email as EmailRecord;
    const parsedContent =
      e.parsed_content && typeof e.parsed_content === "object" && !Array.isArray(e.parsed_content)
        ? (e.parsed_content as Record<string, unknown>)
        : null;
    const parsedFrom = typeof parsedContent?.from === "string" ? parsedContent.from.trim() : "";
    const safeFrom = (e.from_email ?? "").trim() || parsedFrom || "Unknown sender";
    const currentThreadMessage = {
      from: safeFrom,
      internal_date: typeof e.internal_date === "number" && Number.isFinite(e.internal_date) ? e.internal_date : null,
      body: e.body,
      subject: e.subject,
      snippet: e.snippet,
    };
    const mergedThreadMessages = [...threadMessages, currentThreadMessage].filter((message, index, all) => {
      const record = message as { from?: string; internal_date?: number | null; body?: string; subject?: string };
      const key = `${record.from ?? ""}\n${record.subject ?? ""}\n${record.body ?? ""}\n${record.internal_date ?? "null"}`;
      return all.findIndex((candidate) => {
        const other = candidate as { from?: string; internal_date?: number | null; body?: string; subject?: string };
        return `${other.from ?? ""}\n${other.subject ?? ""}\n${other.body ?? ""}\n${other.internal_date ?? "null"}` === key;
      }) === index;
    });
    const ragContext = Array.isArray(e.rag_context) ? e.rag_context : [];
    const ragConfidence = typeof e.rag_confidence === "number" ? e.rag_confidence : ragContext.length === 0 ? 0 : Number((ragContext[0] as any)?.distance ?? 1) < 0.6 ? 0.75 : 0.4;
    const ragStrength = ragConfidence <= 0.05 ? "none" : ragConfidence >= 0.65 ? "strong" : "weak";
    const riskScore = typeof e.risk_score === "number" ? e.risk_score : (e.state || "").startsWith("ERROR") ? 0.9 : Math.max(0, 1 - (e.confidence ?? 0.6));
    const riskLevel = riskScore >= 0.72 ? "high" : riskScore >= 0.45 ? "medium" : "low";
    const toneConsistency = assessThreadToneConsistency(
      threadMessages
        .map((m) => (typeof m === "object" && m && "body" in (m as object) ? String((m as { body?: unknown }).body ?? "") : ""))
        .filter(Boolean),
      draftRow?.edited_body ?? draftRow?.reply ?? e.reply ?? undefined,
    );
    const nextBestAction =
      e.state === "READY_TO_GENERATE"
        ? "regenerate"
        : e.state === "GENERATED" || e.state === "AWAITING_REVIEW"
        ? "edit"
        : e.state === "READY_TO_SEND"
        ? "send"
        : "inspect";

    const response = NextResponse.json({
      id: e.id,
      source: e.source,
      subject: e.subject,
      state: e.state,
      category: e.category,
      confidence: e.confidence,
      risk_score: riskScore,
      risk_level: riskLevel,
      rag_strength: ragStrength,
      rag_confidence: ragConfidence,
      rag_conflict_detected: Boolean(e.rag_conflict_detected),
      tone_consistency: toneConsistency,
      decision: e.decision,
      decision_reason: e.decision_reason ?? null,
      selected_model: e.selected_model ?? null,
      style_confidence: e.style_confidence ?? null,
      clarification_mode: Boolean(e.clarification_mode),
      priority_score: e.priority_score ?? null,
      cost_score: e.cost_score ?? null,
      cost_estimate_tokens: e.cost_estimate_tokens ?? null,
      edited_count: e.edited_count ?? 0,
      rejected_count: e.rejected_count ?? 0,
      regenerated_count: e.regenerated_count ?? 0,
      accepted_count: e.accepted_count ?? 0,
      risk_reasons: Array.isArray(e.risk_reasons) ? e.risk_reasons : [],
      next_best_action: nextBestAction,
      rag_context: e.rag_context,
      draft: draftRow
        ? {
            status: draftRow.status,
            generated_body: draftRow.reply,
            edited_body: draftRow.edited_body,
            id: draftRow.id,
            is_fallback: draftRow.is_fallback,
          }
        : null,
      thread_messages: mergedThreadMessages,
      trace_id: e.trace_id,
      last_error: e.last_error,
      last_step: e.last_step,
      body: e.body,
      gmail_id: e.gmail_id,
      raw_email: {
        subject: e.subject,
        from: safeFrom,
        body: e.body,
        snippet: e.snippet,
        internal_date: e.internal_date,
        thread_id: e.thread_id,
      },
      parsed_content: e.parsed_content,
      classification_output: e.classification_output,
      reply: e.reply,
      retry_count: e.retry_count,
      embedding_status: e.embedding_status,
      is_seen: e.is_seen,
      embedding_error: e.embedding_error ?? null,
      embedding_chunk_count: embeddingChunkCount,
      llm: {
        prompt_version: e.prompt_version,
        tokens_in: e.tokens_in,
        tokens_out: e.tokens_out,
        latency_ms: e.llm_latency_ms,
      },
      logs,
      review_outcome: e.review_outcome ?? null,
    });
    logSlowApi("/api/emails/:id", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "EMAIL_DETAIL_FAILED",
        err instanceof Error ? err.message : "processing_deferred",
        "Retry detail fetch. If this continues, inspect logs by trace id and run diagnostics.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/emails/:id", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/emails/[id]', operation: 'GET' });
