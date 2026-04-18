import { db, initDbSchema } from "../db/client";
import { getEmailById } from "../db/emails";
import { claimNextJob, completeJob, enqueueJob, failJob } from "../db/jobs";
import { logStep, logger } from "../utils/logger";
import { indexEmailForRag } from "./rag";

function jobDedupeKey(jobType: "embed_email", payload: { emailId: number }): string {
  return `${jobType}:${payload.emailId}`;
}

let schemaReady: Promise<void> | null = null;
let schemaVerified = false;

async function hasQueueSchema(): Promise<boolean> {
  const res = await db.query<{
    job_queue: string | null;
    logs: string | null;
    emails: string | null;
  }>(
    `SELECT
       to_regclass('public.job_queue')::text AS job_queue,
       to_regclass('public.logs')::text AS logs,
       to_regclass('public.emails')::text AS emails`,
  );
  const row = res.rows[0];
  return Boolean(row?.job_queue && row?.logs && row?.emails);
}

async function ensureQueueSchema(): Promise<void> {
  if (schemaVerified) {
    return;
  }

  if (await hasQueueSchema()) {
    schemaVerified = true;
    return;
  }

  schemaReady ??= initDbSchema();
  await schemaReady;
  schemaVerified = true;
}

export async function queueEmbeddingJob(
  emailId: number,
  traceId?: string | null,
  scope?: { accountId?: number | null; systemId?: number | null; priority?: number },
): Promise<void> {
  await ensureQueueSchema();
  await enqueueJob({
    jobType: "embed_email",
    payload: { emailId },
    traceId: traceId ?? null,
    dedupeKey: jobDedupeKey("embed_email", { emailId }),
    accountId: scope?.accountId ?? null,
    systemId: scope?.systemId ?? null,
    priority: scope?.priority ?? 5,
  });
}

async function handleEmbedEmailJob(job: Awaited<ReturnType<typeof claimNextJob>>): Promise<void> {
  if (!job) return;
  const emailId = Number(job.payload.emailId);
  if (!Number.isFinite(emailId)) {
    throw new Error("embed_email job missing emailId");
  }

  const email = await getEmailById(emailId);
  if (!email) {
    logger.warn("Job skipped: email not found", { jobId: job.id, emailId });
    return;
  }

  await indexEmailForRag(email);
  const updatedEmail = await getEmailById(emailId);

  await logStep({
    trace_id: job.trace_id ?? updatedEmail?.trace_id ?? email.trace_id ?? `job_${job.id}`,
    gmail_id: updatedEmail?.gmail_id ?? email.gmail_id,
    step: "EMAIL_EMBED_QUEUED_COMPLETE",
    state: updatedEmail?.state ?? email.state,
    latency_ms: 0,
    meta: { job_id: job.id, email_id: email.id, embedding_status: updatedEmail?.embedding_status ?? email.embedding_status },
  });
}

export async function processQueuedJobs(limit = 5): Promise<number> {
  await ensureQueueSchema();
  let processed = 0;

  for (let i = 0; i < limit; i += 1) {
    const job = await claimNextJob();
    if (!job) break;

    try {
      if (job.job_type === "embed_email") {
        await handleEmbedEmailJob(job);
      }
      await completeJob(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "job_failed";
      logger.error("Background job failed", {
        jobId: job.id,
        jobType: job.job_type,
        message,
      });
      await failJob(job.id, message);
    }

    processed += 1;
  }

  return processed;
}
