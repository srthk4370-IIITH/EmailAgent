import { db } from "./client";

export async function countStuckProcessingEmails(): Promise<number> {
  const result = await db.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count FROM emails
      WHERE state = 'PROCESSING'
        AND updated_at < NOW() - INTERVAL '2 minutes'
    `,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Extra rows beyond unique gmail_ids (0 when all gmail_id values are unique). */
export async function countDuplicateGmailIds(): Promise<number> {
  const result = await db.query<{ count: string }>(
    `
      SELECT COALESCE(SUM(group_count - 1), 0)::text AS count
      FROM (
        SELECT COUNT(*)::int AS group_count
        FROM emails
        WHERE gmail_id IS NOT NULL
          AND gmail_id <> ''
        GROUP BY account_id, gmail_id
        HAVING COUNT(*) > 1
      ) duplicate_groups
    `,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getLastEmailActivityAt(): Promise<string | null> {
  const result = await db.query<{ max: Date | null }>(
    `SELECT MAX(updated_at) AS max FROM emails`,
  );
  const max = result.rows[0]?.max;
  return max ? max.toISOString() : null;
}

export async function getAvgProcessingTimeMs(): Promise<number> {
  const result = await db.query<{ avg: string | null }>(
    `
      SELECT AVG(llm_latency_ms)::text AS avg
      FROM emails
      WHERE llm_latency_ms IS NOT NULL
        AND updated_at > NOW() - INTERVAL '1 hour'
    `,
  );
  return Number(result.rows[0]?.avg ?? 0);
}

/** Pipeline completions: reached review / send / sent in the last minute. */
export async function countEmailsCompletedLastMinute(): Promise<number> {
  const result = await db.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM emails
      WHERE state IN ('AWAITING_REVIEW', 'READY_TO_SEND', 'SENT')
        AND updated_at > NOW() - INTERVAL '1 minute'
    `,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Emails with multiple claims (re-queued) touched recently — lease pressure signal. */
export async function countLeaseConflicts(): Promise<number> {
  const result = await db.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM emails
      WHERE processing_version > 1
        AND updated_at > NOW() - INTERVAL '10 minutes'
    `,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function countEmailsInProcessing(): Promise<number> {
  const result = await db.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM emails
      WHERE state = 'PROCESSING'
    `,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Backlog queue depth: emails waiting to be claimed for processing. */
export async function countEmailsIngestedQueueDepth(): Promise<number> {
  const result = await db.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM emails
      WHERE state = 'INGESTED'
    `,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** LLM failures: emails where generation/classification fell back within the last hour. */
export async function getLlmFailureRateLastHour(): Promise<number> {
  const result = await db.query<{ failures: string; total: string }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE prompt_version ILIKE '%fallback%')::text AS failures,
        COUNT(*)::text AS total
      FROM emails
      WHERE updated_at > NOW() - INTERVAL '1 hour'
        AND prompt_version IS NOT NULL
    `,
  );
  const failures = Number(result.rows[0]?.failures ?? 0);
  const total = Number(result.rows[0]?.total ?? 0);
  if (total === 0) return 0;
  return failures / total;
}

export async function getLlmCircuitBreakerActive(): Promise<boolean> {
  const result = await db.query<{ llm_circuit_open: boolean }>(
    `SELECT llm_circuit_open FROM config WHERE id = 1 LIMIT 1`,
  );
  return Boolean(result.rows[0]?.llm_circuit_open ?? false);
}

/**
 * Mean wall time from ingest to last update for emails that reached review/send recently.
 */
export async function getAvgEndToEndTimeMs(): Promise<number> {
  const result = await db.query<{ avg: string | null }>(
    `
      SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000)::text AS avg
      FROM emails
      WHERE state IN ('AWAITING_REVIEW', 'READY_TO_SEND', 'SENT')
        AND updated_at > NOW() - INTERVAL '24 hours'
    `,
  );
  return Number(result.rows[0]?.avg ?? 0);
}

/** Share of emails in error states among those updated in the last hour. Null-safe. */
export async function getEmailErrorRateLastHour(): Promise<number> {
  const result = await db.query<{ err: string; tot: string }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE state IN ('ERROR_TEMP', 'ERROR_FATAL', 'DEAD'))::text AS err,
        COUNT(*)::text AS tot
      FROM emails
      WHERE updated_at > NOW() - INTERVAL '1 hour'
    `,
  );
  const err = Number(result.rows[0]?.err ?? 0);
  const tot = Number(result.rows[0]?.tot ?? 0);
  if (tot === 0) return 0;
  return err / tot;
}
