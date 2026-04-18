import { db } from "../src/db/client";
import { bumpEmbeddingDatasetVersion } from "../src/db/embeddings";

type IntegrityRow = {
  total_chunks: string;
  policy_valid_chunks: string;
  invalid_non_sent_chunks: string;
  invalid_untouched_app_chunks: string;
  invalid_unverified_sent_chunks: string;
};

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readIntegrity(): Promise<IntegrityRow | null> {
  const result = await db.query<IntegrityRow>(
    `SELECT
       COUNT(*)::text AS total_chunks,
       COALESCE(
         SUM(
           CASE
             WHEN e.source = 'sent'
              AND (
                (COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
                 AND COALESCE(e.parsed_content->>'user_edited', 'false') = 'true')
                OR
                (COALESCE(e.parsed_content->>'app_generated', 'false') <> 'true'
                 AND (
                   COALESCE(e.parsed_content->>'sent_by_user', 'false') = 'true'
                   OR COALESCE(e.parsed_content->>'user_edited', 'false') = 'true'
                 ))
              )
             THEN 1
             ELSE 0
           END
         ),
         0
       )::text AS policy_valid_chunks,
       COALESCE(SUM(CASE WHEN e.source <> 'sent' THEN 1 ELSE 0 END), 0)::text AS invalid_non_sent_chunks,
       COALESCE(
         SUM(
           CASE
             WHEN e.source = 'sent'
              AND COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
              AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
             THEN 1
             ELSE 0
           END
         ),
         0
       )::text AS invalid_untouched_app_chunks,
       COALESCE(
         SUM(
           CASE
             WHEN e.source = 'sent'
              AND COALESCE(e.parsed_content->>'app_generated', 'false') <> 'true'
              AND COALESCE(e.parsed_content->>'sent_by_user', 'false') <> 'true'
              AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
             THEN 1
             ELSE 0
           END
         ),
         0
       )::text AS invalid_unverified_sent_chunks
     FROM email_embeddings em
     JOIN emails e ON e.id = em.email_id`,
  );

  return result.rows[0] ?? null;
}

function summarize(label: string, row: IntegrityRow | null) {
  const total = toNumber(row?.total_chunks);
  const valid = toNumber(row?.policy_valid_chunks);
  const invalidNonSent = toNumber(row?.invalid_non_sent_chunks);
  const invalidUntouchedApp = toNumber(row?.invalid_untouched_app_chunks);
  const invalidUnverified = toNumber(row?.invalid_unverified_sent_chunks);
  const invalid = invalidNonSent + invalidUntouchedApp + invalidUnverified;
  const purity = total > 0 ? (total - invalid) / total : 1;

  console.log(label, {
    total_chunks: total,
    policy_valid_chunks: valid,
    invalid_non_sent_chunks: invalidNonSent,
    invalid_untouched_app_chunks: invalidUntouchedApp,
    invalid_unverified_sent_chunks: invalidUnverified,
    invalid_chunks: invalid,
    purity_score: Number(purity.toFixed(4)),
  });

  return { invalid };
}

async function main() {
  const before = await readIntegrity();
  const beforeSummary = summarize("BEFORE_REPAIR", before);

  if (beforeSummary.invalid === 0) {
    console.log("REPAIR_RESULT", { status: "already_clean", removed_chunks: 0, affected_emails: 0 });
    return;
  }

  const deleted = await db.query<{ id: number; email_id: number }>(
    `WITH invalid AS (
       SELECT em.id, em.email_id
       FROM email_embeddings em
       JOIN emails e ON e.id = em.email_id
       WHERE e.source <> 'sent'
          OR (
            COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
            AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
          )
          OR (
            COALESCE(e.parsed_content->>'app_generated', 'false') <> 'true'
            AND COALESCE(e.parsed_content->>'sent_by_user', 'false') <> 'true'
            AND COALESCE(e.parsed_content->>'user_edited', 'false') <> 'true'
          )
     )
     DELETE FROM email_embeddings em
     USING invalid i
     WHERE em.id = i.id
     RETURNING em.id, em.email_id`,
  );

  const affectedEmailIds = Array.from(new Set(deleted.rows.map((row) => row.email_id)));
  if (affectedEmailIds.length > 0) {
    await db.query(
      `UPDATE emails
       SET embedding_status = 'skipped_filter',
           embedding_error = 'Removed by integrity repair script: not sent/manual/user-edited content.',
           updated_at = NOW()
       WHERE id = ANY($1::int[])`,
      [affectedEmailIds],
    );
  }

  if (deleted.rows.length > 0) {
    await bumpEmbeddingDatasetVersion();
  }

  console.log("REPAIR_RESULT", {
    status: deleted.rows.length > 0 ? "repaired" : "already_clean",
    removed_chunks: deleted.rows.length,
    affected_emails: affectedEmailIds.length,
  });

  const after = await readIntegrity();
  summarize("AFTER_REPAIR", after);
}

main()
  .catch((error) => {
    console.error("REPAIR_FAILED", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end().catch(() => {
      // ignore close failure in diagnostics script
    });
  });
