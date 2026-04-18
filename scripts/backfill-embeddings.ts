/**
 * Backfill script: re-indexes all existing sent emails through the new
 * knowledge extraction pipeline.
 *
 * Usage: npx tsx scripts/backfill-embeddings.ts
 *
 * What it does:
 * 1. Initializes DB schema (adds new columns / index if missing)
 * 2. Fetches ALL sent emails from the database
 * 3. Deletes old embeddings for each email
 * 4. Runs the new ingestion pipeline (extract → chunk → embed → store)
 * 5. Reports progress and errors
 */

import { db, initDbSchema } from "../src/db/client";
import { deleteEmbeddingsByEmailId } from "../src/db/embeddings";
import { indexEmailForRag } from "../src/core/rag";
import type { EmailRecord } from "../src/db/emails";

async function getAllSentEmails(): Promise<EmailRecord[]> {
  const result = await db.query<EmailRecord>(
    `SELECT * FROM emails WHERE source = 'sent' ORDER BY id ASC`,
  );
  return result.rows;
}

async function backfill() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  RAG Backfill: Knowledge Extraction Pipeline");
  console.log("═══════════════════════════════════════════════════\n");

  // Step 1: Ensure schema is up-to-date
  console.log("[1/4] Initializing database schema...");
  await initDbSchema();
  console.log("  ✓ Schema ready\n");

  // Step 2: Fetch all sent emails
  console.log("[2/4] Fetching sent emails...");
  const emails = await getAllSentEmails();
  console.log(`  ✓ Found ${emails.length} sent emails\n`);

  if (emails.length === 0) {
    console.log("No sent emails to process. Done.");
    process.exit(0);
  }

  // Step 3: Process each email
  console.log("[3/4] Processing emails through knowledge pipeline...\n");
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const email of emails) {
    try {
      // Delete old embeddings first (clean slate)
      await deleteEmbeddingsByEmailId(email.id);

      // Run new ingestion pipeline
      await indexEmailForRag(email);
      processed++;

      // Progress indicator
      if (processed % 10 === 0 || processed === emails.length) {
        const pct = Math.round((processed / emails.length) * 100);
        console.log(`  [${pct}%] ${processed}/${emails.length} processed`);
      }
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Email #${email.id} (${email.subject}): ${msg}`);
    }
  }

  // Step 4: Report
  console.log("\n[4/4] Summary:");
  console.log(`  ✓ Processed: ${processed}`);
  console.log(`  ⊘ Skipped:   ${skipped}`);
  console.log(`  ✗ Errors:    ${errors}`);

  // Verify embedding count
  const countResult = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM email_embeddings",
  );
  const totalEmbeddings = Number(countResult.rows[0]?.count ?? 0);
  console.log(`\n  Total knowledge units in DB: ${totalEmbeddings}`);

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  Backfill complete.");
  console.log("═══════════════════════════════════════════════════");

  process.exit(0);
}

backfill().catch((err) => {
  console.error("\n✗ Backfill failed:", err);
  process.exit(1);
});
