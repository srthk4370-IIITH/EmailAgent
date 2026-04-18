import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";

import { createTraceId } from "../../../utils/trace";
import { createComposeRequest } from "../../../db/composeRequests";
import { db } from "../../../db/client";
import { apiError } from "../../../lib/apiError";
import { sanitizeStoredEmailText } from "../../../utils/sanitizeEmail";
import { logSlowApi } from "../../../utils/api";
import { withApiRoute } from "../../../lib/routeErrorHandler";

const schema = z.object({
  category: z.string().trim().min(1).default("general"),
  context: z.string().min(1),
});

async function POSTHandler(request: NextRequest) {
  const start = Date.now();
  try {
    const payload = await request.json();
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const traceId = createTraceId();
    const category = sanitizeStoredEmailText(parsed.data.category || "general");
    const context = sanitizeStoredEmailText(parsed.data.context);
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();

    let row;
    if (idempotencyKey) {
      const dedupeHash = crypto
        .createHash("sha1")
        .update(`${category}\n${context}`)
        .digest("hex");

      const existing = await db.query<{ id: number; trace_id: string }>(
        `SELECT id, trace_id
         FROM compose_requests
         WHERE status IN ('pending', 'processing')
           AND category = $1
           AND md5(context) = md5($2)
         ORDER BY id DESC
         LIMIT 1`,
        [category, context],
      );
      if (existing.rows[0]) {
        const response = NextResponse.json({ status: "queued", requestId: existing.rows[0].id, trace_id: existing.rows[0].trace_id, dedupe: true, dedupe_hash: dedupeHash });
        logSlowApi("/api/compose", start);
        return response;
      }
    }

    row = await createComposeRequest({
      traceId,
      category,
      context,
    });

    const response = NextResponse.json({ status: "queued", requestId: row.id, trace_id: traceId });
    logSlowApi("/api/compose", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "COMPOSE_QUEUE_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry compose request. If it persists, inspect worker and database health.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/compose", start);
    return response;
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/compose', operation: 'POST' });
