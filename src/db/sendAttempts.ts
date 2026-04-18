import { db } from "./client";

export async function claimSendAttempt(sendKey: string, emailId: number, accountId?: number | null): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO send_attempts (account_id, email_id, send_key, status)
     VALUES ($1, $2, $3, 'started')
     ON CONFLICT (send_key) DO UPDATE
     SET account_id = EXCLUDED.account_id,
         email_id = EXCLUDED.email_id,
         status = 'started',
         updated_at = NOW()
     WHERE send_attempts.status = 'failed'
     RETURNING id`,
    [accountId ?? null, emailId, sendKey],
  );
  return Boolean(result.rows[0]);
}

export async function getSendAttemptStatus(sendKey: string): Promise<"started" | "failed" | "sent" | null> {
  const result = await db.query<{ status: string }>(
    "SELECT status FROM send_attempts WHERE send_key = $1 LIMIT 1",
    [sendKey],
  );

  const status = result.rows[0]?.status;
  if (status === "started" || status === "failed" || status === "sent") {
    return status;
  }
  return null;
}

export async function completeSendAttempt(sendKey: string): Promise<void> {
  await db.query("UPDATE send_attempts SET status = 'sent', updated_at = NOW() WHERE send_key = $1", [sendKey]);
}

export async function failSendAttempt(sendKey: string): Promise<void> {
  await db.query("UPDATE send_attempts SET status = 'failed', updated_at = NOW() WHERE send_key = $1", [sendKey]);
}

export interface StaleSendRecovery {
  email_id: number;
  send_key: string;
}

export async function recoverStaleSendAttempts(staleSeconds = 180): Promise<StaleSendRecovery[]> {
  const result = await db.query<StaleSendRecovery>(
    `
      WITH stale AS (
        SELECT sa.email_id, sa.send_key
        FROM send_attempts sa
        WHERE sa.status = 'started'
          AND sa.updated_at < NOW() - ($1::text || ' seconds')::interval
      ), mark_failed AS (
        UPDATE send_attempts sa
        SET status = 'failed', updated_at = NOW()
        FROM stale s
        WHERE sa.send_key = s.send_key
        RETURNING sa.email_id, sa.send_key
      )
      UPDATE emails e
      SET state = CASE WHEN e.state = 'READY_TO_SEND' THEN 'AWAITING_REVIEW' ELSE e.state END,
          last_step = CASE WHEN e.state = 'READY_TO_SEND' THEN 'send_recovery_stale_attempt' ELSE e.last_step END,
          updated_at = NOW()
      FROM mark_failed m
      WHERE e.id = m.email_id
      RETURNING m.email_id, m.send_key
    `,
    [staleSeconds],
  );

  return result.rows;
}
