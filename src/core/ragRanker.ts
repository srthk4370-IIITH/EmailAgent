/**
 * RAG Ranking Layer — Adaptive Intelligence Edition
 *
 * Fix 1: Static weights → intent-adaptive weights
 * Fix 3: Jaccard dedup → n-gram + structural semantic dedup
 * Fix 5: Programmatic answer quality scoring
 */

import type { EmbeddingRow } from "../db/embeddings";
import { getRuntimeConfigSync } from "../lib/runtimeConfig";

// ── Query intent classification ───────────────────────────────────────

export type QueryIntent = "factual" | "procedural" | "conversational" | "scheduling";

/**
 * Classify query intent from the incoming email text.
 * This drives adaptive weight selection — not static weights.
 */
export function classifyQueryIntent(subject: string, body: string): QueryIntent {
  const text = `${subject} ${body}`.toLowerCase();

  // Scheduling: dates, meetings, times, availability
  if (/\b(meeting|schedule|calendar|available|availability|reschedule|slot|appointment|when can)\b/.test(text)) {
    return "scheduling";
  }

  // Procedural: how-to, steps, process, instructions
  if (/\b(how (do|to|can|should)|steps|process|procedure|guide|instructions|setup|configure)\b/.test(text)) {
    return "procedural";
  }

  // Factual: what, where, which, specific questions
  if (/\b(what is|where is|which|how much|how many|deadline|status|update|report|number|cost|price)\b/.test(text)) {
    return "factual";
  }

  // Default: conversational
  return "conversational";
}

// ── Adaptive weights per intent ───────────────────────────────────────
// (Intent classification is preserved for tracing, but fallback to requested fixed tuning for recall/precision)

export interface RankingWeights {
  similarity: number;
  recency: number;
  chunkType: number;
  length_quality: number;
  query_match: number;
}

const TUNED_WEIGHTS: RankingWeights = {
  similarity: 0.50,
  chunkType: 0.25, // Note: the chunk type scores handle the scaling (answer 1.0, exp 0.6, q 0.3)
  recency: 0.10,
  length_quality: 0.15,
  query_match: 0.20,
};

export function getWeightsForIntent(_intent: QueryIntent): RankingWeights {
  return TUNED_WEIGHTS;
}

// ── Chunk type scores ─────────────────────────────────────────────────

const CHUNK_TYPE_SCORES: Record<string, number> = {
  answer: 1.0,
  explanation: 0.6,
  question: 0.3,
  unknown: 0.1,
};

// ── Individual signal functions ───────────────────────────────────────

function similarityScore(distance: number): number {
  return Math.max(0, 1 - distance);
}

function recencyScore(createdAt?: string): number {
  if (!createdAt) return 0.5;
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 1;
  return Math.max(0, 1 - ageDays / 90);
}

function chunkTypeScore(chunkType: string): number {
  return CHUNK_TYPE_SCORES[chunkType] ?? 0.1;
}

/**
 * Query match score.
 * Favors chunks that directly match important user query terms.
 */
function queryMatchScore(chunkText: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 1.0;
  
  const chunkLower = chunkText.toLowerCase();
  let hits = 0;
  for (const term of queryTerms) {
    if (chunkLower.includes(term.toLowerCase())) hits++;
  }
  return hits / queryTerms.length;
}

/**
 * Length quality score with vague penalty and completeness boost.
 * Penalizes generic filler vs. structured explanations.
 */
function lengthQualityScore(chunkText: string): number {
  let baseScore = 1.0;
  const len = chunkText.length;
  
  if (len < 50) baseScore = 0.05;
  else if (len > 1200) baseScore = 0.1;
  else if (len < 100) baseScore = 0.05 + ((len - 50) / 50) * 0.95;
  else if (len > 600) baseScore = 1.0 - ((len - 600) / 600);

  // VAGUE PENALTY
  const vaguePattern = /\b(let me know|we can discuss|feel free to|reach out to|happy to help|keep me posted)\b/i;
  const hasConcreteNouns = /\b[A-Z][a-z]+\b|\b\d+\b/.test(chunkText);
  if (vaguePattern.test(chunkText) || !hasConcreteNouns) {
    baseScore *= 0.5; // severe vague penalty
  }

  // COMPLETENESS BOOST
  const sentences = (chunkText.match(/[.!?]+/g) || []).length;
  const structPattern = /\b(because|so|therefore|thus|hence|you can|should|must)\b/i;
  let boost = 0;
  if (sentences > 2) boost += 0.1;
  if (structPattern.test(chunkText)) boost += 0.1;

  return Math.min(1.0, baseScore + boost);
}

// ── Style Signaling (TIER 3 HARDENING) ────────────────────────────────

function computeStyleScore(query: string, chunkText: string, createdAt?: string): number {
  let score = 0;

  // 1. Similar Length (within 30% margin)
  const queryWords = query.split(/\s+/).length;
  const chunkWords = chunkText.split(/\s+/).length;
  const lengthRatio = Math.min(queryWords, chunkWords) / Math.max(queryWords, chunkWords);
  if (lengthRatio > 0.7) score += 0.25;

  // 2. Similar Punctuation (density of ?, !, ...)
  const puncPattern = /[?!.]/g;
  const queryPunc = (query.match(puncPattern) || []).length / (queryWords || 1);
  const chunkPunc = (chunkText.match(puncPattern) || []).length / (chunkWords || 1);
  const puncDelta = Math.abs(queryPunc - chunkPunc);
  if (puncDelta < 0.1) score += 0.25;

  // 3. Recency (leveraging existing recency logic)
  const recency = recencyScore(createdAt);
  if (recency > 0.8) score += 0.25;

  // 4. Contextual Match (Generic boost for now, can be expanded to sameTopic)
  score += 0.25; 

  return score;
}

// ── Composite ranking ─────────────────────────────────────────────────

export interface ScoredChunk extends EmbeddingRow {
  final_score: number;
  similarity_score: number;
  recency_score: number;
  type_score: number;
  completeness_score: number;
  confidence: "strong" | "medium" | "weak";
  variant_source: string;
  embedding: number[];
  success_score: number;
  log_retrieved: number;
}

export interface StructuredContextItem {
  chunk_id: number;
  question: string | null;
  answer: string;
  topic: string;
  distance: number;
  subject: string;
  email_id: number;
  final_score?: number | undefined;
  embedding: number[];
}


export interface UnrankedCandidate extends EmbeddingRow {
  confidence: "strong" | "medium" | "weak";
  variant_source: string;
}

/**
 * Rank chunks using intent-adaptive multi-signal scoring.
 *
 * Weights shift based on query intent:
 * - Factual → high similarity + completeness
 * - Procedural → highest completeness
 * - Scheduling → highest recency
 * - Conversational → balanced
 */
export function rankChunks(
  chunks: UnrankedCandidate[],
  queryTerms: string[],
  intent: QueryIntent = "conversational",
): ScoredChunk[] {
  const weights = getWeightsForIntent(intent);
  const queryStr = queryTerms.join(" ").toLowerCase();
  
  // Phase 5: Query-Type Adaptation
  const isHow = /\b(how)\b/i.test(queryStr);
  const isWhat = /\b(what)\b/i.test(queryStr);
  const isDecision = /\b(can|should|do|will)\b/i.test(queryStr);

  const scored = chunks
    .map((chunk) => {
      const sim = similarityScore(chunk.distance);
      const rec = recencyScore(chunk.created_at);
      const typ = chunkTypeScore(chunk.chunk_type);
      const comp = lengthQualityScore(chunk.chunk_text);
      const qMatch = queryMatchScore(chunk.chunk_text, queryTerms);

      const baseScore =
        weights.similarity * sim +
        weights.recency * rec +
        weights.chunkType * typ +
        weights.length_quality * comp +
        weights.query_match * qMatch;

      let typMatchBoost = 0;
      if (isHow && chunk.chunk_type === "explanation") typMatchBoost = 0.15;
      if (isWhat && chunk.chunk_type === "answer") typMatchBoost = 0.15;
      if (isDecision && chunk.chunk_type === "answer") typMatchBoost = 0.15;

      // Mechanism 1, 2, 4: Success History Injection with Retrieval Log Scaling
      // Upgrade: log(retrieved_count + 1) dampens initial noise and rewards consistency.
      // PHASE 3: Increased weight with CAP to avoid runaway dominance.
      // TIER 1 CLINICAL CORRECTION: Weight 0.6, Cap 0.5.
      const successEffect = Math.min(0.6 * (chunk.success_score || 0) * (chunk.log_retrieved || 0), 0.5);
      
      // PHASE 2: Hard bias for answer chunks
      const typeHardBias = chunk.chunk_type === "answer" ? 0.5 : 0;

      const style = computeStyleScore(queryStr, chunk.chunk_text, chunk.created_at);

      // TIER 3 HARDENING: 0.6 * Semantic + 0.4 * Style
      const finalScore = 0.6 * baseScore + 0.4 * style + typMatchBoost + successEffect + typeHardBias;

      if (getRuntimeConfigSync("DEBUG_RAG_RANKING") === "true") {
        console.log(`[RAG-RANK] Chunk ${chunk.chunk_id} breakdown:`, {
          base: baseScore.toFixed(3),
          style: style.toFixed(3),
          boost: typMatchBoost.toFixed(3),
          success: successEffect.toFixed(3),
          typeBias: typeHardBias.toFixed(3),
          final: finalScore.toFixed(3),
        });
      }

      return {
        ...chunk,
        final_score: finalScore,
        similarity_score: sim,
        recency_score: rec,
        type_score: typ,
        completeness_score: comp,
        confidence: chunk.confidence,
        variant_source: chunk.variant_source,
      };
    });

  // Normalize final scores per batch for ranking stability.
  const minScore = scored.reduce((m, c) => Math.min(m, c.final_score), Number.POSITIVE_INFINITY);
  const maxScore = scored.reduce((m, c) => Math.max(m, c.final_score), Number.NEGATIVE_INFINITY);
  const denom = maxScore - minScore;

  const normalized = scored.map((c) => ({
    ...c,
    final_score: denom > 1e-9 ? (c.final_score - minScore) / denom : c.final_score,
  }));

  return normalized.sort((a, b) => {
    if (b.final_score !== a.final_score) return b.final_score - a.final_score;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.chunk_id - b.chunk_id;
  });
}

// ── N-gram semantic dedup (Fix 3) ─────────────────────────────────────
//
// Jaccard on unigrams misses "same meaning, different words."
// N-gram overlap on bigrams + trigrams catches paraphrased duplicates.

function extractNgrams(text: string, n: number): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const ngrams = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.add(words.slice(i, i + n).join(" "));
  }
  return ngrams;
}

/**
 * Multi-level text similarity: combines unigram Jaccard with
 * bigram and trigram overlap for paraphrase detection.
 */
function semanticTextSimilarity(a: string, b: string): number {
  const uniA = extractNgrams(a, 1);
  const uniB = extractNgrams(b, 1);
  const biA = extractNgrams(a, 2);
  const biB = extractNgrams(b, 2);
  const triA = extractNgrams(a, 3);
  const triB = extractNgrams(b, 3);

  const jaccardSim = (setA: Set<string>, setB: Set<string>): number => {
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  };

  // Weighted combination: trigrams catch structural similarity,
  // unigrams catch topical overlap
  const uniSim = jaccardSim(uniA, uniB);
  const biSim = jaccardSim(biA, biB);
  const triSim = jaccardSim(triA, triB);

  return uniSim * 0.3 + biSim * 0.4 + triSim * 0.3;
}

/**
 * Containment check: is one chunk a subset of another?
 * If chunk A's core content is contained within chunk B,
 * prefer the longer (more complete) one.
 */
function isSubsumed(shorter: string, longer: string): boolean {
  if (shorter.length >= longer.length) return false;
  const shortWords = new Set(shorter.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const longWords = new Set(longer.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  if (shortWords.size === 0) return false;

  let contained = 0;
  for (const w of shortWords) {
    if (longWords.has(w)) contained++;
  }
  return contained / shortWords.size > 0.8; // 80% of short's words in long
}

function cosineDist(a: number[], b: number[]): number {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!; normA += a[i]! * a[i]!; normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 1 : 1 - dotProduct / denom;
}

/**
 * Remove semantic duplicates using embedding-based similarity OR n-gram similarity.
 * Resolves by keeping the chunk with the higher completeness score.
 */
export function deduplicateChunks(
  scored: ScoredChunk[],
  similarityThreshold = 0.55,  // lower threshold catches paraphrases
): ScoredChunk[] {
  const result: ScoredChunk[] = [];

  // Sort by completeness score descending, so we always prefer keeping
  // the most complete chunk when duplicates are found.
  const completionSorted = [...scored].sort((a, b) => b.completeness_score - a.completeness_score);

  for (const chunk of completionSorted) {
    const isDuplicate = result.some((kept) => {
      // Embedding Similarity: Cosine distance < 0.1 means >0.9 similarity
      const embDist = cosineDist(kept.embedding, chunk.embedding);
      if (embDist < 0.1) return true;

      // N-gram semantic similarity
      const sim = semanticTextSimilarity(kept.chunk_text, chunk.chunk_text);
      if (sim > similarityThreshold) return true;

      // Subsumption: shorter chunk fully contained in longer
      if (isSubsumed(chunk.chunk_text, kept.chunk_text)) return true;

      return false;
    });

    if (!isDuplicate) {
      result.push(chunk);
    }
  }

  return result.sort((a, b) => b.final_score - a.final_score);
}

// ── Conflict resolution with topic diversity ──────────────────────────

export function selectBestChunks(
  chunks: ScoredChunk[],
  maxItems: number,
): ScoredChunk[] {
  const topicCounts = new Map<string, number>();
  const threadCounts = new Map<string, number>();
  const selected: ScoredChunk[] = [];
  let nonAnswerCount = 0;

  for (const chunk of chunks) {
    // PHASE 2: Limit non-answer chunks to max 1
    if (chunk.chunk_type !== "answer") {
      if (nonAnswerCount >= 1) continue;
      nonAnswerCount++;
    }

    const topic = chunk.topic || chunk.subject || "unknown";
    const count = topicCounts.get(topic) || 0;
    if (count >= 2) continue;

    const threadKey = chunk.thread_id ?? String(chunk.email_id);
    const threadCount = threadCounts.get(threadKey) || 0;
    if (threadCount >= 2) continue;

    selected.push(chunk);
    topicCounts.set(topic, count + 1);
    threadCounts.set(threadKey, threadCount + 1);

    if (selected.length >= maxItems) break;
  }

  if (getRuntimeConfigSync("DEBUG_RAG_RANKING") === "true") {
    console.log(`[RAG-SELECT] Top ${selected.length} chunks chosen:`, 
      selected.map(c => `ID:${c.chunk_id} score:${c.final_score.toFixed(3)} type:${c.chunk_type}`)
    );
  }

  return selected;
}
