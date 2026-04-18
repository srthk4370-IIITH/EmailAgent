/**
 * System Health — DB operations for tracking service status.
 *
 * Used by:
 * - Worker heartbeat (Fix 5)
 * - LLM circuit breaker (Fix 4 integration in llm.ts)
 * - Gmail sync status
 * - UI health bar (Fix 6)
 */

import { db } from "./client";

export type ServiceName = "openai" | "gmail" | "worker" | "db";
export type ServiceStatus = "ok" | "degraded" | "down" | "unknown";

export interface HealthRecord {
  service: string;
  status: ServiceStatus;
  last_checked_at: string;
  last_ok_at: string | null;
  error_message: string | null;
  meta: Record<string, unknown>;
  last_heartbeat_at: string | null;
}

/**
 * Update health status for a service.
 */
export async function updateServiceHealth(
  service: ServiceName,
  status: ServiceStatus,
  errorMessage?: string | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  const metaJson = meta ? JSON.stringify(meta) : "{}";

  if (status === "ok") {
    await db.query(
      `UPDATE system_health
       SET status = $2,
           error_message = NULL,
           meta = $3::jsonb,
           last_checked_at = NOW(),
           last_ok_at = NOW(),
           updated_at = NOW()
       WHERE service = $1`,
      [service, status, metaJson],
    );
  } else {
    await db.query(
      `UPDATE system_health
       SET status = $2,
           error_message = $3,
           meta = $4::jsonb,
           last_checked_at = NOW(),
           updated_at = NOW()
       WHERE service = $1`,
      [service, status, errorMessage ?? null, metaJson],
    );
  }
}

/**
 * Record a worker heartbeat.
 */
export async function recordWorkerHeartbeat(): Promise<void> {
  await db.query(
    `UPDATE system_health
     SET status = 'ok',
         last_heartbeat_at = NOW(),
         last_checked_at = NOW(),
         last_ok_at = NOW(),
         error_message = NULL,
         updated_at = NOW()
     WHERE service = 'worker'`,
  );
}

/**
 * Check if the worker is stale (no heartbeat for > staleSeconds).
 */
export async function isWorkerStale(staleSeconds = 120): Promise<boolean> {
  const result = await db.query<{ stale: boolean }>(
    `SELECT COALESCE(
       last_heartbeat_at < NOW() - ($1::text || ' seconds')::interval,
       true
     ) AS stale
     FROM system_health
     WHERE service = 'worker'
     LIMIT 1`,
    [staleSeconds],
  );
  return result.rows[0]?.stale ?? true;
}

/**
 * Get all service health statuses.
 */
export async function getAllHealthStatuses(): Promise<HealthRecord[]> {
  const result = await db.query<HealthRecord>(
    `SELECT service, status, last_checked_at::text, last_ok_at::text, error_message, meta, last_heartbeat_at::text
     FROM system_health
     ORDER BY service ASC`,
  );
  return result.rows;
}

/**
 * Detect Gmail health from the last sync timestamp.
 */
export async function checkGmailHealth(): Promise<void> {
  const result = await db.query<{ last_ok_at: string | null }>(
    `SELECT last_ok_at::text FROM system_health WHERE service = 'gmail' LIMIT 1`,
  );
  const lastOk = result.rows[0]?.last_ok_at;

  if (!lastOk) {
    await updateServiceHealth("gmail", "unknown", "No sync recorded yet");
    return;
  }

  const ageMs = Date.now() - new Date(lastOk).getTime();
  if (ageMs > 5 * 60 * 1000) {
    await updateServiceHealth("gmail", "degraded", `Last sync was ${Math.round(ageMs / 60000)} minutes ago`);
  }
}
