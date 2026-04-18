import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "../../../../../db/client";
import { getConfig } from "../../../../../db/config";
import { saveIdempotentResponse } from "../../../../../db/idempotency";
import { runSafetyChecks } from "../../../../../core/safety";
import { apiError } from "../../../../../lib/apiError";
import { logSlowApi } from "../../../../../utils/api";
import { logStep } from "../../../../../utils/logger";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";

const paramsSchema = z.object({ id: z.string().regex(/^\d+$/) });
const bodySchema = z.object({
  edited_body: z.string().min(1).optional(),
});

async function POSTHandler(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const start = Date.now();

  try {
    const { id } = await context.params;
    const parsedParams = paramsSchema.safeParse({ id });
    if (!parsedParams.success) {
      return NextResponse.json(
        apiError("INVALID_DRAFT_ID", "invalid_id", "Use a valid numeric draft id."),
        { status: 400 },
      );
    }

    const payload = await request.json().catch(() => ({}));
    const parsedBody = bodySchema.safeParse(payload);
    if (!parsedBody.success) {
      return NextResponse.json(
        apiError("INVALID_APPROVE_SEND_REQUEST", "invalid_payload", "Provide a valid edited_body if present."),
        { status: 400 },
      );
    }

    const draftId = Number(parsedParams.data.id);

    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
    const client = await db.connect();

    try {
      await client.query("BEGIN");

      const draftRes = await client.query<{
        id: number;
        email_id: number;
        reply: string;
        edited_body: string | null;
        status: string;
      }>(
        "SELECT id, email_id, reply, edited_body, status FROM drafts WHERE id = $1 FOR UPDATE",
        [draftId],
      );
      const draft = draftRes.rows[0];
      if (!draft) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          apiError("DRAFT_NOT_FOUND", "not_found", "Refresh and select a valid draft."),
          { status: 404 },
        );
      }

      const emailRes = await client.query<{
        id: number;
        trace_id: string | null;
        gmail_id: string;
        state: string;
        review_outcome: string | null;
      }>(
        "SELECT id, trace_id, gmail_id, state, review_outcome FROM emails WHERE id = $1 FOR UPDATE",
        [draft.email_id],
      );
      const email = emailRes.rows[0];
      if (!email) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          apiError("EMAIL_NOT_FOUND", "not_found", "Refresh inbox and retry."),
          { status: 404 },
        );
      }

      if (idempotencyKey) {
        const idemRes = await client.query<{ status_code: number; response_json: unknown }>(
          `SELECT status_code, response_json
           FROM action_idempotency
           WHERE email_id = $1 AND action = 'approve-send' AND idempotency_key = $2
           LIMIT 1`,
          [email.id, idempotencyKey],
        );
        const existing = idemRes.rows[0];
        if (existing) {
          await client.query("ROLLBACK");
          return NextResponse.json(existing.response_json, { status: existing.status_code });
        }
      }

      if (email.review_outcome === "rejected") {
        await client.query("ROLLBACK");
        return NextResponse.json(
          apiError("EMAIL_REJECTED", "review_rejected", "Regenerate a draft before approving and sending."),
          { status: 409 },
        );
      }

      if (email.state !== "AWAITING_REVIEW" && email.state !== "READY_TO_SEND") {
        await client.query("ROLLBACK");
        return NextResponse.json(
          apiError("INVALID_EMAIL_STATE", "not_awaiting_review", "Email must be awaiting review before approve-and-send."),
          { status: 409 },
        );
      }

      const editedBody = parsedBody.data.edited_body?.trim();
      const finalBody = (editedBody && editedBody.length > 0 ? editedBody : draft.edited_body ?? draft.reply).trim();
      const safety = runSafetyChecks(finalBody);
      if (!safety.ok) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          apiError("SAFETY_CHECK_FAILED", safety.reasons.join(","), "Edit draft content to satisfy safety checks."),
          { status: 400 },
        );
      }

      await client.query(
        "UPDATE drafts SET status = 'approved', edited_body = $2, updated_at = NOW() WHERE id = $1",
        [draft.id, editedBody ?? draft.edited_body],
      );

      const casRes = await client.query<{ id: number }>(
        `UPDATE emails
         SET state = 'READY_TO_SEND',
             last_step = 'approve_draft',
             review_outcome = NULL,
             ready_to_send_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND state = 'AWAITING_REVIEW'
         RETURNING id`,
        [email.id],
      );

      if (!casRes.rows[0] && email.state !== "READY_TO_SEND") {
        await client.query("ROLLBACK");
        return NextResponse.json(
          apiError("CAS_ABORT_AWAITING_REVIEW_TO_READY_TO_SEND", "state_mismatch", "Email state changed; refresh and retry."),
          { status: 409 },
        );
      }

      await client.query("COMMIT");

      await logStep({
        trace_id: email.trace_id ?? "unknown",
        gmail_id: email.gmail_id,
        step: "approve_send_atomic",
        state: "READY_TO_SEND",
        latency_ms: 0,
      });

      const config = await getConfig();
      const response = NextResponse.json({
        ok: true,
        status: "queued",
        emailId: email.id,
        draftId: draft.id,
        send_mode: config.send_mode,
      });

      if (idempotencyKey) {
        await saveIdempotentResponse(email.id, "approve-send", idempotencyKey, 200, {
          ok: true,
          status: "queued",
          emailId: email.id,
          draftId: draft.id,
          send_mode: config.send_mode,
        }).catch(() => {});
      }

      logSlowApi("/api/drafts/:id/approve-send", start);
      return response;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "APPROVE_SEND_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry approve-and-send. If this persists, refresh thread and verify draft state.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/drafts/:id/approve-send", start);
    return response;
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/drafts/[id]/approve-send', operation: 'POST' });
