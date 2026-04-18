import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { getEmailById } from "../../../../db/emails";
import { indexEmailForRag } from "../../../../core/rag";
import { logger } from "../../../../utils/logger";
import { saveLog } from "../../../../db/logs";
import { resolveAccountContext } from "../../../../lib/accountContext";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

type SyncResponse = {
  status: "complete" | "running" | "already_running" | "error";
  processed: number;
  embedded: number;
  skipped: number;
  failed: number;
  total_remaining: number;
  done: boolean;
  error?: string;
};

async function POSTHandler(req: Request) {
  try {
    const { retryFailed = false } = await req.json().catch(() => ({}));
    const { accountId } = await resolveAccountContext();

    // 1. Check and acquire lock in config table
    const configRes = await db.query<{ sync_running: boolean }>(`SELECT sync_running FROM config WHERE id = 1`);
    if (configRes.rows[0]?.sync_running) {
      return NextResponse.json({ status: "already_running" }, { status: 409 });
    }

    // Set lock
    await db.query(`UPDATE config SET sync_running = true, sync_started_at = NOW() WHERE id = 1`);

    let processed = 0;
    let embedded = 0;
    let skipped = 0;
    let failed = 0;
    let traceId = `sync_${Date.now()}`;

    try {
      await saveLog({
        traceId,
        step: "BACKFILL_STARTED",
        state: "SUCCESS",
        subject: `Starting batch sync (Retry Failed: ${retryFailed})`,
      });

      // 2. ID-Based Progress cursor query
      const statusFilter = retryFailed ? "embedding_status IN ('pending', 'failed')" : "embedding_status = 'pending'";
      const policyFilter = `(
        (
          COALESCE(parsed_content->>'app_generated', 'false') = 'true'
          AND COALESCE(parsed_content->>'user_edited', 'false') = 'true'
        )
        OR (
          COALESCE(parsed_content->>'app_generated', 'false') <> 'true'
          AND (
            COALESCE(parsed_content->>'sent_by_user', 'false') = 'true'
            OR COALESCE(parsed_content->>'user_edited', 'false') = 'true'
          )
        )
      )`;

      const targetEmailsRes = await db.query<{ id: number; gmail_id: string }>(
        `
        SELECT id, gmail_id 
        FROM emails 
        WHERE ${statusFilter} 
          AND source = 'sent'
          AND ${policyFilter}
          AND ($1::int IS NULL OR account_id = $1)
        ORDER BY created_at ASC
        LIMIT 20
        `,
        [accountId ?? null],
      );

      for (const row of targetEmailsRes.rows) {
        // Double check it's loaded properly
        const email = await getEmailById(row.id);
        if (!email) continue;
        
        const initialStatus = email.embedding_status;
        
        try {
          await indexEmailForRag(email);
          const updatedEmail = await getEmailById(email.id);
          const finalStatus = updatedEmail?.embedding_status ?? initialStatus;
          
          if (finalStatus === "embedded") {
            embedded++;
          } else if (finalStatus === "failed") {
            failed++;
          } else {
            skipped++; // skipped_short, skipped_duplicate, etc.
          }
        } catch (err) {
          failed++;
          const errorMessage = err instanceof Error ? err.message : String(err);
          await db.query("UPDATE emails SET embedding_status = 'failed', embedding_error = $1 WHERE id = $2", [errorMessage, email.id]);
          await saveLog({
            traceId,
            gmailId: email.gmail_id,
            step: "EMAIL_EMBED_FAILED",
            state: "ERROR",
            error: errorMessage,
            subject: `Backfill failed for email ${email.id}`,
            meta: { email_id: email.id }
          });
        }
        processed++;
      }

      // Count remaining
      const countRes = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM emails
         WHERE ${statusFilter}
           AND source = 'sent'
           AND ${policyFilter}
           AND ($1::int IS NULL OR account_id = $1)`,
        [accountId ?? null],
      );
      const totalRemaining = parseInt(countRes.rows[0]?.count ?? "0", 10);
      const done = totalRemaining === 0;

      await saveLog({
        traceId,
        step: done ? "BACKFILL_COMPLETED" : "BACKFILL_PROGRESS",
        state: "SUCCESS",
        subject: `Processed ${processed} (Embedded: ${embedded}, Skipped: ${skipped}, Failed: ${failed}). Remaining: ${totalRemaining}`,
        meta: { processed, embedded, skipped, failed, totalRemaining, done }
      });

      // Release lock
      await db.query(`UPDATE config SET sync_running = false WHERE id = 1`);

      const res: SyncResponse = {
        status: done ? "complete" : "running",
        processed,
        embedded,
        skipped,
        failed,
        total_remaining: totalRemaining,
        done,
      };

      return NextResponse.json(res);

    } catch (innerError) {
      // Ensure lock is released on error inner loop
      await db.query(`UPDATE config SET sync_running = false WHERE id = 1`);
      throw innerError;
    }

  } catch (err) {
    logger.error("Sync history failed", { error: err });
    const res: SyncResponse = {
      status: "error",
      processed: 0,
      embedded: 0,
      skipped: 0,
      failed: 0,
      total_remaining: -1,
      done: true,
      error: err instanceof Error ? err.message : "Unknown error",
    };
    return NextResponse.json(res, { status: 500 });
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/sync/sent-history', operation: 'POST' });
