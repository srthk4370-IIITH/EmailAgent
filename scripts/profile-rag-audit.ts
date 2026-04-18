import { db } from "../src/db/client";

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function main() {
  const ragWindow = await db.query<{
    sampled_emails: string;
    avg_confidence: string | null;
    context_hit_rate: string | null;
    conflict_rate: string | null;
    low_confidence_rate: string | null;
  }>(
    `SELECT
       COUNT(*)::text AS sampled_emails,
       AVG(COALESCE(rag_confidence, 0))::text AS avg_confidence,
       AVG(
         CASE
           WHEN jsonb_typeof(rag_context) = 'array' AND jsonb_array_length(rag_context) > 0 THEN 1
           ELSE 0
         END
       )::text AS context_hit_rate,
       AVG(CASE WHEN COALESCE(rag_conflict_detected, false) THEN 1 ELSE 0 END)::text AS conflict_rate,
       AVG(CASE WHEN COALESCE(rag_confidence, 0) < 0.32 THEN 1 ELSE 0 END)::text AS low_confidence_rate
     FROM emails
     WHERE source = 'inbox'
       AND state IN ('GENERATED', 'AWAITING_REVIEW', 'READY_TO_SEND', 'SENT', 'REPLIED', 'ERROR_TEMP', 'ERROR_FATAL', 'DEAD')`,
  );

  const traceWindow = await db.query<{
    sampled_traces: string;
    unknown_intent_rate: string | null;
    retrieval_failure_rate: string | null;
    usage_failure_rate: string | null;
    synthesis_failure_rate: string | null;
  }>(
    `SELECT
       COUNT(*)::text AS sampled_traces,
       AVG(CASE WHEN COALESCE(meta->>'query_intent', 'unknown') = 'unknown' THEN 1 ELSE 0 END)::text AS unknown_intent_rate,
       AVG(CASE WHEN COALESCE(meta->>'failure_type', '') = 'retrieval_failure' THEN 1 ELSE 0 END)::text AS retrieval_failure_rate,
       AVG(CASE WHEN COALESCE(meta->>'failure_type', '') = 'usage_failure' THEN 1 ELSE 0 END)::text AS usage_failure_rate,
       AVG(CASE WHEN COALESCE(meta->>'failure_type', '') = 'synthesis_failure' THEN 1 ELSE 0 END)::text AS synthesis_failure_rate
     FROM logs
     WHERE step = 'rag_trace'
       AND created_at >= NOW() - INTERVAL '14 days'`,
  );

  const embedWindow = await db.query<{
    total_chunks: string;
    policy_valid_chunks: string;
    invalid_non_sent_chunks: string;
    invalid_untouched_app_chunks: string;
    invalid_unverified_sent_chunks: string;
  }>(
    `SELECT
       COUNT(*)::text AS total_chunks,
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
     JOIN emails e ON e.id = em.email_id`,
  );

  const pipelineWindow = await db.query<{
    active_embed_jobs: string;
    ineligible_active_embed_jobs: string;
    embedded_status_without_chunks: string;
    eligible_sent_pending_or_failed: string;
    eligible_sent_embedded: string;
  }>(
    `SELECT
       (
         SELECT COUNT(*)::text
         FROM job_queue jq
         WHERE jq.job_type = 'embed_email'
           AND jq.status IN ('pending', 'processing')
       ) AS active_embed_jobs,
       (
         SELECT COUNT(*)::text
         FROM job_queue jq
         JOIN emails e ON e.id = (jq.payload->>'emailId')::int
         WHERE jq.job_type = 'embed_email'
           AND jq.status IN ('pending', 'processing')
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
       ) AS ineligible_active_embed_jobs,
       (
         SELECT COUNT(*)::text
         FROM emails e
         WHERE e.source = 'sent'
           AND e.embedding_status = 'embedded'
           AND NOT EXISTS (SELECT 1 FROM email_embeddings em WHERE em.email_id = e.id)
       ) AS embedded_status_without_chunks,
       (
         SELECT COUNT(*)::text
         FROM emails e
         WHERE e.source = 'sent'
           AND e.embedding_status IN ('pending', 'failed')
           AND (
             (
               COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
               AND COALESCE(e.parsed_content->>'user_edited', 'false') = 'true'
             )
             OR (
               COALESCE(e.parsed_content->>'app_generated', 'false') <> 'true'
               AND (
                 COALESCE(e.parsed_content->>'sent_by_user', 'false') = 'true'
                 OR COALESCE(e.parsed_content->>'user_edited', 'false') = 'true'
               )
             )
           )
       ) AS eligible_sent_pending_or_failed,
       (
         SELECT COUNT(*)::text
         FROM emails e
         WHERE e.source = 'sent'
           AND e.embedding_status = 'embedded'
           AND (
             (
               COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
               AND COALESCE(e.parsed_content->>'user_edited', 'false') = 'true'
             )
             OR (
               COALESCE(e.parsed_content->>'app_generated', 'false') <> 'true'
               AND (
                 COALESCE(e.parsed_content->>'sent_by_user', 'false') = 'true'
                 OR COALESCE(e.parsed_content->>'user_edited', 'false') = 'true'
               )
             )
           )
       ) AS eligible_sent_embedded`,
  );

  const rag = ragWindow.rows[0];
  const traces = traceWindow.rows[0];
  const embed = embedWindow.rows[0];
  const pipeline = pipelineWindow.rows[0];

  const totalChunks = toNumber(embed?.total_chunks);
  const invalidChunks =
    toNumber(embed?.invalid_non_sent_chunks) +
    toNumber(embed?.invalid_untouched_app_chunks) +
    toNumber(embed?.invalid_unverified_sent_chunks);
  const purityScore = totalChunks > 0 ? Math.max(0, (totalChunks - invalidChunks) / totalChunks) : 1;

  console.log("RAG_CREDIBILITY", {
    sampled_emails: toNumber(rag?.sampled_emails),
    avg_confidence: Number(toNumber(rag?.avg_confidence).toFixed(4)),
    context_hit_rate: Number(toNumber(rag?.context_hit_rate).toFixed(4)),
    conflict_rate: Number(toNumber(rag?.conflict_rate).toFixed(4)),
    low_confidence_rate: Number(toNumber(rag?.low_confidence_rate).toFixed(4)),
  });

  console.log("RAG_TRACE_14D", {
    sampled_traces: toNumber(traces?.sampled_traces),
    unknown_intent_rate: Number(toNumber(traces?.unknown_intent_rate).toFixed(4)),
    retrieval_failure_rate: Number(toNumber(traces?.retrieval_failure_rate).toFixed(4)),
    usage_failure_rate: Number(toNumber(traces?.usage_failure_rate).toFixed(4)),
    synthesis_failure_rate: Number(toNumber(traces?.synthesis_failure_rate).toFixed(4)),
  });

  console.log("EMBEDDING_INTEGRITY", {
    total_chunks: totalChunks,
    policy_valid_chunks: toNumber(embed?.policy_valid_chunks),
    invalid_non_sent_chunks: toNumber(embed?.invalid_non_sent_chunks),
    invalid_untouched_app_chunks: toNumber(embed?.invalid_untouched_app_chunks),
    invalid_unverified_sent_chunks: toNumber(embed?.invalid_unverified_sent_chunks),
    invalid_chunks: invalidChunks,
    purity_score: Number(purityScore.toFixed(4)),
  });

  console.log("PIPELINE_LOGIC_CHECK", {
    active_embed_jobs: toNumber(pipeline?.active_embed_jobs),
    ineligible_active_embed_jobs: toNumber(pipeline?.ineligible_active_embed_jobs),
    embedded_status_without_chunks: toNumber(pipeline?.embedded_status_without_chunks),
    eligible_sent_pending_or_failed: toNumber(pipeline?.eligible_sent_pending_or_failed),
    eligible_sent_embedded: toNumber(pipeline?.eligible_sent_embedded),
  });
}

main()
  .catch((error) => {
    console.error("RAG_AUDIT_FAILED", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end().catch(() => {
      // ignore cleanup failure in ad-hoc diagnostics
    });
  });
