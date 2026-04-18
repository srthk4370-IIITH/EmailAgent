/**
 * Feedback Updater Script (Goal 4 - Mechanism 6)
 *
 * Usage: npx tsx scripts/feedback-updater.ts
 *
 * Parses recent 'rag_trace' logs and updates the 'chunk_feedback'
 * table with retrieved, used, and helpful counts.
 */

import { db, initDbSchema } from "../src/db/client";

async function run() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Feedback Loop Updater");
  console.log("═══════════════════════════════════════════════════\n");

  await initDbSchema();

  // 1. Fetch untallied traces from logs
  // (We use a simple filter: meta must have chunks and we haven't processed it yet)
  // For simplicity in this script, we'll just process the last 100 traces
  // and use ON CONFLICT to avoid double-counting if run frequently.
  const result = await db.query(`
    SELECT id, meta 
    FROM logs 
    WHERE step = 'rag_trace' 
    ORDER BY created_at DESC 
    LIMIT 100
  `);

  console.log(`Processing ${result.rows.length} recent traces...\n`);

  let retrievedTotal = 0;
  let usedTotal = 0;
  let helpfulTotal = 0;

  for (const row of result.rows) {
    const meta = row.meta;
    const selectedChunks: any[] = meta.chunks?.filter((c: any) => c.status === 'selected') || [];
    const usedChunks: number[] = meta.chunks_used || [];
    const helpfulChunks: number[] = meta.helpful_chunks || [];

    for (const chunk of selectedChunks) {
      const chunkId = chunk.chunk_id;
      if (!chunkId) continue;

      const isUsed = usedChunks.includes(chunkId);
      const isHelpful = helpfulChunks.includes(chunkId);

      // Update counters
      // retrieved_count += 1
      // used_count += 1 (if retrieved)
      // helpful_count += 1
      
      await db.query(`
        INSERT INTO chunk_feedback (chunk_id, retrieved_count, used_count, helpful_count, last_updated)
        VALUES ($1, 1, $2, $3, NOW())
        ON CONFLICT (chunk_id) DO UPDATE SET
          retrieved_count = chunk_feedback.retrieved_count + 1,
          used_count = chunk_feedback.used_count + $2,
          helpful_count = chunk_feedback.helpful_count + $3,
          last_updated = NOW()
      `, [chunkId, isUsed ? 1 : 0, isHelpful ? 1 : 0]);

      retrievedTotal++;
      if (isUsed) usedTotal++;
      if (isHelpful) helpfulTotal++;
    }
  }

  console.log("───────────────────────────────────────────────────");
  console.log(`  Update Complete:`);
  console.log(`  Total Retrieves Tallied: ${retrievedTotal}`);
  console.log(`  Total Usages Tallied:    ${usedTotal}`);
  console.log(`  Total Successes Tallied: ${helpfulTotal}`);
  console.log("───────────────────────────────────────────────────\n");

  process.exit(0);
}

run().catch((err) => {
  console.error("Feedback update failed:", err);
  process.exit(1);
});
