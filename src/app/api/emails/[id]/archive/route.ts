import { NextResponse } from "next/server";

import { db } from "../../../../../db/client";
import { getEmailById } from "../../../../../db/emails";
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
      const existing = await getIdempotentResponse(email.id, "archive-email", idempotencyKey);
      if (existing) {
        return NextResponse.json(existing.response_json, { status: existing.status_code });
      }
    }

    if (email.source !== "inbox") {
      return NextResponse.json(
        apiError("ARCHIVE_SOURCE_INVALID", "not_inbox_source", "Only inbox emails can be archived from this endpoint."),
        { status: 409 },
      );
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM drafts WHERE email_id = $1", [email.id]);
      await client.query(
        `UPDATE emails
         SET review_outcome = 'rejected',
             state = 'REPLIED',
             decision = 'manual',
             ready_to_send_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [email.id],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const payload = { status: "archived", emailId: email.id };
    if (idempotencyKey) {
      await saveIdempotentResponse(email.id, "archive-email", idempotencyKey, 200, payload).catch(() => {});
    }

    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      apiError(
        "ARCHIVE_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry archive. If this persists, refresh inbox and inspect diagnostics.",
      ),
      { status: 500 },
    );
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/emails/[id]/archive', operation: 'POST' });
