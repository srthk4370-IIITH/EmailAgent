/**
 * RAG Evaluation Layer — Deep Metrics Edition (Fix 4)
 *
 * Beyond surface-level precision@k:
 * - Context utilization: does the reply actually USE the retrieved context?
 * - Answer usefulness proxy: information density of the reply
 * - Multi-hop detection: does the answer synthesize from multiple sources?
 * - Repetition score: structural quality check
 * - Faithfulness: does the reply stay grounded in context?
 */

import { db } from "../db/client";

// ── Types ─────────────────────────────────────────────────────────────

export interface EvalCase {
  email_id: number;
  subject: string;
  body: string;
  expected_keywords: string[];
  expected_topics: string[];
  actual_reply?: string | undefined;
  retrieved_chunks?: Array<{
    chunk_text: string;
    chunk_type: string;
    distance: number;
    final_score: number;
  }> | undefined;
}

export interface EvalResult {
  email_id: number;
  // Core metrics
  retrieval_precision_at_k: number;
  answer_coverage: number;
  topic_coverage: number;
  hallucination_score: number;
  context_used: boolean;
  reply_length: number;
  // Deep metrics (Fix 4)
  context_utilization: number;      // how much of context was actually used
  answer_usefulness: number;        // information density proxy
  multi_hop_score: number;          // synthesis from multiple sources
  repetition_score: number;         // 0 = no repetition, 1 = all repeated
  faithfulness_score: number;       // claims grounded in context
  intent_classification?: string | undefined;
}

// ── Core metrics (existing) ───────────────────────────────────────────

function computeKeywordCoverage(reply: string, expectedKeywords: string[]): number {
  if (expectedKeywords.length === 0) return 1;
  const lower = reply.toLowerCase();
  let hits = 0;
  for (const kw of expectedKeywords) {
    if (lower.includes(kw.toLowerCase())) hits++;
  }
  return hits / expectedKeywords.length;
}

function computeTopicCoverage(reply: string, expectedTopics: string[]): number {
  if (expectedTopics.length === 0) return 1;
  const lower = reply.toLowerCase();
  let hits = 0;
  for (const topic of expectedTopics) {
    const topicWords = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (topicWords.some((w) => lower.includes(w))) hits++;
  }
  return hits / expectedTopics.length;
}

function computeRetrievalPrecision(
  chunks: EvalCase["retrieved_chunks"],
  expectedTopics: string[],
): number {
  if (!chunks || chunks.length === 0) return 0;
  if (expectedTopics.length === 0) return 1;

  const topicWords = new Set(
    expectedTopics.flatMap((t) =>
      t.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
    ),
  );

  let relevant = 0;
  for (const chunk of chunks) {
    const chunkLower = chunk.chunk_text.toLowerCase();
    const hasOverlap = [...topicWords].some((w) => chunkLower.includes(w));
    if (hasOverlap) relevant++;
  }

  return relevant / chunks.length;
}

function computeHallucinationScore(
  reply: string,
  queryText: string,
  contextTexts: string[],
): number {
  const datePattern = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g;
  const numberPattern = /\b\d{4,}\b/g;
  const timePattern = /\b\d{1,2}:\d{2}\s*(am|pm)?\b/gi;

  const allSource = [queryText, ...contextTexts].join(" ");

  const replyDates = reply.match(datePattern) || [];
  const replyNumbers = reply.match(numberPattern) || [];
  const replyTimes = reply.match(timePattern) || [];

  const specificClaims = [...replyDates, ...replyNumbers, ...replyTimes];
  if (specificClaims.length === 0) return 0;

  let unsourced = 0;
  for (const claim of specificClaims) {
    if (!allSource.includes(claim)) unsourced++;
  }

  return unsourced / specificClaims.length;
}

// ── Deep metrics (Fix 4: NEW) ─────────────────────────────────────────

/**
 * Context utilization: what fraction of the retrieved context's key
 * content actually appears (in some form) in the generated reply?
 *
 * High = reply uses the context well.
 * Low = context was retrieved but ignored (waste).
 */
function computeContextUtilization(
  reply: string,
  chunks: EvalCase["retrieved_chunks"],
): number {
  if (!chunks || chunks.length === 0) return 0;

  const replyLower = reply.toLowerCase();
  let utilizedChunks = 0;

  for (const chunk of chunks) {
    // Extract significant words from each chunk
    const chunkWords = chunk.chunk_text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4);

    if (chunkWords.length === 0) continue;

    // Check if at least 30% of the chunk's significant words appear in reply
    const matchCount = chunkWords.filter((w) => replyLower.includes(w)).length;
    const matchRatio = matchCount / chunkWords.length;

    if (matchRatio >= 0.3) utilizedChunks++;
  }

  return utilizedChunks / chunks.length;
}

/**
 * Answer usefulness proxy: measures information density.
 *
 * Signals:
 * - Unique significant words (not filler)
 * - Sentence count (structured response)
 * - Contains specifics (numbers, proper nouns)
 * - Not just generic filler
 */
function computeAnswerUsefulness(reply: string): number {
  const words = reply.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const uniqueWords = new Set(words);
  const sentences = (reply.match(/[.!?]+/g) || []).length;
  const hasSpecifics = /\b\d+\b/.test(reply);

  // Vocabulary richness (unique / total)
  const richness = words.length > 0 ? uniqueWords.size / words.length : 0;

  // Structure (multi-sentence)
  const structureScore = Math.min(1, sentences / 3);

  // Specificity bonus
  const specificBonus = hasSpecifics ? 0.15 : 0;

  // Penalize very short or very generic replies
  const lengthPenalty = reply.length < 50 ? 0.3 : reply.length < 100 ? 0.7 : 1;

  return Math.min(1, (richness * 0.4 + structureScore * 0.35 + specificBonus) * lengthPenalty);
}

/**
 * Multi-hop synthesis detection: does the reply draw from multiple
 * knowledge chunks to form a unified answer?
 *
 * High score = true synthesis across sources.
 * Low score = single-source copy or no context usage.
 */
function computeMultiHopScore(
  reply: string,
  chunks: EvalCase["retrieved_chunks"],
): number {
  if (!chunks || chunks.length < 2) return 0;

  const replyLower = reply.toLowerCase();
  let sourcesUsed = 0;

  for (const chunk of chunks) {
    const keyPhrases = extractKeyPhrases(chunk.chunk_text);
    const phrasesInReply = keyPhrases.filter((p) => replyLower.includes(p.toLowerCase()));
    if (phrasesInReply.length >= 1) sourcesUsed++;
  }

  // Normalize: 2+ sources = good synthesis
  if (sourcesUsed >= 3) return 1.0;
  if (sourcesUsed === 2) return 0.7;
  if (sourcesUsed === 1) return 0.3;
  return 0;
}

/**
 * Extract 2-3 word key phrases from text for multi-hop detection.
 */
function extractKeyPhrases(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 3);
  const phrases: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    phrases.push(`${words[i]} ${words[i + 1]}`);
  }
  return phrases.slice(0, 10);
}

/**
 * Repetition score: measures how much self-repetition exists in the reply.
 * 0 = no repetition, 1 = everything is repeated.
 */
function computeRepetitionScore(reply: string): number {
  const sentences = reply.match(/[^.!?]+[.!?]+/g) || [];
  if (sentences.length < 2) return 0;

  const normalized = sentences.map((s) =>
    s.trim().toLowerCase().replace(/\s+/g, " "),
  );

  let duplicates = 0;
  const seen = new Set<string>();
  for (const s of normalized) {
    if (s.length < 15) continue;
    if (seen.has(s)) {
      duplicates++;
    }
    seen.add(s);
  }

  return duplicates / normalized.length;
}

/**
 * Faithfulness score: are the claims in the reply grounded in
 * the provided context or the original query?
 *
 * Measures what fraction of the reply's content words appear
 * in either the context or query (grounded) vs. novel.
 */
function computeFaithfulnessScore(
  reply: string,
  queryText: string,
  contextTexts: string[],
): number {
  const allSource = [queryText, ...contextTexts].join(" ").toLowerCase();
  const replyWords = reply
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4);

  if (replyWords.length === 0) return 1;

  const grounded = replyWords.filter((w) => allSource.includes(w)).length;
  return grounded / replyWords.length;
}

// ── Evaluation runner ─────────────────────────────────────────────────

export function evaluateCase(evalCase: EvalCase): EvalResult {
  const reply = evalCase.actual_reply || "";
  const queryText = `${evalCase.subject}\n${evalCase.body}`;
  const contextTexts = (evalCase.retrieved_chunks || []).map((c) => c.chunk_text);

  return {
    email_id: evalCase.email_id,
    // Core metrics
    retrieval_precision_at_k: computeRetrievalPrecision(
      evalCase.retrieved_chunks,
      evalCase.expected_topics,
    ),
    answer_coverage: computeKeywordCoverage(reply, evalCase.expected_keywords),
    topic_coverage: computeTopicCoverage(reply, evalCase.expected_topics),
    hallucination_score: computeHallucinationScore(reply, queryText, contextTexts),
    context_used: (evalCase.retrieved_chunks?.length ?? 0) > 0,
    reply_length: reply.length,
    // Deep metrics
    context_utilization: computeContextUtilization(reply, evalCase.retrieved_chunks),
    answer_usefulness: computeAnswerUsefulness(reply),
    multi_hop_score: computeMultiHopScore(reply, evalCase.retrieved_chunks),
    repetition_score: computeRepetitionScore(reply),
    faithfulness_score: computeFaithfulnessScore(reply, queryText, contextTexts),
  };
}

// ── DB helpers ────────────────────────────────────────────────────────

export async function saveEvalCase(evalCase: EvalCase): Promise<void> {
  await db.query(
    `INSERT INTO logs (trace_id, gmail_id, step, state, latency_ms, error, meta)
     VALUES ($1, NULL, 'eval_case', 'EVAL', 0, NULL, $2::jsonb)`,
    [
      `eval-${evalCase.email_id}`,
      JSON.stringify(evalCase),
    ],
  );
}

export async function saveEvalResult(result: EvalResult): Promise<void> {
  await db.query(
    `INSERT INTO logs (trace_id, gmail_id, step, state, latency_ms, error, meta)
     VALUES ($1, NULL, 'eval_result', 'EVAL', 0, NULL, $2::jsonb)`,
    [
      `eval-${result.email_id}`,
      JSON.stringify(result),
    ],
  );
}
