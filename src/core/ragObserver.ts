/**
 * RAG Observability Layer
 *
 * Captures every decision in the RAG pipeline:
 * - Query intent classification
 * - Expansion validation (accepted/dropped variants)
 * - Retrieved chunk scoring breakdown
 * - Filtering, deduplication, selection decisions
 * - Fallback trigger events
 */

import { db } from "../db/client";
import { logger } from "../utils/logger";
import type { ScoredChunk, QueryIntent, StructuredContextItem } from "./ragRanker";
import { cosineSimilarity } from "../utils/math";
import { evaluateCase } from "./ragEvaluator";
import { createEmbedding } from "../services/embeddings";



// ── Types ─────────────────────────────────────────────────────────────

export interface RagTraceChunk {
  chunk_id: number;
  email_id: number;
  chunk_text_preview: string;
  chunk_type: string;
  confidence: "strong" | "medium" | "weak";
  variant_source: string;
  distance: number;
  final_score: number;
  similarity_score: number;
  recency_score: number;
  type_score: number;
  completeness_score: number;
  status: "selected" | "filtered" | "deduplicated";
  filter_reason?: string | undefined;
}

export interface ExpansionDrop {
  variant_text_preview: string;
  divergence: number;
  threshold: number;
}

export interface RagTrace {
  email_id: number;
  trace_id: string;
  query_text_preview: string;
  query_intent: QueryIntent;
  total_retrieved: number;
  total_after_ranking: number;
  total_after_dedup: number;
  total_selected: number;
  total_strong: number;
  total_medium: number;
  total_weak: number;
  fallback_triggered: boolean;
  fallback_type?: "relaxed_threshold" | "none" | undefined;
  expansion_drops: ExpansionDrop[];
  chunks: RagTraceChunk[];
  latency_ms: number;
  failure_type?: "retrieval_failure" | "usage_failure" | "synthesis_failure" | null | undefined;
  chunks_used?: number[] | undefined;
  helpful_chunks?: number[] | undefined;
  chunks_ignored?: number[] | undefined;
  created_at: string;
}

// ── Trace builder ─────────────────────────────────────────────────────

export class RagTraceBuilder {
  private emailId: number;
  private traceId: string;
  private queryText: string;
  private startTime: number;
  private chunks: RagTraceChunk[] = [];
  private expansionDrops: ExpansionDrop[] = [];
  private fallbackTriggered = false;
  private fallbackType?: "relaxed_threshold" | "none" | undefined;
  private queryIntent: QueryIntent = "conversational";
  private totalRetrieved = 0;
  private totalAfterRanking = 0;
  private totalAfterDedup = 0;
  private totalSelected = 0;
  private totalStrong = 0;
  private totalMedium = 0;
  private totalWeak = 0;
  private failureType?: "retrieval_failure" | "usage_failure" | "synthesis_failure" | null | undefined;
  private chunksUsed: number[] = [];
  private helpfulChunks: number[] = [];
  private chunksIgnored: number[] = [];

  constructor(emailId: number, traceId: string, queryText: string) {
    this.emailId = emailId;
    this.traceId = traceId;
    this.queryText = queryText;
    this.startTime = Date.now();
  }

  setQueryIntent(intent: QueryIntent): void {
    this.queryIntent = intent;
  }

  setTotalRetrieved(count: number): void {
    this.totalRetrieved = count;
  }

  setTotalAfterRanking(count: number): void {
    this.totalAfterRanking = count;
  }

  setTotalAfterDedup(count: number): void {
    this.totalAfterDedup = count;
  }

  setTotalSelected(count: number): void {
    this.totalSelected = count;
  }

  setTierCounts(strong: number, medium: number, weak: number): void {
    this.totalStrong = strong;
    this.totalMedium = medium;
    this.totalWeak = weak;
  }

  setFallback(type: "relaxed_threshold" | "none"): void {
    this.fallbackTriggered = true;
    this.fallbackType = type;
  }

  setFeedbackSignals(failureType: "retrieval_failure" | "usage_failure" | "synthesis_failure" | null, used: number[], ignored: number[]): void {
    this.failureType = failureType;
    this.chunksUsed = used;
    this.chunksIgnored = ignored;
  }

  setHelpfulChunks(helpful: number[]): void {
    this.helpfulChunks = helpful;
  }

  addExpansionDrop(variantText: string, divergence: number, threshold: number): void {
    this.expansionDrops.push({
      variant_text_preview: variantText.slice(0, 100),
      divergence,
      threshold,
    });
  }

  addChunk(
    chunk: ScoredChunk,
    status: "selected" | "filtered" | "deduplicated",
    filterReason?: string,
  ): void {
    this.chunks.push({
      chunk_id: chunk.chunk_id,
      email_id: chunk.email_id,
      chunk_text_preview: chunk.chunk_text.slice(0, 120),
      chunk_type: chunk.chunk_type,
      confidence: chunk.confidence,
      variant_source: chunk.variant_source,
      distance: chunk.distance,
      final_score: chunk.final_score,
      similarity_score: chunk.similarity_score,
      recency_score: chunk.recency_score,
      type_score: chunk.type_score,
      completeness_score: chunk.completeness_score,
      status,
      filter_reason: filterReason,
    });
  }

  build(): RagTrace {
    return {
      email_id: this.emailId,
      trace_id: this.traceId,
      query_text_preview: this.queryText.slice(0, 200),
      query_intent: this.queryIntent,
      total_retrieved: this.totalRetrieved,
      total_after_ranking: this.totalAfterRanking,
      total_after_dedup: this.totalAfterDedup,
      total_selected: this.totalSelected,
      total_strong: this.totalStrong,
      total_medium: this.totalMedium,
      total_weak: this.totalWeak,
      fallback_triggered: this.fallbackTriggered,
      fallback_type: this.fallbackType,
      expansion_drops: this.expansionDrops,
      chunks: this.chunks,
      latency_ms: Date.now() - this.startTime,
      failure_type: this.failureType,
      chunks_used: this.chunksUsed,
      helpful_chunks: this.helpfulChunks,
      chunks_ignored: this.chunksIgnored,
      created_at: new Date().toISOString(),
    };
  }
}

// ── Persistence ───────────────────────────────────────────────────────

export async function saveRagTrace(trace: RagTrace): Promise<void> {
  try {
    logger.info("rag_trace", {
      email_id: trace.email_id,
      trace_id: trace.trace_id,
      query_intent: trace.query_intent,
      total_retrieved: trace.total_retrieved,
      total_selected: trace.total_selected,
      fallback_triggered: trace.fallback_triggered,
      expansion_drops: trace.expansion_drops.length,
      latency_ms: trace.latency_ms,
    });

    await db.query(
      `INSERT INTO logs (trace_id, gmail_id, step, state, latency_ms, error, meta)
       VALUES ($1, NULL, 'rag_trace', 'TRACE', $2, NULL, $3::jsonb)`,
      [
        trace.trace_id,
        trace.latency_ms,
        JSON.stringify({
          email_id: trace.email_id,
          query_preview: trace.query_text_preview,
          query_intent: trace.query_intent,
          total_retrieved: trace.total_retrieved,
          total_after_ranking: trace.total_after_ranking,
          total_after_dedup: trace.total_after_dedup,
          total_selected: trace.total_selected,
          total_strong: trace.total_strong,
          total_medium: trace.total_medium,
          total_weak: trace.total_weak,
          fallback_triggered: trace.fallback_triggered,
          fallback_type: trace.fallback_type,
          expansion_drops: trace.expansion_drops,
          chunks: trace.chunks,
          failure_type: trace.failure_type,
          chunks_used: trace.chunks_used,
          helpful_chunks: trace.helpful_chunks,
          chunks_ignored: trace.chunks_ignored,
        }),
      ],
    );
  } catch (err) {
    logger.error("rag_trace_save_failed", {
      email_id: trace.email_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Robust Feedback Calculation & Save (Mechanism 1, 2, 5, 7)
 * Shared between background processor and manual API routes.
 */
export async function calculateAndSaveTrace(
  replyText: string,
  query: { subject: string; body: string },
  ragContext: StructuredContextItem[],
  builder: RagTraceBuilder,
  email_id: number,
): Promise<void> {
  try {
    const answerEmbedding = await createEmbedding(replyText);
    const usedChunks: number[] = [];
    const helpfulChunks: number[] = [];

    const evalResult = evaluateCase({
      email_id,
      subject: query.subject,
      body: query.body,
      expected_keywords: [],
      expected_topics: [],
      actual_reply: replyText,
      retrieved_chunks: ragContext.map((c) => ({
        chunk_text: c.answer,
        chunk_type: "answer",
        distance: c.distance,
        final_score: c.final_score || 0,
      })),
    });

    for (const item of ragContext) {
      const sim = cosineSimilarity(item.embedding, answerEmbedding);
      // Mechanism 1: Embedding similarity > 0.75
      if (sim > 0.75) {
        usedChunks.push(item.chunk_id);
        // Mechanism 2: Used AND Faithfulness > 0.4
        if (evalResult.faithfulness_score > 0.4) {
          helpfulChunks.push(item.chunk_id);
        }
      }
    }

    // Goal 7: Failure Labeling thresholds
    let failureType: "retrieval_failure" | "usage_failure" | "synthesis_failure" | null = null;
    if (ragContext.length === 0) failureType = "retrieval_failure";
    else if (evalResult.context_utilization < 0.2) failureType = "usage_failure";
    else if (evalResult.faithfulness_score < 0.3) failureType = "synthesis_failure";

    builder.setFeedbackSignals(failureType, usedChunks, []);
    builder.setHelpfulChunks(helpfulChunks);
    await saveRagTrace(builder.build());
  } catch (err) {
    logger.error("calculateAndSaveTrace failed", { email_id, error: String(err) });
  }
}
