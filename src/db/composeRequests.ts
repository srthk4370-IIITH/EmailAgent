import { db } from "./client";

export interface ComposeRequest {
  id: number;
  trace_id: string;
  category: string;
  context: string;
  status: string;
}

export async function createComposeRequest(input: {
  traceId: string;
  category: string;
  context: string;
}): Promise<ComposeRequest> {
  const result = await db.query<ComposeRequest>(
    `
      INSERT INTO compose_requests (trace_id, category, context, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING *
    `,
    [input.traceId, input.category, input.context],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to create compose request");
  return row;
}

export async function claimComposeRequest(): Promise<ComposeRequest | null> {
  const result = await db.query<ComposeRequest>(
    `
      UPDATE compose_requests
      SET status = 'processing', updated_at = NOW()
      WHERE id = (
        SELECT id FROM compose_requests
        WHERE status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      )
      RETURNING *
    `,
  );
  return result.rows[0] ?? null;
}

export async function markComposeRequestDone(id: number): Promise<void> {
  await db.query("UPDATE compose_requests SET status = 'done', updated_at = NOW() WHERE id = $1", [id]);
}

export async function markComposeRequestError(id: number, error: string): Promise<void> {
  await db.query(
    "UPDATE compose_requests SET status = 'error', updated_at = NOW() WHERE id = $1",
    [id],
  );
  void error;
}

