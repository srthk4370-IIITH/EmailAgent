import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDraftById, updateDraftEditedBody } from "../../../../db/drafts";
import { getIdempotentResponse, saveIdempotentResponse } from "../../../../db/idempotency";
import { incrementEmailFeedbackCounter } from "../../../../db/emails";
import { applyRagFeedbackForEmail } from "../../../../db/embeddings";
import { apiError } from "../../../../lib/apiError";
import { logSlowApi } from "../../../../utils/api";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

const patchSchema = z.object({
  edited_body: z.string().min(1).max(100_000),
});

async function PATCHHandler(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const start = Date.now();
  try {
    const { id } = await context.params;
    const draftId = Number(id);
    if (!Number.isFinite(draftId) || draftId <= 0) {
      return NextResponse.json({ error: "Invalid draft id" }, { status: 400 });
    }

    const raw = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const draft = await getDraftById(draftId);
    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
    if (idempotencyKey) {
      const existing = await getIdempotentResponse(draft.email_id, "draft-edit", idempotencyKey);
      if (existing) {
        return NextResponse.json(existing.response_json, { status: existing.status_code });
      }
    }

    if (draft.status !== "pending") {
      return NextResponse.json({ error: "Only pending drafts can be edited" }, { status: 400 });
    }

    await updateDraftEditedBody(draftId, parsed.data.edited_body);
    await incrementEmailFeedbackCounter(draft.email_id, "edited_count").catch(() => {});
    await applyRagFeedbackForEmail(draft.email_id, "edited").catch(() => {});
    const payload = { ok: true };
    if (idempotencyKey) {
      await saveIdempotentResponse(draft.email_id, "draft-edit", idempotencyKey, 200, payload).catch(() => {});
    }

    const response = NextResponse.json(payload);
    logSlowApi("/api/drafts/:id PATCH", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "DRAFT_EDIT_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry draft edit. If it persists, refresh draft and retry.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/drafts/:id PATCH", start);
    return response;
  }
}


export const PATCH = withApiRoute(PATCHHandler, { route: '/drafts/[id]', operation: 'PATCH' });
