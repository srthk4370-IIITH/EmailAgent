import { db } from "./client";

export interface IdempotencyRecord {
  status_code: number;
  response_json: unknown;
}

export async function getIdempotentResponse(
  emailId: number,
  action: string,
  idempotencyKey: string,
): Promise<IdempotencyRecord | null> {
  const result = await db.query<IdempotencyRecord>(
    `SELECT status_code, response_json
     FROM action_idempotency
     WHERE email_id = $1 AND action = $2 AND idempotency_key = $3
     LIMIT 1`,
    [emailId, action, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

export async function saveIdempotentResponse(
  emailId: number,
  action: string,
  idempotencyKey: string,
  statusCode: number,
  payload: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO action_idempotency (email_id, action, idempotency_key, status_code, response_json)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (email_id, action, idempotency_key)
     DO NOTHING`,
    [emailId, action, idempotencyKey, statusCode, JSON.stringify(payload)],
  );
}
