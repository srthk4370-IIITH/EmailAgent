import { db } from "./client";
import { withRetrievalCache } from "../lib/runtimeCache";

export interface SearchOptions {
  chunkTypes?: string[];
  maxDistance?: number;
  datasetVersion?: number;
  accountId?: number | null | undefined;
}

export interface EmbeddingRow {
  chunk_id: number;
  email_id: number;
  chunk_text: string;
  chunk_type: string;
  sender_type: string;
  topic: string | null;
  thread_id: string | null;
  distance: number;
  subject: string;
  embedding: number[];
  success_score: number;
  log_retrieved: number;
  created_at?: string;
}

export async function insertEmbedding(
  emailId: number,
  chunkText: string,
  embedding: number[],
  chunkType: string = "unknown",
  senderType: string = "unknown",
  topic: string | null = null,
  threadId: string | null = null,
  contentHash: string | null = null,
  accountId?: number | null,
  systemId?: number | null,
): Promise<void> {
  await db.query(
    `INSERT INTO email_embeddings (email_id, system_id, account_id, chunk_text, embedding, chunk_type, sender_type, topic, thread_id, content_hash)
     VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10)`,
    [
      emailId,
      systemId ?? null,
      accountId ?? null,
      chunkText,
      `[${embedding.join(",")}]`,
      chunkType,
      senderType,
      topic,
      threadId,
      contentHash,
    ],
  );
  await bumpEmbeddingDatasetVersion();
}

/** Check if an embedding already exists for this email + chunk combination. */
export async function embeddingExists(emailId: number, chunkText: string): Promise<boolean> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM email_embeddings WHERE email_id = $1 AND chunk_text = $2`,
    [emailId, chunkText],
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

export async function embeddingExistsByContentHash(contentHash: string): Promise<boolean> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM email_embeddings WHERE content_hash = $1`,
    [contentHash],
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

export async function deleteEmbeddingsByEmailId(emailId: number): Promise<void> {
  await db.query("DELETE FROM email_embeddings WHERE email_id = $1", [emailId]);
  await bumpEmbeddingDatasetVersion();
}

export async function listEmbeddingsForEmail(emailId: number): Promise<Array<{
  id: number;
  chunk_text: string;
  chunk_type: string;
  content_hash: string | null;
  created_at: string;
}>> {
  const result = await db.query<{
    id: number;
    chunk_text: string;
    chunk_type: string;
    content_hash: string | null;
    created_at: string;
  }>(
    `SELECT id, chunk_text, chunk_type, content_hash, created_at
     FROM email_embeddings
     WHERE email_id = $1
     ORDER BY id ASC`,
    [emailId],
  );
  return result.rows;
}

export async function getEmbeddingCountsForEmailIds(emailIds: number[]): Promise<Map<number, number>> {
  if (emailIds.length === 0) return new Map();
  const result = await db.query<{ email_id: number; count: string }>(
    `SELECT email_id, COUNT(*)::text AS count
     FROM email_embeddings
     WHERE email_id = ANY($1::int[])
     GROUP BY email_id`,
    [emailIds],
  );
  return new Map(result.rows.map((row) => [row.email_id, Number(row.count)]));
}

export async function getEmbeddingDatasetVersion(): Promise<number> {
  const result = await db.query<{ embedding_dataset_version: string }>(
    `SELECT embedding_dataset_version::text AS embedding_dataset_version
     FROM config
     WHERE id = 1
     LIMIT 1`,
  );
  return Number(result.rows[0]?.embedding_dataset_version ?? 0);
}

export async function bumpEmbeddingDatasetVersion(): Promise<void> {
  await db.query(
    `UPDATE config
     SET embedding_dataset_version = embedding_dataset_version + 1,
         updated_at = NOW()
     WHERE id = 1`,
  );
}

export async function searchNearestEmbeddings(
  queryEmbedding: number[],
  limit = 5,
  options?: SearchOptions,
): Promise<EmbeddingRow[]> {
  const datasetVersion = options?.datasetVersion ?? await getEmbeddingDatasetVersion();

  return withRetrievalCache(
    [
      "nearest-embeddings",
      limit,
      options?.maxDistance ?? "none",
      (options?.chunkTypes ?? []).join(","),
      queryEmbedding.join(","),
    ],
    datasetVersion,
    async () => {
      const vecStr = `[${queryEmbedding.join(",")}]`;
      const params: unknown[] = [vecStr, limit];
      const conditions: string[] = [
        "emails.source = 'sent'",
        `(
          (
            COALESCE(emails.parsed_content->>'app_generated', 'false') = 'true'
            AND COALESCE(emails.parsed_content->>'user_edited', 'false') = 'true'
          )
          OR
          (
            COALESCE(emails.parsed_content->>'app_generated', 'false') <> 'true'
            AND (
              COALESCE(emails.parsed_content->>'sent_by_user', 'false') = 'true'
              OR COALESCE(emails.parsed_content->>'user_edited', 'false') = 'true'
            )
          )
        )`,
      ];

      if (options?.accountId != null) {
        params.push(options.accountId);
        conditions.push(`emails.account_id = $${params.length}`);
      }

      if (options?.chunkTypes && options.chunkTypes.length > 0) {
        params.push(options.chunkTypes);
        conditions.push(`email_embeddings.chunk_type = ANY($${params.length}::text[])`);
      }

      if (options?.maxDistance !== undefined) {
        conditions.push(`(email_embeddings.embedding <=> $1::vector) <= ${options.maxDistance}`);
      }

      const whereClause = conditions.join("\n       AND ");

      const result = await db.query<{
        chunk_id: number;
        email_id: number;
        chunk_text: string;
        chunk_type: string;
        sender_type: string;
        topic: string | null;
        thread_id: string | null;
        distance: number;
        subject: string;
        created_at: string;
        embedding_str: string;
        success_score: number;
        log_retrieved: number;
      }>(
        `SELECT
           email_embeddings.id AS chunk_id,
           email_embeddings.email_id,
           email_embeddings.chunk_text,
           email_embeddings.chunk_type,
           email_embeddings.sender_type,
           email_embeddings.topic,
           email_embeddings.thread_id,
           (email_embeddings.embedding <=> $1::vector) AS distance,
           emails.subject,
           email_embeddings.created_at,
           email_embeddings.embedding::text AS embedding_str,
           COALESCE(chunk_feedback.helpful_count::float / NULLIF(chunk_feedback.retrieved_count, 0), 0) AS success_score,
           COALESCE(LN(chunk_feedback.retrieved_count + 1), 0) AS log_retrieved
         FROM email_embeddings
         JOIN emails ON emails.id = email_embeddings.email_id
         LEFT JOIN chunk_feedback ON chunk_feedback.chunk_id = email_embeddings.id
         WHERE ${whereClause}
         ORDER BY email_embeddings.embedding <=> $1::vector
         LIMIT $2`,
        params,
      );

      return result.rows.map((row) => ({
        ...row,
        embedding: JSON.parse(row.embedding_str),
      }));
    },
  );
}

async function getRagChunkIdsForEmail(emailId: number): Promise<number[]> {
  const result = await db.query<{ rag_context: unknown }>(
    "SELECT rag_context FROM emails WHERE id = $1 LIMIT 1",
    [emailId],
  );
  const ctx = result.rows[0]?.rag_context;
  if (!Array.isArray(ctx)) return [];
  return ctx
    .map((item) => (item && typeof item === "object" ? Number((item as { chunk_id?: unknown }).chunk_id) : NaN))
    .filter((id) => Number.isFinite(id) && id > 0);
}

async function bumpChunkFeedback(
  chunkId: number,
  deltas: { retrieved?: number; used?: number; helpful?: number },
): Promise<void> {
  await db.query(
    `INSERT INTO chunk_feedback (chunk_id, retrieved_count, used_count, helpful_count, last_updated)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (chunk_id)
     DO UPDATE SET
       retrieved_count = chunk_feedback.retrieved_count + EXCLUDED.retrieved_count,
       used_count = chunk_feedback.used_count + EXCLUDED.used_count,
       helpful_count = chunk_feedback.helpful_count + EXCLUDED.helpful_count,
       last_updated = NOW()`,
    [chunkId, deltas.retrieved ?? 0, deltas.used ?? 0, deltas.helpful ?? 0],
  );
}

export async function recordRagRetrievalForEmail(emailId: number): Promise<void> {
  const chunkIds = await getRagChunkIdsForEmail(emailId);
  await Promise.all(chunkIds.map((chunkId) => bumpChunkFeedback(chunkId, { retrieved: 1 })));
}

export async function applyRagFeedbackForEmail(
  emailId: number,
  outcome: "accepted" | "edited" | "rejected" | "regenerated",
): Promise<void> {
  const chunkIds = await getRagChunkIdsForEmail(emailId);
  if (chunkIds.length === 0) return;

  const deltas =
    outcome === "accepted"
      ? { used: 1, helpful: 1 }
      : outcome === "edited"
      ? { used: 1 }
      : outcome === "rejected"
      ? { used: 1, retrieved: 1 }
      : { used: 1, retrieved: 1 };

  await Promise.all(chunkIds.map((chunkId) => bumpChunkFeedback(chunkId, deltas)));
}
