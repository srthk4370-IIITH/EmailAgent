import { db } from "./client";

type ThreadMessage = {
  from: string;
  subject: string;
  body: string;
  internal_date: number | null;
  message_id?: string | null;
  snippet?: string | null;
};

function normalizeThreadMessage(message: unknown): ThreadMessage | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  const from = typeof record.from === "string" ? record.from : "";
  const subject = typeof record.subject === "string" ? record.subject : "";
  const body = typeof record.body === "string" ? record.body : "";
  const rawDate = record.internal_date ?? record.internalDate;
  const internalDate = typeof rawDate === "number" && Number.isFinite(rawDate)
    ? rawDate
    : typeof rawDate === "string" && Number.isFinite(Number(rawDate))
      ? Number(rawDate)
      : null;
  const snippet = typeof record.snippet === "string" ? record.snippet : null;
  const messageId = typeof record.message_id === "string" ? record.message_id : null;

  return { from, subject, body, internal_date: internalDate, message_id: messageId, snippet };
}

export async function upsertThread(
  threadId: string,
  messages: unknown[],
  accountId?: number | null,
  systemId?: number | null,
): Promise<void> {
  // Use CTE-based upsert to avoid ON CONFLICT with partial unique index
  // which PostgreSQL doesn't allow. This handles both NULL and non-NULL account_id.
  await db.query(
    `
      WITH existing AS (
        SELECT id
        FROM email_threads
        WHERE thread_id = $2
          AND (
            ($1::integer IS NULL AND account_id IS NULL)
            OR account_id = $1::integer
          )
        LIMIT 1
      ),
      updated AS (
        UPDATE email_threads
        SET messages = $3::jsonb, updated_at = NOW()
        WHERE id IN (SELECT id FROM existing)
        RETURNING id
      )
      INSERT INTO email_threads (account_id, system_id, thread_id, messages)
      SELECT $1, $4, $2, $3::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM existing)
    `,
    [accountId ?? null, threadId, JSON.stringify(messages), systemId ?? null],
  );
}

export async function getThreadMessages(threadId: string, lastN = 5, accountId?: number | null): Promise<unknown[]> {
  const result = accountId
    ? await db.query<{ messages: unknown[] }>(
        "SELECT messages FROM email_threads WHERE thread_id = $1 AND account_id = $2 LIMIT 1",
        [threadId, accountId],
      )
    : await db.query<{ messages: unknown[] }>(
        "SELECT messages FROM email_threads WHERE thread_id = $1 ORDER BY id DESC LIMIT 1",
        [threadId],
      );
  const messages = result.rows[0]?.messages ?? [];
  const normalized = Array.isArray(messages)
    ? messages.map((message) => normalizeThreadMessage(message)).filter((message): message is ThreadMessage => message != null)
    : [];
  const sorted = normalized.sort((a, b) => (a.internal_date ?? 0) - (b.internal_date ?? 0));
  return sorted.slice(-lastN);
}
