import { db } from "./client";
import type { AppError } from "../lib/errorNormalizer";

export type ErrorLogRecord = {
  id: number;
  code: string;
  category: "AUTH" | "RATE_LIMIT" | "DATA_INCONSISTENCY" | "NETWORK" | "API" | "STATE" | "UNKNOWN";
  message: string;
  reason: string;
  fix: string;
  severity: "low" | "medium" | "high" | "critical";
  retryable: boolean;
  auto_recoverable: boolean;
  source: string;
  route: string | null;
  operation: string | null;
  email_id: number | null;
  trace_id: string | null;
  meta: unknown;
  created_at: string;
};

export async function saveErrorLog(params: {
  error: AppError;
  source: "api" | "worker" | "ui" | "middleware";
  route?: string;
  operation?: string;
  emailId?: number | null;
  traceId?: string | null;
  meta?: unknown;
}): Promise<void> {
  await db.query(
    `INSERT INTO error_logs (
      code, category, message, reason, fix, severity, retryable, auto_recoverable, source, route, operation, email_id, trace_id, meta
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      params.error.code,
      params.error.category,
      params.error.message,
      params.error.reason,
      params.error.fix,
      params.error.severity,
      params.error.retryable,
      params.error.autoRecoverable,
      params.source,
      params.route ?? null,
      params.operation ?? null,
      params.emailId ?? null,
      params.traceId ?? null,
      JSON.stringify(params.meta ?? {}),
    ],
  );
}

export async function listRecentErrorLogs(limit = 200): Promise<ErrorLogRecord[]> {
  const result = await db.query<ErrorLogRecord>(
    `SELECT * FROM error_logs ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}
