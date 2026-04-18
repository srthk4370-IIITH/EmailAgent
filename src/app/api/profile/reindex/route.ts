import { NextResponse } from "next/server";

import { db, initDbSchema } from "../../../../db/client";
import { queueEmbeddingJob } from "../../../../core/jobQueue";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

async function POSTHandler() {
  try {
    await initDbSchema();
    const result = await db.query<{ id: number; trace_id: string | null }>(
      `UPDATE emails
       SET embedding_status = 'pending',
           embedding_error = NULL,
           updated_at = NOW()
       WHERE source = 'sent'
        AND (
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
        )
         AND embedding_status <> 'embedded'
       RETURNING id, trace_id`,
    );

    for (const row of result.rows) {
      await queueEmbeddingJob(row.id, row.trace_id);
    }

    return NextResponse.json({
      queued: result.rows.length,
      status: "queued",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to queue re-index jobs" },
      { status: 500 },
    );
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/profile/reindex', operation: 'POST' });
