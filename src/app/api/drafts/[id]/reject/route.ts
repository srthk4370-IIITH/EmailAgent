import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "../../../../../db/client";
import { getDraftById } from "../../../../../db/drafts";
import { getIdempotentResponse, saveIdempotentResponse } from "../../../../../db/idempotency";
import { getEmailById, incrementEmailFeedbackCounter } from "../../../../../db/emails";
import { applyRagFeedbackForEmail } from "../../../../../db/embeddings";
import { logSlowApi } from "../../../../../utils/api";
import { logStep } from "../../../../../utils/logger";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";

const paramsSchema = z.object({ id: z.string().regex(/^\d+$/) });

async function POSTHandler(request: Request, context: { params: Promise<{ id: string }> }) {
  const start = Date.now();
  try {
    const { id } = await context.params;
    const parsed = paramsSchema.safeParse({ id });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid draft id" }, { status: 400 });
    }

    const draftId = Number(parsed.data.id);
    const draft = await getDraftById(draftId);
    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
    if (idempotencyKey) {
      const existing = await getIdempotentResponse(draft.email_id, "reject-draft", idempotencyKey);
      if (existing) {
        return NextResponse.json(existing.response_json, { status: existing.status_code });
      }
    }

    const emailId = draft.email_id;
    const existing = await getEmailById(emailId);
    if (
      existing?.review_outcome === "rejected" &&
      existing?.decision === "manual" &&
      existing?.state === "READY_TO_GENERATE"
    ) {
      return NextResponse.json({ ok: true, already_rejected: true });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM drafts WHERE email_id = $1", [emailId]);
      await client.query(
        `UPDATE emails
         SET state = 'READY_TO_GENERATE',
             reply = NULL,
             last_step = 'draft_rejected',
             decision = 'manual',
             manual_generate_requested = false,
             review_outcome = 'rejected',
             ready_to_send_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [emailId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const email = await getEmailById(emailId);
    await incrementEmailFeedbackCounter(emailId, "rejected_count").catch(() => {});
    await applyRagFeedbackForEmail(emailId, "rejected").catch(() => {});
    if (email) {
      await logStep({
        trace_id: email.trace_id ?? "unknown",
        gmail_id: email.gmail_id,
        step: "reject_draft",
        state: email.state,
        latency_ms: 0,
      });
    }
    const payload = { ok: true };
    if (idempotencyKey) {
      await saveIdempotentResponse(emailId, "reject-draft", idempotencyKey, 200, payload).catch(() => {});
    }

    const response = NextResponse.json(payload);
    logSlowApi("/api/drafts/:id/reject", start);
    return response;
  } catch {
    const response = NextResponse.json({ error: "Request failed" }, { status: 500 });
    logSlowApi("/api/drafts/:id/reject", start);
    return response;
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/drafts/[id]/reject', operation: 'POST' });
