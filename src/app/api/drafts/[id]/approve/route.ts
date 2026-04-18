import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { approveDraft, getDraftById } from "../../../../../db/drafts";
import { getIdempotentResponse, saveIdempotentResponse } from "../../../../../db/idempotency";
import { getEmailById, markReadyToSend } from "../../../../../db/emails";
import { apiError } from "../../../../../lib/apiError";
import { logSlowApi } from "../../../../../utils/api";
import { logStep } from "../../../../../utils/logger";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";

const bodySchema = z.object({
  edited_body: z.string().min(1).optional(),
});

async function POSTHandler(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const start = Date.now();
  try {
    const { id } = await context.params;
    const draftId = Number(id);
    if (!Number.isFinite(draftId) || draftId <= 0) {
      return NextResponse.json(
        apiError("INVALID_DRAFT_ID", "invalid_id", "Use a valid numeric draft id."),
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        apiError("INVALID_APPROVE_REQUEST", "invalid_payload", "Provide a valid edited_body if present."),
        { status: 400 },
      );
    }

    const draft = await getDraftById(draftId);
    if (!draft) {
      return NextResponse.json(
        apiError("DRAFT_NOT_FOUND", "not_found", "Refresh and select a valid draft."),
        { status: 404 },
      );
    }

    const email = await getEmailById(draft.email_id);
    if (!email) {
      return NextResponse.json(
        apiError("EMAIL_NOT_FOUND", "not_found", "Refresh inbox and retry."),
        { status: 404 },
      );
    }

    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
    if (idempotencyKey) {
      const existing = await getIdempotentResponse(email.id, "approve-draft", idempotencyKey);
      if (existing) {
        return NextResponse.json(existing.response_json, { status: existing.status_code });
      }
    }

    if (email.review_outcome === "rejected") {
      return NextResponse.json(
        apiError("EMAIL_REJECTED", "review_rejected", "Regenerate a draft before approving."),
        { status: 409 },
      );
    }

    if (email.state !== "AWAITING_REVIEW") {
      return NextResponse.json(
        apiError("INVALID_EMAIL_STATE", "not_awaiting_review", "Email must be awaiting review before approval."),
        { status: 409 },
      );
    }

    await approveDraft(draftId, parsed.data.edited_body);
    await markReadyToSend(email.id);

    await logStep({
      trace_id: email.trace_id ?? "unknown",
      gmail_id: email.gmail_id,
      step: "approve_draft",
      state: "READY_TO_SEND",
      latency_ms: 0,
    });

    const responsePayload = { ok: true };
    if (idempotencyKey) {
      await saveIdempotentResponse(email.id, "approve-draft", idempotencyKey, 200, responsePayload).catch(() => {});
    }

    const response = NextResponse.json(responsePayload);
    logSlowApi("/api/drafts/:id/approve", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "APPROVE_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry approval. If it keeps failing, refresh and verify draft state.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/drafts/:id/approve", start);
    return response;
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/drafts/[id]/approve', operation: 'POST' });
