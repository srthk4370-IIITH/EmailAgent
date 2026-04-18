import { db } from "./client";

export interface LogRecord {
  id: number;
  trace_id: string;
  gmail_id: string | null;
  step: string;
  state: string;
  latency_ms: number;
  error: string | null;
  meta: unknown;
  created_at: string;
}

export async function listLogsByTraceId(traceId: string): Promise<LogRecord[]> {
  const result = await db.query<LogRecord>("SELECT * FROM logs WHERE trace_id = $1 ORDER BY id ASC", [traceId]);
  return result.rows;
}

export interface ActivityLogRecord extends LogRecord {
  email_id?: number | null;
  subject?: string;
  source?: string;
  embedding_status?: string;
}

export async function listRecentLogs(limit = 100): Promise<ActivityLogRecord[]> {
  const result = await db.query<ActivityLogRecord>(
    `SELECT logs.*, emails.id AS email_id, emails.subject, emails.source, emails.embedding_status
     FROM logs
     LEFT JOIN emails ON emails.gmail_id = logs.gmail_id
     ORDER BY logs.id DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export type TraceLookupMatch = "exact" | "gmail_id" | "prefix" | "contains" | "none";

export interface TraceLookupResult {
  logs: LogRecord[];
  resolvedTraceId: string | null;
  candidates: string[];
  matchedBy: TraceLookupMatch;
  normalizedQuery: string;
}

function normalizeLookupToken(input: string): string {
  return input.trim().replace(/^["']+|["']+$/g, "");
}

function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

async function listTraceCandidates(token: string, mode: "prefix" | "contains"): Promise<string[]> {
  const escaped = escapeLikePattern(token);
  const pattern = mode === "prefix" ? `${escaped}%` : `%${escaped}%`;
  const result = await db.query<{ trace_id: string }>(
    `SELECT trace_id
     FROM logs
     WHERE trace_id ILIKE $1 ESCAPE '\\'
       AND trace_id IS NOT NULL
       AND trace_id <> ''
     GROUP BY trace_id
     ORDER BY MAX(id) DESC
     LIMIT 8`,
    [pattern],
  );
  return result.rows.map((row) => row.trace_id).filter((value) => value.length > 0);
}

export async function lookupLogsByTrace(query: string): Promise<TraceLookupResult> {
  const normalizedQuery = normalizeLookupToken(query);
  if (!normalizedQuery) {
    return {
      logs: [],
      resolvedTraceId: null,
      candidates: [],
      matchedBy: "none",
      normalizedQuery,
    };
  }

  const exact = await listLogsByTraceId(normalizedQuery);
  if (exact.length > 0) {
    return {
      logs: exact,
      resolvedTraceId: normalizedQuery,
      candidates: [normalizedQuery],
      matchedBy: "exact",
      normalizedQuery,
    };
  }

  const gmailTraceCandidates = await db.query<{ trace_id: string }>(
    `SELECT trace_id
     FROM logs
     WHERE gmail_id = $1
       AND trace_id IS NOT NULL
       AND trace_id <> ''
     GROUP BY trace_id
     ORDER BY MAX(id) DESC
     LIMIT 8`,
    [normalizedQuery],
  );
  const gmailCandidates = gmailTraceCandidates.rows.map((row) => row.trace_id).filter((value) => value.length > 0);
  if (gmailCandidates.length > 0) {
    const resolvedTraceId = gmailCandidates[0] ?? null;
    return {
      logs: resolvedTraceId ? await listLogsByTraceId(resolvedTraceId) : [],
      resolvedTraceId,
      candidates: gmailCandidates,
      matchedBy: "gmail_id",
      normalizedQuery,
    };
  }

  const prefixCandidates = await listTraceCandidates(normalizedQuery, "prefix");
  if (prefixCandidates.length > 0) {
    const resolvedTraceId = prefixCandidates[0] ?? null;
    return {
      logs: resolvedTraceId ? await listLogsByTraceId(resolvedTraceId) : [],
      resolvedTraceId,
      candidates: prefixCandidates,
      matchedBy: "prefix",
      normalizedQuery,
    };
  }

  if (normalizedQuery.length >= 6) {
    const containsCandidates = await listTraceCandidates(normalizedQuery, "contains");
    if (containsCandidates.length > 0) {
      const resolvedTraceId = containsCandidates[0] ?? null;
      return {
        logs: resolvedTraceId ? await listLogsByTraceId(resolvedTraceId) : [],
        resolvedTraceId,
        candidates: containsCandidates,
        matchedBy: "contains",
        normalizedQuery,
      };
    }
  }

  return {
    logs: [],
    resolvedTraceId: null,
    candidates: [],
    matchedBy: "none",
    normalizedQuery,
  };
}

export async function getEmbeddingsForEmail(emailId: number): Promise<Array<{ id: number; chunk_text: string; chunk_type: string; content_hash: string | null; created_at: string }>> {
  const result = await db.query<{ id: number; chunk_text: string; chunk_type: string; content_hash: string | null; created_at: string }>(
    "SELECT id, chunk_text, chunk_type, content_hash, created_at FROM email_embeddings WHERE id IN (SELECT id FROM email_embeddings WHERE email_id = $1) ORDER BY id ASC",
    [emailId],
  );
  return result.rows;
}

export async function saveLog(params: {
  traceId: string;
  gmailId?: string | null;
  step: string;
  state: string;
  latency_ms?: number;
  error?: string | null;
  meta?: unknown;
  subject?: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO logs (trace_id, gmail_id, step, state, latency_ms, error, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.traceId,
      params.gmailId ?? null,
      params.step,
      params.state,
      params.latency_ms ?? 0,
      params.error ?? null,
      JSON.stringify(params.meta ?? {}),
    ]
  );
}
