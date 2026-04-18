import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sendManualGmailEmail } from "../../../../services/sendManual";
import { insertEmailIfNotExists, getEmailById, updateParsedContent } from "../../../../db/emails";
import { getIdempotentResponse, saveIdempotentResponse } from "../../../../db/idempotency";
import { queueEmbeddingJob } from "../../../../core/jobQueue";
import { createTraceId } from "../../../../utils/trace";
import { sanitizeStoredEmailText, extractEmailAddress } from "../../../../utils/sanitizeEmail";
import { logStep } from "../../../../utils/logger";
import { logSlowApi } from "../../../../utils/api";
import { resolveAccountContext } from "../../../../lib/accountContext";
import { apiError } from "../../../../lib/apiError";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

const schema = z.object({
  to: z.string().email("Invalid recipient email"),
  subject: z.string().min(1, "Subject is required"),
  body: z.string().min(1, "Body is required"),
  threadId: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        dataBase64: z.string().min(1),
      }),
    )
    .optional(),
});

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function extractPayload(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return request.json();
  }

  const form = await request.formData();
  const to = String(form.get("to") ?? "");
  const subject = String(form.get("subject") ?? "");
  const body = String(form.get("body") ?? "");
  const threadIdRaw = form.get("threadId");
  const threadId = threadIdRaw ? String(threadIdRaw) : undefined;

  const attachments: Array<{ filename: string; mimeType: string; dataBase64: string }> = [];
  for (const value of form.getAll("attachments")) {
    if (!(value instanceof File)) continue;
    const bytes = value.size;
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment too large: ${value.name}`);
    }
    const buffer = Buffer.from(await value.arrayBuffer());
    attachments.push({
      filename: value.name,
      mimeType: value.type || "application/octet-stream",
      dataBase64: buffer.toString("base64"),
    });
  }

  return {
    to,
    subject,
    body,
    threadId,
    attachments,
  };
}

async function POSTHandler(request: NextRequest) {
  const start = Date.now();
  const traceId = createTraceId();

  try {
    const payloadRaw = await extractPayload(request);
    if (typeof payloadRaw !== "object" || payloadRaw == null) {
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }
    const parsedPayload: Record<string, unknown> = { ...payloadRaw };

    // Extract pure email for Zod validation to avoid rejecting "Name <email>" format
    if (typeof parsedPayload.to === "string") {
      parsedPayload.to = extractEmailAddress(parsedPayload.to);
    }

    const parsed = schema.safeParse(parsedPayload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { to, subject, body } = parsed.data;
    const threadId = parsed.data.threadId;
    const attachments = parsed.data.attachments ?? [];
    const { accountId, systemId } = await resolveAccountContext();
    if (!accountId) {
      return NextResponse.json({ error: "ACCOUNT_UNAVAILABLE", cause: "no_default_account", fix: "Connect Gmail account in onboarding and retry" }, { status: 400 });
    }

    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
    const emailIdentityHash = `${(subject || "").trim().toLowerCase()}|${(to || "").trim().toLowerCase()}|${(threadId || "").trim()}`;

    // Step 1: Send via Gmail API (no X-App-Generated header)
    let gmailId: string;
    try {
      gmailId = await sendManualGmailEmail({
        to,
        subject,
        body,
        accountId,
        attachments,
        ...(threadId ? { threadId } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Gmail send failed";
      await logStep({
        trace_id: traceId,
        gmail_id: null,
        step: "EMAIL_SENT_MANUAL",
        state: "ERROR",
        latency_ms: Date.now() - start,
        error: msg,
      });
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    // Step 2: Store in DB with gmail_id IMMEDIATELY — prevents duplicate ingestion
    // ON CONFLICT (gmail_id) DO NOTHING ensures the sync pipeline will skip this later
    const inserted = await insertEmailIfNotExists({
      systemId,
      accountId,
      gmailId,
      traceId,
      threadId: threadId ?? "",
      fromEmail: to, // "from" in our context = the recipient for sent emails
      subject: sanitizeStoredEmailText(subject),
      body: sanitizeStoredEmailText(body),
      snippet: sanitizeStoredEmailText(body.slice(0, 200)),
      internalDate: Date.now(),
      source: "sent",
      state: "SENT",
    });

    if (!inserted) {
      // gmail_id already exists — extremely unlikely race but handle it
      await logStep({
        trace_id: traceId,
        gmail_id: gmailId,
        step: "EMAIL_EMBED_SKIPPED_DUPLICATE",
        state: "SENT",
        latency_ms: Date.now() - start,
      });
      return NextResponse.json({ status: "sent", gmailId, duplicate: true });
    }

    if (idempotencyKey) {
      const existing = await getIdempotentResponse(inserted.id, "compose-send", idempotencyKey);
      if (existing) {
        return NextResponse.json(existing.response_json, { status: existing.status_code });
      }
    }

    // Step 3: Set parsed_content with sent_by_user=true, app_generated=false
    await updateParsedContent(inserted.id, {
      subject: inserted.subject,
      from: to,
      body: inserted.body,
      snippet: inserted.snippet,
      thread_id: inserted.thread_id,
      app_generated: false,
      sent_by_user: true,
      user_edited: true,
    });

    await logStep({
      trace_id: traceId,
      gmail_id: gmailId,
      step: "EMAIL_SENT_MANUAL",
      state: "SENT",
      latency_ms: Date.now() - start,
    });

    // Step 4: Queue sent-memory indexing so sending stays responsive.
    await queueEmbeddingJob(inserted.id, traceId, { accountId, systemId });
    await logStep({
      trace_id: traceId,
      gmail_id: gmailId,
      step: "EMAIL_EMBED_QUEUED",
      state: "SENT",
      latency_ms: Date.now() - start,
      meta: { emailId: inserted.id },
    });

    const finalEmail = await getEmailById(inserted.id);
    const responsePayload = {
      status: "sent",
      gmailId,
      emailId: inserted.id,
      traceId,
      idempotency_identity: emailIdentityHash,
      embedding_status: finalEmail?.embedding_status ?? "pending",
    };

    if (idempotencyKey) {
      await saveIdempotentResponse(inserted.id, "compose-send", idempotencyKey, 200, responsePayload).catch(() => {});
    }

    const response = NextResponse.json(responsePayload);
    logSlowApi("/api/compose/send", start);
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const response = NextResponse.json(
      apiError(
        "MANUAL_SEND_FAILED",
        msg,
        "Verify Gmail account connectivity and retry. If failure persists, run diagnostics.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/compose/send", start);
    return response;
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/compose/send', operation: 'POST' });
