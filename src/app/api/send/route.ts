import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "../../../db/client";
import { getDraftById } from "../../../db/drafts";
import { getConfig } from "../../../db/config";
import { getEmailById } from "../../../db/emails";
import { getIdempotentResponse, saveIdempotentResponse } from "../../../db/idempotency";
import { processEmailById } from "../../../core/processor";
import { runSafetyChecks } from "../../../core/safety";
import { logStep } from "../../../utils/logger";
import { logSlowApi } from "../../../utils/api";
import { withTimeout } from "../../../utils/withTimeout";
import { apiError } from "../../../lib/apiError";
import { withApiRoute } from "../../../lib/routeErrorHandler";

const sendSchema = z.object({
  draftId: z.number().int().positive(),
});

async function POSTHandler(request: NextRequest) {
  const start = Date.now();
  try {
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
    const payload = await request.json();
    const parsed = sendSchema.safeParse(payload);

    if (!parsed.success) {
      return NextResponse.json(
        apiError("INVALID_SEND_REQUEST", "invalid_payload", "Provide a valid draft id."),
        { status: 400 },
      );
    }

    const draft = await getDraftById(parsed.data.draftId);
    if (!draft) {
      return NextResponse.json(apiError("DRAFT_NOT_FOUND", "not_found", "Refresh and select a valid draft."), { status: 404 });
    }

    const email = await getEmailById(draft.email_id);
    if (!email) {
      return NextResponse.json(apiError("EMAIL_NOT_FOUND", "not_found", "Refresh inbox and retry."), { status: 404 });
    }

    if (idempotencyKey) {
      const existing = await getIdempotentResponse(email.id, "send-queue", idempotencyKey);
      if (existing) {
        return NextResponse.json(existing.response_json, { status: existing.status_code });
      }
    }

    if (!email.from_email) {
      return NextResponse.json(apiError("RECIPIENT_MISSING", "missing_recipient", "Open email details and verify sender/recipient mapping."), { status: 400 });
    }

    if (draft.status !== "approved") {
      return NextResponse.json(apiError("DRAFT_NOT_APPROVED", "approval_required", "Approve the draft before sending."), { status: 400 });
    }

    const config = await getConfig();

    const outgoingBody = draft.edited_body ?? draft.reply;
    const safety = runSafetyChecks(outgoingBody);
    if (!safety.ok) {
      return NextResponse.json(
        apiError("SAFETY_CHECK_FAILED", safety.reasons.join(","), "Edit draft content to satisfy safety checks."),
        { status: 400 },
      );
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const casRes = await client.query<{ id: number }>(
        `UPDATE emails
         SET state = 'READY_TO_SEND',
             ready_to_send_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND state = 'AWAITING_REVIEW'
         RETURNING id`,
        [email.id],
      );
      if (!casRes.rows[0] && email.state !== "READY_TO_SEND") {
        await client.query("ROLLBACK").catch(() => {});
        return NextResponse.json(
          apiError("CAS_ABORT_AWAITING_REVIEW_TO_READY_TO_SEND", "state_mismatch", "Email state changed; refresh and retry."),
          { status: 409 },
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await logStep({
      trace_id: email.trace_id ?? "unknown",
      gmail_id: email.gmail_id,
      step: "send_queued",
      state: "READY_TO_SEND",
      latency_ms: 0,
    });

    let syncFallback: {
      attempted: boolean;
      completed: boolean;
      final_state: string | null;
      error: string | null;
    } = {
      attempted: true,
      completed: false,
      final_state: email.state,
      error: null,
    };

    try {
      await withTimeout(processEmailById(email.id), 12_000);
      const refreshed = await getEmailById(email.id);
      syncFallback = {
        attempted: true,
        completed: true,
        final_state: refreshed?.state ?? null,
        error: null,
      };
    } catch (err) {
      const refreshed = await getEmailById(email.id);
      syncFallback = {
        attempted: true,
        completed: false,
        final_state: refreshed?.state ?? null,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const payloadOut = {
      status: "queued",
      emailId: email.id,
      send_mode: config.send_mode,
      sync_fallback: syncFallback,
    };

    if (idempotencyKey) {
      await saveIdempotentResponse(email.id, "send-queue", idempotencyKey, 200, payloadOut).catch(() => {});
    }

    const response = NextResponse.json(payloadOut);
    logSlowApi("/api/send", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "SEND_QUEUE_FAILED",
        err instanceof Error ? err.message : "processing_deferred",
        "Retry send action. If it fails again, check draft status and run diagnostics.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/send", start);
    return response;
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/send', operation: 'POST' });
