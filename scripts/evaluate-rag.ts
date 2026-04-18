/**
 * RAG Evaluation Runner (Phase 7)
 *
 * Usage: npx tsx scripts/evaluate-rag.ts
 *
 * Processes sample emails through the RAG pipeline and
 * computes quality metrics.
 */

import { db, initDbSchema } from "../src/db/client";
import { getRelevantContext } from "../src/core/rag";
import { evaluateCase, saveEvalResult, type EvalCase, type EvalResult } from "../src/core/ragEvaluator";
import type { EmailRecord } from "../src/db/emails";

async function getSampleEmails(limit = 20): Promise<EmailRecord[]> {
  const result = await db.query<EmailRecord>(
    `SELECT * FROM emails
     WHERE source = 'inbox'
       AND state IN ('GENERATED', 'AWAITING_REVIEW', 'SENT')
       AND reply IS NOT NULL
       AND LENGTH(reply) > 20
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .filter((w) => !COMMON_WORDS.has(w));
  return [...new Set(words)].slice(0, 10);
}

const COMMON_WORDS = new Set([
  "please", "would", "could", "should", "about", "which", "their",
  "there", "these", "those", "other", "being", "email", "thanks",
  "thank", "regards", "hello", "message", "received", "follow",
]);

async function run() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  RAG Evaluation Runner");
  console.log("═══════════════════════════════════════════════════\n");

  await initDbSchema();

  const emails = await getSampleEmails(20);
  console.log(`Found ${emails.length} sample emails to evaluate.\n`);

  if (emails.length === 0) {
    console.log("No eligible emails found for evaluation.");
    process.exit(0);
  }

  const results: EvalResult[] = [];

  for (const email of emails) {
    try {
      // Get RAG context
      const { items: context } = await getRelevantContext(email.subject, email.body, {
        emailId: email.id,
        traceId: `eval-${email.id}`,
      });

      // Build eval case using heuristic expected values
      const evalCase: EvalCase = {
        email_id: email.id,
        subject: email.subject,
        body: email.body,
        expected_keywords: extractKeywords(email.body),
        expected_topics: [email.subject],
        actual_reply: email.reply || undefined,
        retrieved_chunks: context.map((c) => ({
          chunk_text: c.answer,
          chunk_type: "answer",
          distance: c.distance,
          final_score: c.final_score ?? 0,
        })),
      };

      const result = evaluateCase(evalCase);
      results.push(result);
      await saveEvalResult(result);

      console.log(
        `  [${email.id}] P@K=${result.retrieval_precision_at_k.toFixed(2)} ` +
        `Cov=${result.answer_coverage.toFixed(2)} ` +
        `Hal=${result.hallucination_score.toFixed(2)} ` +
        `CtxUtil=${result.context_utilization.toFixed(2)} ` +
        `Usefulness=${result.answer_usefulness.toFixed(2)} ` +
        `MultiHop=${result.multi_hop_score.toFixed(2)} ` +
        `Repetition=${result.repetition_score.toFixed(2)} ` +
        `Faithful=${result.faithfulness_score.toFixed(2)} ` +
        `CtxUsed=${result.context_used ? "✓" : "✗"}`
      );
    } catch (err) {
      console.error(`  [${email.id}] Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Aggregate metrics
  if (results.length > 0) {
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    console.log("\n───────────────────────────────────────────────────");
    console.log("  Aggregate Core Metrics:");
    console.log(`  Avg Retrieval Precision@K: ${avg(results.map((r) => r.retrieval_precision_at_k)).toFixed(3)}`);
    console.log(`  Avg Answer Coverage:       ${avg(results.map((r) => r.answer_coverage)).toFixed(3)}`);
    console.log(`  Avg Topic Coverage:        ${avg(results.map((r) => r.topic_coverage)).toFixed(3)}`);
    console.log(`  Avg Hallucination Score:   ${avg(results.map((r) => r.hallucination_score)).toFixed(3)}`);
    console.log("\n  Aggregate Deep Metrics:");
    console.log(`  Avg Context Utilization:   ${avg(results.map((r) => r.context_utilization)).toFixed(3)}`);
    console.log(`  Avg Answer Usefulness:     ${avg(results.map((r) => r.answer_usefulness)).toFixed(3)}`);
    console.log(`  Avg Multi-Hop Score:       ${avg(results.map((r) => r.multi_hop_score)).toFixed(3)}`);
    console.log(`  Avg Repetition Score:      ${avg(results.map((r) => r.repetition_score)).toFixed(3)}`);
    console.log(`  Avg Faithfulness Score:    ${avg(results.map((r) => r.faithfulness_score)).toFixed(3)}`);
    
    console.log("\n  Stats:");
    console.log(`  Context Used:              ${results.filter((r) => r.context_used).length}/${results.length}`);
    console.log(`  Avg Reply Length:          ${Math.round(avg(results.map((r) => r.reply_length)))} chars`);
    console.log("───────────────────────────────────────────────────\n");
  }

  process.exit(0);
}

run().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
