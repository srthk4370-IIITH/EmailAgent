import { db } from "./client";

export interface DraftRecord {
  id: number;
  email_id: number;
  reply: string;
  edited_body: string | null;
  status: string;
  is_fallback?: boolean;
  updated_at?: Date;
}

function normalizeDraftReply(reply: string): string {
  // Drafts store plain text; ensure we never persist null-ish values.
  return (reply ?? "").toString();
}

function pendingUpsertQuery() {
  // Ensure 1 email -> exactly 1 active draft row via unique_email_draft.
  // If a draft was already approved, we still keep it approved to avoid breaking manual approvals.
  return `
    INSERT INTO drafts (email_id, reply, edited_body, status, is_fallback, updated_at)
    VALUES ($1, $2, NULL, 'pending', $3, NOW())
    ON CONFLICT (email_id) DO UPDATE SET
      reply = CASE WHEN drafts.status = 'approved' THEN drafts.reply ELSE EXCLUDED.reply END,
      edited_body = CASE WHEN drafts.status = 'approved' THEN drafts.edited_body ELSE NULL END,
      status = CASE WHEN drafts.status = 'approved' THEN 'approved' ELSE 'pending' END,
      is_fallback = CASE WHEN drafts.status = 'approved' THEN drafts.is_fallback ELSE EXCLUDED.is_fallback END,
      updated_at = NOW()
    RETURNING *
  `;
}

/** Draft creation path for recovered/fallback generation. */
export async function createDraftFallback(emailId: number, reply: string): Promise<DraftRecord | void> {
  const result = await db.query<DraftRecord>(pendingUpsertQuery(), [emailId, normalizeDraftReply(reply), true]);
  return result.rows[0] ?? undefined;
}

/** Draft creation path for normal generation. */
export async function createDraft(emailId: number, reply: string, isFallback = false): Promise<DraftRecord> {
  const result = await db.query<DraftRecord>(pendingUpsertQuery(), [emailId, normalizeDraftReply(reply), isFallback]);
  if (!result.rows[0]) throw new Error("Failed to upsert draft");
  return result.rows[0];
}

export async function listDrafts(): Promise<DraftRecord[]> {
  const result = await db.query<DraftRecord>("SELECT * FROM drafts ORDER BY id DESC");
  return result.rows;
}

export async function getDraftById(id: number): Promise<DraftRecord | null> {
  const result = await db.query<DraftRecord>("SELECT * FROM drafts WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] ?? null;
}

export async function getDraftByEmailId(emailId: number): Promise<DraftRecord | null> {
  const result = await db.query<DraftRecord>(
    "SELECT * FROM drafts WHERE email_id = $1 ORDER BY id DESC LIMIT 1",
    [emailId],
  );
  return result.rows[0] ?? null;
}

export async function markDraftSent(id: number): Promise<void> {
  await db.query("UPDATE drafts SET status = 'sent', updated_at = NOW() WHERE id = $1", [id]);
}

export async function approveDraft(id: number, editedBody?: string): Promise<void> {
  await db.query(
    "UPDATE drafts SET status = 'approved', edited_body = COALESCE($2, edited_body), updated_at = NOW() WHERE id = $1",
    [
    id,
    editedBody ?? null,
    ],
  );
}

export async function rejectDraft(id: number): Promise<void> {
  await db.query("UPDATE drafts SET status = 'rejected', updated_at = NOW() WHERE id = $1", [id]);
}

export async function deleteDraftsByEmailId(emailId: number): Promise<void> {
  await db.query("DELETE FROM drafts WHERE email_id = $1", [emailId]);
}

export async function deleteDraftById(id: number): Promise<void> {
  await db.query("DELETE FROM drafts WHERE id = $1", [id]);
}

export async function listDraftsActive(): Promise<DraftRecord[]> {
  const result = await db.query<DraftRecord>(
    `SELECT * FROM drafts WHERE status IN ('pending', 'approved') ORDER BY id DESC`,
  );
  return result.rows;
}

export async function updateDraftEditedBody(id: number, editedBody: string): Promise<void> {
  await db.query(`UPDATE drafts SET edited_body = $1 WHERE id = $2`, [editedBody, id]);
}
