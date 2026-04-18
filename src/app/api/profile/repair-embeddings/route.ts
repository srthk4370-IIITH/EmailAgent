import { NextResponse } from "next/server";

import { db, initDbSchema } from "../../../../db/client";
import { getDefaultEmailAccount } from "../../../../db/emailAccounts";
import { bumpEmbeddingDatasetVersion } from "../../../../db/embeddings";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

async function POSTHandler() {
  try {
    await initDbSchema();
    const account = await getDefaultEmailAccount();
    const accountId = account?.id ?? null;

    const reasonBreakdown = await db.query<{ reason: string; chunk_count: string; email_count: string }>(
      `WITH invalid AS (
         SELECT
           em.id,
           em.email_id,
           CASE
             WHEN e.source <> 'sent' THEN 'non_sent_source'
             WHEN COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
              AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
             THEN 'untouched_app_generated'
             ELSE 'unverified_sent_metadata'
           END AS reason
         FROM email_embeddings em
         JOIN emails e ON e.id = em.email_id
         WHERE ($1::int IS NULL OR e.account_id = $1)
           AND (
             e.source <> 'sent'
             OR (
               COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
               AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
             )
             OR (
               COALESCE(e.parsed_content->>'app_generated', 'false') <> 'true'
               AND COALESCE(e.parsed_content->>'sent_by_user', 'false') <> 'true'
               AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
             )
           )
       )
       SELECT reason, COUNT(*)::text AS chunk_count, COUNT(DISTINCT email_id)::text AS email_count
       FROM invalid
       GROUP BY reason
       ORDER BY COUNT(*) DESC`,
      [accountId],
    );

    const deletedChunks = await db.query<{ id: number; email_id: number }>(
      `WITH invalid AS (
         SELECT em.id, em.email_id
         FROM email_embeddings em
         JOIN emails e ON e.id = em.email_id
         WHERE ($1::int IS NULL OR e.account_id = $1)
           AND (
             e.source <> 'sent'
             OR (
               COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
               AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
             )
             OR (
               COALESCE(e.parsed_content->>'app_generated', 'false') <> 'true'
               AND COALESCE(e.parsed_content->>'sent_by_user', 'false') <> 'true'
               AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
             )
           )
       )
       DELETE FROM email_embeddings em
       USING invalid i
       WHERE em.id = i.id
       RETURNING em.id, em.email_id`,
      [accountId],
    );

    const affectedEmailIds = Array.from(new Set(deletedChunks.rows.map((row) => row.email_id)));

    if (affectedEmailIds.length > 0) {
      await db.query(
        `UPDATE emails
         SET embedding_status = 'skipped_filter',
             embedding_error = 'Removed by profile memory-integrity repair: not sent/manual/user-edited content.',
             updated_at = NOW()
         WHERE id = ANY($1::int[])`,
        [affectedEmailIds],
      );
      await bumpEmbeddingDatasetVersion();
    }

    return NextResponse.json({
      removed_chunks: deletedChunks.rows.length,
      affected_emails: affectedEmailIds.length,
      reason_breakdown: reasonBreakdown.rows.map((row) => ({
        reason: row.reason,
        chunk_count: Number(row.chunk_count ?? 0),
        email_count: Number(row.email_count ?? 0),
      })),
      status: deletedChunks.rows.length > 0 ? "repaired" : "already_clean",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to repair embedding integrity" },
      { status: 500 },
    );
  }
}

export const POST = withApiRoute(POSTHandler, { route: "/profile/repair-embeddings", operation: "POST" });
