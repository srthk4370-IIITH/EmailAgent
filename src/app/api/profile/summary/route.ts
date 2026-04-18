import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { getUserBySessionToken } from "../../../../db/auth";
import { db, initDbSchema } from "../../../../db/client";
import { getConfig } from "../../../../db/config";
import { getDefaultEmailAccount } from "../../../../db/emailAccounts";
import { countJobsByStatus } from "../../../../db/jobs";
import { getRuntimeConfig } from "../../../../lib/runtimeConfig";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

function asNumber(value: string | number | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function GETHandler() {
  await initDbSchema();
  const jar = await cookies();
  const token = jar.get("ea_session")?.value;
  const user = token ? await getUserBySessionToken(token) : null;
  const openAiReady = Boolean(await getRuntimeConfig("OPENAI_API_KEY"));
  const account = await getDefaultEmailAccount();
  const accountId = account?.id ?? null;

  try {
    const [
      dbHealth,
      config,
      totals,
      embeddingTotal,
      sentTotal,
      embeddedSent,
      jobs,
      jobsFailed,
      ragWindow,
      ragTraceWindow,
      ragIntentMix,
      embeddingIntegrity,
      invalidEmbeddingSamples,
    ] = await Promise.all([
      db.query("SELECT 1"),
      getConfig(),
      db.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM emails WHERE ($1::int IS NULL OR account_id = $1)",
        [accountId],
      ),
      db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM email_embeddings em
         JOIN emails e ON e.id = em.email_id
         WHERE ($1::int IS NULL OR e.account_id = $1)`,
        [accountId],
      ),
      db.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM emails WHERE source = 'sent' AND ($1::int IS NULL OR account_id = $1)",
        [accountId],
      ),
      db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM emails
         WHERE source = 'sent'
           AND embedding_status = 'embedded'
           AND ($1::int IS NULL OR account_id = $1)`,
        [accountId],
      ),
      countJobsByStatus("embed_email"),
      db.query<{ id: number; last_error: string; attempts: number; updated_at: string }>(
        `SELECT id, last_error, attempts, updated_at
         FROM job_queue
         WHERE status = 'failed'
           AND ($1::int IS NULL OR account_id = $1)
         ORDER BY updated_at DESC
         LIMIT 5`,
        [accountId],
      ),
      db.query<{
        sample_count: string;
        avg_confidence: string | null;
        strong_rate: string | null;
        low_rate: string | null;
        conflict_rate: string | null;
        context_hit_rate: string | null;
        avg_context_items: string | null;
      }>(
        `WITH recent AS (
           SELECT
             COALESCE(rag_confidence, 0)::float AS rag_confidence,
             COALESCE(rag_conflict_detected, false) AS rag_conflict_detected,
             CASE
               WHEN jsonb_typeof(rag_context) = 'array' THEN jsonb_array_length(rag_context)
               ELSE 0
             END AS context_items
           FROM emails
           WHERE source = 'inbox'
             AND state IN ('GENERATED', 'AWAITING_REVIEW', 'READY_TO_SEND', 'SENT', 'REPLIED', 'ERROR_TEMP', 'ERROR_FATAL', 'DEAD')
             AND ($1::int IS NULL OR account_id = $1)
           ORDER BY updated_at DESC
           LIMIT 250
         )
         SELECT
           COUNT(*)::text AS sample_count,
           AVG(rag_confidence)::text AS avg_confidence,
           AVG(CASE WHEN rag_confidence >= 0.65 THEN 1 ELSE 0 END)::text AS strong_rate,
           AVG(CASE WHEN rag_confidence < 0.32 THEN 1 ELSE 0 END)::text AS low_rate,
           AVG(CASE WHEN rag_conflict_detected THEN 1 ELSE 0 END)::text AS conflict_rate,
           AVG(CASE WHEN context_items > 0 THEN 1 ELSE 0 END)::text AS context_hit_rate,
           AVG(context_items)::text AS avg_context_items
         FROM recent`,
        [accountId],
      ),
      db.query<{
        sample_count: string;
        unknown_intent_rate: string | null;
        retrieval_failure_rate: string | null;
        usage_failure_rate: string | null;
        synthesis_failure_rate: string | null;
      }>(
        `WITH trace_logs AS (
           SELECT l.meta
           FROM logs l
           LEFT JOIN emails e
             ON (l.meta->>'email_id') ~ '^[0-9]+$'
            AND e.id = (l.meta->>'email_id')::int
           WHERE l.step = 'rag_trace'
             AND l.created_at >= NOW() - INTERVAL '14 days'
             AND ($1::int IS NULL OR e.account_id = $1)
         )
         SELECT
           COUNT(*)::text AS sample_count,
           AVG(CASE WHEN COALESCE(meta->>'query_intent', 'unknown') = 'unknown' THEN 1 ELSE 0 END)::text AS unknown_intent_rate,
           AVG(CASE WHEN COALESCE(meta->>'failure_type', '') = 'retrieval_failure' THEN 1 ELSE 0 END)::text AS retrieval_failure_rate,
           AVG(CASE WHEN COALESCE(meta->>'failure_type', '') = 'usage_failure' THEN 1 ELSE 0 END)::text AS usage_failure_rate,
           AVG(CASE WHEN COALESCE(meta->>'failure_type', '') = 'synthesis_failure' THEN 1 ELSE 0 END)::text AS synthesis_failure_rate
         FROM trace_logs`,
        [accountId],
      ),
      db.query<{ intent: string; count: string }>(
        `WITH trace_logs AS (
           SELECT l.meta
           FROM logs l
           LEFT JOIN emails e
             ON (l.meta->>'email_id') ~ '^[0-9]+$'
            AND e.id = (l.meta->>'email_id')::int
           WHERE l.step = 'rag_trace'
             AND l.created_at >= NOW() - INTERVAL '14 days'
             AND ($1::int IS NULL OR e.account_id = $1)
         )
         SELECT COALESCE(meta->>'query_intent', 'unknown') AS intent, COUNT(*)::text AS count
         FROM trace_logs
         GROUP BY 1
         ORDER BY COUNT(*) DESC
         LIMIT 4`,
        [accountId],
      ),
      db.query<{
        total_chunks: string;
        embedded_email_count: string;
        policy_valid_chunks: string;
        invalid_non_sent_chunks: string;
        invalid_untouched_app_chunks: string;
        invalid_unverified_sent_chunks: string;
      }>(
        `SELECT
           COUNT(*)::text AS total_chunks,
           COUNT(DISTINCT em.email_id)::text AS embedded_email_count,
           COALESCE(
             SUM(
               CASE
                 WHEN e.source = 'sent'
                  AND (
                    (COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
                     AND COALESCE(e.parsed_content->>'user_edited', 'false') = 'true')
                    OR
                    (COALESCE(e.parsed_content->>'app_generated', 'false') <> 'true'
                     AND (
                       COALESCE(e.parsed_content->>'sent_by_user', 'false') = 'true'
                       OR COALESCE(e.parsed_content->>'user_edited', 'false') = 'true'
                     ))
                  )
                 THEN 1
                 ELSE 0
               END
             ),
             0
           )::text AS policy_valid_chunks,
           COALESCE(SUM(CASE WHEN e.source <> 'sent' THEN 1 ELSE 0 END), 0)::text AS invalid_non_sent_chunks,
           COALESCE(
             SUM(
               CASE
                 WHEN e.source = 'sent'
                  AND COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
                  AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
                 THEN 1
                 ELSE 0
               END
             ),
             0
           )::text AS invalid_untouched_app_chunks,
           COALESCE(
             SUM(
               CASE
                 WHEN e.source = 'sent'
                  AND COALESCE(e.parsed_content->>'app_generated', 'false') <> 'true'
                  AND COALESCE(e.parsed_content->>'sent_by_user', 'false') <> 'true'
                  AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
                 THEN 1
                 ELSE 0
               END
             ),
             0
           )::text AS invalid_unverified_sent_chunks
         FROM email_embeddings em
         JOIN emails e ON e.id = em.email_id
         WHERE ($1::int IS NULL OR e.account_id = $1)`,
        [accountId],
      ),
      db.query<{
        email_id: number;
        source: string;
        subject: string;
        updated_at: string;
        chunk_count: string;
        reason: string;
      }>(
        `SELECT
           e.id AS email_id,
           e.source,
           e.subject,
           e.updated_at::text AS updated_at,
           COUNT(*)::text AS chunk_count,
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
         GROUP BY e.id, e.source, e.subject, e.updated_at, reason
         ORDER BY e.updated_at DESC
         LIMIT 6`,
        [accountId],
      ),
    ]);

    const ragWindowRow = ragWindow.rows[0];
    const ragTraceRow = ragTraceWindow.rows[0];
    const integrityRow = embeddingIntegrity.rows[0];

    const totalChunks = asNumber(integrityRow?.total_chunks);
    const invalidNonSentChunks = asNumber(integrityRow?.invalid_non_sent_chunks);
    const invalidUntouchedAppChunks = asNumber(integrityRow?.invalid_untouched_app_chunks);
    const invalidUnverifiedSentChunks = asNumber(integrityRow?.invalid_unverified_sent_chunks);
    const invalidChunks = invalidNonSentChunks + invalidUntouchedAppChunks + invalidUnverifiedSentChunks;
    const purityScore = totalChunks > 0 ? Math.max(0, (totalChunks - invalidChunks) / totalChunks) : 1;

    return NextResponse.json({
      connected_email: user?.email ?? null,
      services: {
        gmail: Boolean(account?.oauth_refresh_token) && Boolean(account ? account.last_history_id : config.last_gmail_history_id),
        supabase: dbHealth.rowCount === 1,
        openai: openAiReady,
      },
      usage: {
        total_emails_processed: Number(totals.rows[0]?.count ?? 0),
        total_embeddings: Number(embeddingTotal.rows[0]?.count ?? 0),
        sent_emails: Number(sentTotal.rows[0]?.count ?? 0),
        embedded_sent_emails: Number(embeddedSent.rows[0]?.count ?? 0),
      },
      jobs,
      rag: {
        sampled_emails: asNumber(ragWindowRow?.sample_count),
        avg_confidence: asNumber(ragWindowRow?.avg_confidence),
        strong_confidence_rate: asNumber(ragWindowRow?.strong_rate),
        low_confidence_rate: asNumber(ragWindowRow?.low_rate),
        conflict_rate: asNumber(ragWindowRow?.conflict_rate),
        context_hit_rate: asNumber(ragWindowRow?.context_hit_rate),
        avg_context_items: asNumber(ragWindowRow?.avg_context_items),
        trace_samples_14d: asNumber(ragTraceRow?.sample_count),
        unknown_intent_rate: asNumber(ragTraceRow?.unknown_intent_rate),
        retrieval_failure_rate: asNumber(ragTraceRow?.retrieval_failure_rate),
        usage_failure_rate: asNumber(ragTraceRow?.usage_failure_rate),
        synthesis_failure_rate: asNumber(ragTraceRow?.synthesis_failure_rate),
        top_intents: ragIntentMix.rows.map((row) => ({ intent: row.intent, count: asNumber(row.count) })),
      },
      embedding_integrity: {
        total_chunks: totalChunks,
        embedded_email_count: asNumber(integrityRow?.embedded_email_count),
        policy_valid_chunks: asNumber(integrityRow?.policy_valid_chunks),
        invalid_chunks: invalidChunks,
        invalid_non_sent_chunks: invalidNonSentChunks,
        invalid_untouched_app_chunks: invalidUntouchedAppChunks,
        invalid_unverified_sent_chunks: invalidUnverifiedSentChunks,
        purity_score: purityScore,
        invalid_samples: invalidEmbeddingSamples.rows.map((row) => ({
          email_id: row.email_id,
          source: row.source,
          subject: row.subject,
          updated_at: row.updated_at,
          chunk_count: asNumber(row.chunk_count),
          reason: row.reason,
        })),
      },
      recent_failed_jobs: jobsFailed.rows,
      workspace_gmail_connection: Boolean(account?.oauth_refresh_token),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load profile summary",
      },
      { status: 500 },
    );
  }
}


export const GET = withApiRoute(GETHandler, { route: "/profile/summary", operation: "GET" });
