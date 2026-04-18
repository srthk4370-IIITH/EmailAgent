import { NextResponse } from "next/server";

import { getEmailById, markReadyToGenerate, markReadyToSend, setManualGenerateRequested } from "../../../../../db/emails";
import { getDraftByEmailId, approveDraft } from "../../../../../db/drafts";
import { getIdempotentResponse, saveIdempotentResponse } from "../../../../../db/idempotency";
import { apiError } from "../../../../../lib/apiError";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";

async function POSTHandler(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const emailId = Number(id);
    if (!Number.isFinite(emailId) || emailId <= 0) {
      return NextResponse.json(apiError("INVALID_EMAIL_ID", "invalid_id", "Use a valid numeric email id."), { status: 400 });
    }

    const email = await getEmailById(emailId);
    if (!email) {
      return NextResponse.json(apiError("EMAIL_NOT_FOUND", "not_found", "Refresh inbox and retry."), { status: 404 });
    }

    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
    if (idempotencyKey) {
      const existing = await getIdempotentResponse(email.id, "auto-send", idempotencyKey);
      if (existing) {
        return NextResponse.json(existing.response_json, { status: existing.status_code });
      }
    }

    if (email.state === "AWAITING_REVIEW") {
      const draft = await getDraftByEmailId(email.id);
      if (!draft) {
        return NextResponse.json(apiError("DRAFT_REQUIRED", "missing_draft", "Generate a draft before auto-send."), { status: 400 });
      }
      await approveDraft(draft.id);
      await markReadyToSend(email.id);
      const payload = { status: "queued_send", emailId: email.id };
      if (idempotencyKey) {
        await saveIdempotentResponse(email.id, "auto-send", idempotencyKey, 200, payload).catch(() => {});
      }
      return NextResponse.json(payload);
    }

    if (email.state === "READY_TO_GENERATE") {
      await markReadyToGenerate(email.id, "auto");
      await setManualGenerateRequested(email.id, true);
      const payload = { status: "queued_generation", emailId: email.id };
      if (idempotencyKey) {
        await saveIdempotentResponse(email.id, "auto-send", idempotencyKey, 200, payload).catch(() => {});
      }
      return NextResponse.json(payload);
    }

    if (email.state === "READY_TO_SEND") {
      const payload = { status: "already_ready", emailId: email.id };
      if (idempotencyKey) {
        await saveIdempotentResponse(email.id, "auto-send", idempotencyKey, 200, payload).catch(() => {});
      }
      return NextResponse.json(payload);
    }

    return NextResponse.json(
      apiError("AUTO_SEND_NOT_ALLOWED", `state_${email.state.toLowerCase()}`, "This email is not in an auto-send eligible state."),
      { status: 409 },
    );
  } catch (err) {
    return NextResponse.json(
      apiError(
        "AUTO_SEND_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry auto-send, or fall back to approve/send from AI workspace.",
      ),
      { status: 500 },
    );
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/emails/[id]/auto-send', operation: 'POST' });
