import { db } from "./client";

export type JobType = "embed_email";
export type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface JobRecord {
  id: number;
  system_id?: number | null;
  account_id?: number | null;
  job_type: JobType;
  status: JobStatus;
  trace_id: string | null;
  dedupe_key: string | null;
  priority: number;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  available_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function enqueueJob(input: {
  jobType: JobType;
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  traceId?: string | null;
  availableAt?: Date;
  priority?: number;
  systemId?: number | null;
  accountId?: number | null;
}): Promise<JobRecord | null> {
  // If dedupeKey is provided, check if an active job already exists
  // If no dedupeKey, always insert (allow duplicates for non-keyed jobs)
  if (input.dedupeKey) {
    const result = await db.query<JobRecord>(
      `
        WITH existing AS (
          SELECT id
          FROM job_queue
          WHERE job_type = $1
            AND dedupe_key = $5
            AND status IN ('pending', 'processing')
          LIMIT 1
        ),
        inserted AS (
          INSERT INTO job_queue (job_type, system_id, account_id, trace_id, dedupe_key, payload, available_at, priority)
          SELECT $1, $2, $3, $4, $5, $6::jsonb, $7, $8
          WHERE NOT EXISTS (SELECT 1 FROM existing)
          RETURNING *
        )
        SELECT * FROM inserted
        UNION ALL
        SELECT * FROM job_queue WHERE id IN (SELECT id FROM existing)
        LIMIT 1
      `,
      [
        input.jobType,
        input.systemId ?? null,
        input.accountId ?? null,
        input.traceId ?? null,
        input.dedupeKey,
        JSON.stringify(input.payload),
        input.availableAt ?? new Date(),
        Math.max(1, Math.min(10, input.priority ?? 5)),
      ],
    );
    return result.rows[0] ?? null;
  } else {
    // No dedupe key: always insert as pending
    const result = await db.query<JobRecord>(
      `INSERT INTO job_queue (job_type, system_id, account_id, trace_id, dedupe_key, payload, available_at, priority)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING *`,
      [
        input.jobType,
        input.systemId ?? null,
        input.accountId ?? null,
        input.traceId ?? null,
        input.dedupeKey ?? null,
        JSON.stringify(input.payload),
        input.availableAt ?? new Date(),
        Math.max(1, Math.min(10, input.priority ?? 5)),
      ],
    );
    return result.rows[0] ?? null;
  }
}

export async function claimNextJob(): Promise<JobRecord | null> {
  const result = await db.query<JobRecord>(
    `WITH next_job AS (
       SELECT id
       FROM job_queue
       WHERE status = 'pending'
         AND available_at <= NOW()
       ORDER BY priority DESC, available_at ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE job_queue
     SET status = 'processing',
         started_at = NOW(),
         attempts = attempts + 1,
         updated_at = NOW()
     WHERE id IN (SELECT id FROM next_job)
     RETURNING *`,
  );

  return result.rows[0] ?? null;
}

export async function completeJob(id: number): Promise<void> {
  await db.query(
    `UPDATE job_queue
     SET status = 'completed',
         completed_at = NOW(),
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

export async function failJob(id: number, error: string, retryAfterMs = 15_000): Promise<void> {
  const current = await db.query<{ attempts: number; max_attempts: number }>(
    `SELECT attempts, max_attempts
     FROM job_queue
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  const row = current.rows[0];
  if (!row) return;

  const shouldRetry = row.attempts < row.max_attempts;
  if (shouldRetry) {
    const exponentialBackoff = Math.min(120_000, retryAfterMs * Math.max(1, 2 ** Math.max(0, row.attempts - 1)));
    const jitter = Math.floor(Math.random() * 2_500);
    await db.query(
      `UPDATE job_queue
       SET status = 'pending',
           last_error = $2,
           available_at = NOW() + ($3 || ' milliseconds')::interval,
           updated_at = NOW()
       WHERE id = $1`,
      [id, error, String(exponentialBackoff + jitter)],
    );
    return;
  }

  await db.query(
    `UPDATE job_queue
     SET status = 'failed',
         last_error = $2,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [id, error],
  );
}

export async function countJobsByStatus(jobType?: JobType): Promise<Record<JobStatus, number>> {
  const result = await db.query<{ status: JobStatus; count: string }>(
    `SELECT status, COUNT(*)::text AS count
     FROM job_queue
     ${jobType ? "WHERE job_type = $1" : ""}
     GROUP BY status`,
    jobType ? [jobType] : [],
  );

  return result.rows.reduce<Record<JobStatus, number>>(
    (acc, row) => {
      acc[row.status] = Number(row.count);
      return acc;
    },
    { pending: 0, processing: 0, completed: 0, failed: 0 },
  );
}
