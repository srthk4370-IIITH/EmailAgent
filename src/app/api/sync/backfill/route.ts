import { NextResponse } from "next/server";
import { getValidAccountClient, buildGmailEmail } from "../../../../services/gmail";
import { insertEmailIfNotExists, updateParsedContent, updateEmbeddingStatus } from "../../../../db/emails";
import { queueEmbeddingJob } from "../../../../core/jobQueue";
import { saveLog } from "../../../../db/logs";
import { createTraceId } from "../../../../utils/trace";
import { sanitizeStoredEmailText } from "../../../../utils/sanitizeEmail";
import { logger } from "../../../../utils/logger";
import { resolveAccountContext } from "../../../../lib/accountContext";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

async function POSTHandler(req: Request) {
  const traceId = createTraceId();
  try {
    const body = await req.json().catch(() => ({})) as any;
    const limit = body.limit ?? 100;
    const pageToken = body.pageToken ?? null;
    const { accountId, systemId } = await resolveAccountContext();
    if (!accountId) {
      return NextResponse.json({ error: "ACCOUNT_UNAVAILABLE", cause: "no_default_account", fix: "Connect Gmail and retry backfill" }, { status: 400 });
    }
    
    await saveLog({
      traceId,
      step: "GMAIL_IMPORT_STARTED",
      state: "PROCESSING",
      subject: `Importing history from Gmail (limit: ${limit})`,
    });

    const gmail = await getValidAccountClient(accountId);
    if (!gmail) throw new Error("Gmail not configured");

    const response = await gmail.users.messages.list({
      userId: "me",
      q: "label:SENT",
      maxResults: limit,
      pageToken: pageToken || undefined,
    });

    const messages = response.data.messages ?? [];
    const nextPageToken = response.data.nextPageToken || null;
    let insertedCount = 0;
    let skippedCount = 0;

    for (const msg of messages) {
      if (!msg.id) continue;
      
      // We need the full detail for body/subject
      // Using buildGmailEmail from services/gmail is best
      try {
        const fullEmail = await buildGmailEmail(gmail, msg.id, "sent");
        if (!fullEmail) continue;

        const inserted = await insertEmailIfNotExists({
          systemId,
          accountId,
          gmailId: fullEmail.gmailId,
          traceId,
          threadId: fullEmail.threadId,
          fromEmail: sanitizeStoredEmailText(fullEmail.from || ""),
          subject: sanitizeStoredEmailText(fullEmail.subject || "(no subject)"),
          body: sanitizeStoredEmailText(fullEmail.body || ""),
          snippet: sanitizeStoredEmailText(fullEmail.snippet || ""),
          internalDate: fullEmail.internalDate,
          source: "sent",
          state: "SENT",
        });

        if (inserted) {
          insertedCount++;
          await updateParsedContent(inserted.id, {
            subject: inserted.subject,
            from: inserted.from_email,
            body: inserted.body,
            snippet: inserted.snippet,
            thread_id: inserted.thread_id,
            app_generated: fullEmail.appGenerated,
            sent_by_user: !fullEmail.appGenerated,
            user_edited: fullEmail.userEdited,
          });

          if (!fullEmail.appGenerated || fullEmail.userEdited) {
            await queueEmbeddingJob(inserted.id, traceId, { accountId, systemId });
          } else {
            await updateEmbeddingStatus(
              inserted.id,
              "skipped_filter",
              "Untouched app-generated replies are excluded from sent-memory indexing.",
            );
          }
        } else {
          skippedCount++;
        }
      } catch (err) {
        logger.warn(`Failed to import message ${msg.id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await saveLog({
      traceId,
      step: "GMAIL_IMPORT_BATCH_COMPLETE",
      state: "SUCCESS",
      subject: `Batch complete: ${insertedCount} new, ${skippedCount} duplicates.`,
      meta: ({ insertedCount, skippedCount, nextPageToken } as any)
    });

    return NextResponse.json({
      status: "success",
      inserted: insertedCount,
      skipped: skippedCount,
      nextPageToken,
      done: !nextPageToken || (insertedCount === 0 && skippedCount > 50) // heuristic to stop if we hit older mail we already have
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backfill failed";
    await saveLog({
      traceId,
      step: "BACKFILL_FAILED",
      state: "ERROR",
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/sync/backfill', operation: 'POST' });
