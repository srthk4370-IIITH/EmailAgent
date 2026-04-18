import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createTraceId } from "../../../../utils/trace";
import { insertEmailIfNotExists } from "../../../../db/emails";
import { apiError } from "../../../../lib/apiError";
import { sanitizeStoredEmailText } from "../../../../utils/sanitizeEmail";
import { logSlowApi } from "../../../../utils/api";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

const schema = z.object({
  subject: z.string().min(1),
  from: z.string().min(3),
  body: z.string().min(1),
});

async function POSTHandler(request: NextRequest) {
  const start = Date.now();
  try {
    const payload = await request.json();
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const gmailId = `test-${Date.now()}`;
    const traceId = createTraceId();
    const inserted = await insertEmailIfNotExists({
      gmailId,
      traceId,
      threadId: `thread-${Date.now()}`,
      fromEmail: sanitizeStoredEmailText(parsed.data.from),
      subject: sanitizeStoredEmailText(parsed.data.subject),
      body: sanitizeStoredEmailText(parsed.data.body),
      snippet: sanitizeStoredEmailText(parsed.data.body).slice(0, 120),
      internalDate: Date.now(),
      source: "inbox",
      state: "INGESTED",
    });

    const response = NextResponse.json({
      status: "queued",
      emailId: inserted?.id ?? null,
      trace_id: traceId,
    });
    logSlowApi("/api/test/email", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "TEST_EMAIL_INSERT_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry test email creation. If it persists, verify database health.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/test/email", start);
    return response;
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/test/email', operation: 'POST' });
