import crypto from "crypto";
import { db } from "../db/client";
import {
  getEmbeddingDatasetVersion,
  insertEmbedding,
  embeddingExists,
  embeddingExistsByContentHash,
  searchNearestEmbeddings,
} from "../db/embeddings";
import type { EmailRecord } from "../db/emails";
import { updateEmbeddingStatus } from "../db/emails";
import { createEmbedding, createQueryEmbedding } from "../services/embeddings";
import { extractLatestReply, extractQuotedQuestion, semanticChunk } from "./preprocessor";
import {
  rankChunks,
  deduplicateChunks,
  selectBestChunks,
  classifyQueryIntent,
  type ScoredChunk,
  type UnrankedCandidate,
  type StructuredContextItem,
} from "./ragRanker";
import {
  detectRetrievalIntent,
  keywordBoostTerms,
  rewriteQueryForRetrieval,
  type RetrievalIntent,
} from "./ragIntent";
import { RagTraceBuilder, saveRagTrace } from "./ragObserver";
import { logger } from "../utils/logger";
import { cleanEmailBody } from "../utils/cleanEmail";
import { FLAGS } from "../config/flags";


// Removed StructuredContextItem local definition (moved to ragRanker.ts)


const RAG_CACHE_TTL_MS = 5 * 60 * 1000;
const RAG_MAX_CONTEXT_ITEMS = 4; // Keep generation context dense and readable.

const STRONG_THRESHOLD = 0.35;
const MEDIUM_THRESHOLD = 0.5;
const WEAK_THRESHOLD = 0.72;

const MIN_FINAL_SCORE = 0.25;
const MAX_QUERY_VARIANTS = 3;
const EXPANSION_DIVERGENCE_THRESHOLD = 0.45;
const STALE_CONTEXT_DAYS = 180;

const ragResultCache = new Map<
  string,
  { at: number; datasetVersion: number; rows: StructuredContextItem[] }
>();

function cacheKey(query: string, datasetVersion: number): string {
  return crypto.createHash("md5").update(query + datasetVersion).digest("hex");
}

const NOISE_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bnotification\b/i,
  /\bdo not reply\b/i,
  /\bno-reply\b/i,
  /\bview in browser\b/i,
  /\bmanage preferences\b/i,
  /\bemailjs\.com\b/i,
  /\blinkedin\b/i,
  /\bmedium\.com\b/i,
  /\bdelivery status notification\b/i,
  /\bbuild your network\b/i,
  /\bsent by medium\b/i,
  /\ba message by\b/i,
  /\bthis email was intended for\b/i,
  /\bkindly respond at your earliest convenience\b/i,
];

function normalizeReplyForEmbedding(body: string): string {
  const extracted = extractLatestReply(body);
  const cleaned = cleanEmailBody(extracted);
  return cleaned
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isLowQualityRagSource(email: EmailRecord, reply: string): boolean {
  const haystack = `${email.subject}\n${reply}`;
  if (reply.length < 50) return true;
  if (NOISE_PATTERNS.some((pattern) => pattern.test(haystack))) return true;
  const urlCount = (reply.match(/https?:\/\//g) || []).length;
  if (urlCount >= 3) return true;
  const alphaChars = (reply.match(/[a-z]/gi) || []).length;
  const totalChars = reply.length || 1;
  if (alphaChars / totalChars < 0.45) return true;
  return false;
}

export async function indexEmailForRag(email: EmailRecord): Promise<void> {
  // CRITICAL FIX 3: Strict source detection. Only index our own sent emails.
  if (email.source !== "sent") {
    return;
  }

  const parsed = email.parsed_content && typeof email.parsed_content === "object" && !Array.isArray(email.parsed_content) ? (email.parsed_content as Record<string, unknown>) : {};

  const appGenerated = parsed.app_generated === true || parsed.app_generated === "true";
  const sentByUser = parsed.sent_by_user === true || parsed.sent_by_user === "true";
  const userEdited = parsed.user_edited === true || parsed.user_edited === "true";

  // Embed only manual or user-edited content. Skip untouched app-generated sends.
  if (appGenerated && !userEdited) {
    logger.info("RAG skip: untouched app-generated", { gmailId: email.gmail_id });
    await updateEmbeddingStatus(email.id, "skipped_filter", "Untouched app-generated replies are excluded from sent-memory indexing.");
    return;
  }

  if (!appGenerated && !sentByUser && !userEdited) {
    logger.info("RAG skip: unverified sent source", { gmailId: email.gmail_id });
    await updateEmbeddingStatus(email.id, "skipped_filter", "Sent email missing manual-or-edited metadata for memory indexing.");
    return;
  }

  // HARD TRUNCATION: Extract ONLY the latest response.
  const ourReply = normalizeReplyForEmbedding(email.body);
  if (!ourReply || ourReply.length < 50) {
    logger.info("RAG skip: empty or short reply", { gmailId: email.gmail_id, len: ourReply?.length ?? 0 });
    await updateEmbeddingStatus(email.id, "skipped_short", "Reply content is too short to create a useful memory chunk.");
    return;
  }
  if (isLowQualityRagSource(email, ourReply)) {
    logger.info("RAG skip: filtered noisy/system content", { gmailId: email.gmail_id, subject: email.subject });
    await updateEmbeddingStatus(email.id, "skipped_filter", "Content looked like noisy, quoted, or system-generated text.");
    return;
  }

  // CRITICAL FIX 4: Strong Deduplication using Thread ID + Content Hash.
  const contentHash = crypto.createHash("md5").update(email.thread_id + ourReply).digest("hex");
  
  // First line of defense: code-level check
  if (await embeddingExistsByContentHash(contentHash)) {
    logger.info("RAG skip: duplicate content hash (code-level check)", { gmailId: email.gmail_id, threadId: email.thread_id });
    await updateEmbeddingStatus(email.id, "skipped_duplicate", "This sent reply already exists in memory with the same cleaned content.");
    return;
  }

  const answerChunks = semanticChunk(ourReply).map((text) => ({ text, chunk_type: "answer" as const, sender_type: "us" as const }));
  if (answerChunks.length === 0) {
    await updateEmbeddingStatus(email.id, "skipped_short", "No chunk survived preprocessing after cleaning the latest reply.");
    return;
  }

  logger.info("RAG indexing starting", { gmailId: email.gmail_id, chunks: answerChunks.length, threadId: email.thread_id });

  let embeddedCount = 0;
  try {
    for (const chunk of answerChunks) {
      if (await embeddingExists(email.id, chunk.text)) {
        continue;
      }
      
      const embedding = await createEmbedding(chunk.text);
      if (embedding.length === 1536) {
        await insertEmbedding(
          email.id, 
          chunk.text, 
          embedding, 
          chunk.chunk_type, 
          chunk.sender_type, 
          email.subject, 
          email.thread_id,
          contentHash,
          email.account_id ?? null,
          email.system_id ?? null,
        );
        embeddedCount++;
      }
    }

    if (embeddedCount > 0) {
      await updateEmbeddingStatus(email.id, "embedded");
      logger.info("RAG indexing complete", { gmailId: email.gmail_id, embeddedCount });
    } else {
      await updateEmbeddingStatus(email.id, "skipped_duplicate", "All memory chunks from this email were already indexed.");
    }
  } catch (error) {
    logger.error("RAG indexing failed", { gmailId: email.gmail_id, error: error instanceof Error ? error.message : String(error) });
    await updateEmbeddingStatus(email.id, "failed", error instanceof Error ? error.message : "embedding_error");
  }
}


const STOP_WORDS = new Set([
  "this", "that", "with", "from", "have", "been", "were", "will", "would", "could", "should", "about", "which", "their", "there",
  "when", "what", "your", "some", "them", "than", "then", "each", "also", "into", "very", "just", "more", "most", "only", "such",
  "like", "over", "after", "before", "here", "where", "these", "those", "other", "does", "done", "doing", "being", "make",
  "made", "please", "hello", "dear", "thanks", "thank", "regards", "best", "sincerely", "email", "mail", "sent", "send",
]);

function generateQueryVariants(subject: string, body: string): string[] {
  const original = `${subject}\n${body}`.trim();
  const variants: string[] = [original];
  const words = `${subject} ${body}`.toLowerCase().split(/\s+/).filter((w) => w.length > 3).filter((w) => !STOP_WORDS.has(w));
  const uniqueWords = [...new Set(words)].slice(0, 15);
  if (uniqueWords.length >= 3) variants.push(uniqueWords.join(" "));
  if (subject.length > 10) variants.push(subject);
  return variants.slice(0, MAX_QUERY_VARIANTS);
}

function cosineDist(a: number[], b: number[]): number {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!; normA += a[i]! * a[i]!; normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 1 : 1 - dotProduct / denom;
}

interface ValidatedVariant { text: string; embedding: number[]; divergence: number; source_type: string; }

function applyIntentStrategyBoost(chunks: UnrankedCandidate[], intent: RetrievalIntent, threadId?: string): UnrankedCandidate[] {
  const keywords = keywordBoostTerms(intent);
  return chunks.map((chunk) => {
    let boostedDistance = chunk.distance;
    const searchable = `${chunk.subject} ${chunk.topic ?? ""} ${chunk.chunk_text}`.toLowerCase();

    if (intent === "product_query") {
      const keywordHits = keywords.reduce((count, term) => count + (searchable.includes(term) ? 1 : 0), 0);
      if (keywordHits > 0) {
        boostedDistance = Math.max(0, boostedDistance - Math.min(0.18, keywordHits * 0.04));
      }
    }

    if (intent === "support_query") {
      const sameThreadBoost = threadId && chunk.thread_id && chunk.thread_id === threadId ? 0.18 : 0;
      boostedDistance = Math.max(0, boostedDistance - sameThreadBoost);
    }

    return { ...chunk, distance: boostedDistance };
  });
}

async function getStructuredThreadCandidates(threadId: string, accountId?: number): Promise<UnrankedCandidate[]> {
  if (!threadId) return [];
  const params: Array<string | number> = [threadId];
  let sql = `
    SELECT
      em.id AS chunk_id,
      em.email_id,
      em.chunk_text,
      em.chunk_type,
      em.sender_type,
      em.topic,
      em.thread_id,
      0.62::float AS distance,
      e.subject,
      em.created_at,
      em.embedding::text AS embedding_str,
      0::float AS success_score,
      0::float AS log_retrieved
    FROM email_embeddings em
    JOIN emails e ON e.id = em.email_id
    WHERE em.thread_id = $1
      AND e.source = 'sent'
      AND (
        (
          COALESCE(e.parsed_content->>'app_generated', 'false') = 'true'
          AND COALESCE(e.parsed_content->>'user_edited', 'false') = 'true'
        )
        OR
        (
          COALESCE(e.parsed_content->>'app_generated', 'false') <> 'true'
          AND (
            COALESCE(e.parsed_content->>'sent_by_user', 'false') = 'true'
            OR COALESCE(e.parsed_content->>'user_edited', 'false') = 'true'
          )
        )
      )
  `;
  if (accountId != null) {
    params.push(accountId);
    sql += ` AND e.account_id = $${params.length}`;
  }
  sql += ` ORDER BY em.created_at DESC, em.id DESC LIMIT 8`;

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
    embedding_str: string;
    success_score: number;
    log_retrieved: number;
  }>(sql, params);

  return result.rows.map((row) => ({
    ...row,
    embedding: JSON.parse(row.embedding_str),
    confidence: "medium" as const,
    variant_source: "thread_window",
  }));
}

async function embedAndValidateVariants(subject: string, body: string, trace: RagTraceBuilder): Promise<ValidatedVariant[]> {
  const variants = generateQueryVariants(subject, body);
  const validated: ValidatedVariant[] = [];
  const originalEmbedding = await createQueryEmbedding(variants[0]!);
  if (originalEmbedding.length !== 1536) return [];
  validated.push({ text: variants[0]!, embedding: originalEmbedding, divergence: 0, source_type: "original" });

  for (let i = 1; i < variants.length; i++) {
    const variantEmb = await createQueryEmbedding(variants[i]!);
    if (variantEmb.length !== 1536) continue;
    const divergence = cosineDist(originalEmbedding, variantEmb);
    if (divergence <= EXPANSION_DIVERGENCE_THRESHOLD) {
      validated.push({ text: variants[i]!, embedding: variantEmb, divergence, source_type: i === 1 ? "keywords" : "subject" });
    } else {
      trace.addExpansionDrop(variants[i]!, divergence, EXPANSION_DIVERGENCE_THRESHOLD);
    }
  }
  return validated;
}

function assignConfidence(distance: number): "strong" | "medium" | "weak" {
  if (distance <= STRONG_THRESHOLD) return "strong";
  if (distance <= MEDIUM_THRESHOLD) return "medium";
  return "weak";
}

async function retrieveWithExpansion(
  subject: string,
  body: string,
  trace: RagTraceBuilder,
  datasetVersion: number,
  accountId?: number,
) {
  const rawVariants = await embedAndValidateVariants(subject, body, trace);

  // Phase 5: Keep top 2 performing variants per divergence
  const sortedVariants = rawVariants.sort((a, b) => a.divergence - b.divergence).slice(0, 2);
  const droppedVariants = rawVariants.slice(2);
  for (const dv of droppedVariants) {
    trace.addExpansionDrop(dv.text, dv.divergence, -1); // Dropped because > top 2
  }

  const allAnswers: UnrankedCandidate[] = [];
  const allQuestions: UnrankedCandidate[] = [];
  const seenChunkKeys = new Set<string>();

  for (const variant of sortedVariants) {
    // Phase 3: Fetch top 12-15 initially using up to WEAK_THRESHOLD 1.05
    const answers = await searchNearestEmbeddings(variant.embedding, 12, {
      chunkTypes: ["answer", "explanation"],
      maxDistance: WEAK_THRESHOLD,
      datasetVersion,
      accountId,
    });
    const questions = await searchNearestEmbeddings(variant.embedding, 3, {
      chunkTypes: ["question"],
      maxDistance: WEAK_THRESHOLD,
      datasetVersion,
      accountId,
    });

    for (const a of answers) {
      const key = `${a.email_id}:${a.chunk_text.slice(0, 50)}`;
      if (!seenChunkKeys.has(key)) {
        seenChunkKeys.add(key);
        allAnswers.push({ ...a, confidence: assignConfidence(a.distance), variant_source: variant.source_type });
      }
    }
    for (const q of questions) {
      const key = `${q.email_id}:${q.chunk_text.slice(0, 50)}`;
      if (!seenChunkKeys.has(key)) {
        seenChunkKeys.add(key);
        allQuestions.push({ ...q, confidence: assignConfidence(q.distance), variant_source: variant.source_type });
      }
    }
  }
  return { answers: allAnswers, questions: allQuestions };
}

function filterByConfidenceTiers(chunks: ScoredChunk[]): ScoredChunk[] {
  // Phase 1: 3-tier integration
  const strong = chunks.filter((c) => c.confidence === "strong");
  const medium = chunks.filter((c) => c.confidence === "medium");
  const weak = chunks.filter((c) => c.confidence === "weak");

  const results = [...strong];
  if (results.length < 3) results.push(...medium);
  if (results.length < 2) {
    // Top-ranked weak only, max 2
    results.push(...weak.slice(0, 2));
  }
  return results.sort((a, b) => b.final_score - a.final_score);
}

function groupByThread(answerChunks: ScoredChunk[], questionChunks: UnrankedCandidate[]) {
  const groups = new Map<string, { questionText?: string; answerText: string; topic: string; bestDistance: number; bestScore: number; subject: string; emailId: number; chunkId: number; embedding: number[]; }>();
  for (const ans of answerChunks) {
    const key = ans.thread_id || String(ans.email_id);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        answerText: ans.chunk_text,
        topic: ans.topic || ans.subject,
        bestDistance: ans.distance,
        bestScore: ans.final_score,
        subject: ans.subject,
        emailId: ans.email_id,
        chunkId: ans.chunk_id,
        embedding: ans.embedding,
      });
    } else {
      existing.answerText += `\n\n${ans.chunk_text}`;
      if (ans.final_score > existing.bestScore) {
        existing.bestScore = ans.final_score;
        existing.bestDistance = ans.distance;
        existing.chunkId = ans.chunk_id;
        existing.embedding = ans.embedding;
      } else {
        existing.bestDistance = Math.min(existing.bestDistance, ans.distance);
      }
    }
  }
  for (const q of questionChunks) {
    const key = q.thread_id || String(q.email_id);
    const existing = groups.get(key);
    if (existing) existing.questionText = existing.questionText ? `${existing.questionText}\n\n${q.chunk_text}` : q.chunk_text;
  }
  return Array.from(groups.values()).sort((a, b) => b.bestScore - a.bestScore);
}

function estimateAgeDays(createdAt?: string): number {
  if (!createdAt) return 999;
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created) || created <= 0) return 999;
  return Math.max(0, Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)));
}

function detectContextConflict(items: StructuredContextItem[]): boolean {
  if (items.length < 2) return false;
  const normalized = items.map((item) => item.answer.toLowerCase());
  const conflictMarkers = [/\bnot\b/, /\bnever\b/, /\bcannot\b/, /\bno\b/];
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i]!;
      const b = normalized[j]!;
      const polarityA = conflictMarkers.some((p) => p.test(a));
      const polarityB = conflictMarkers.some((p) => p.test(b));
      if (polarityA !== polarityB) {
        return true;
      }
    }
  }
  return false;
}

function filterConflictingContext(items: StructuredContextItem[]): StructuredContextItem[] {
  if (items.length < 2) return items;
  const kept: StructuredContextItem[] = [];
  for (const item of items) {
    const polarity = /\b(not|never|cannot|can't|no)\b/i.test(item.answer);
    const conflicts = kept.some((k) => {
      const kPolarity = /\b(not|never|cannot|can't|no)\b/i.test(k.answer);
      return kPolarity !== polarity;
    });
    if (!conflicts) {
      kept.push(item);
    }
  }
  return kept.length > 0 ? kept : items.slice(0, 1);
}

function computeRagConfidence(items: StructuredContextItem[]): number {
  if (items.length === 0) return 0;
  const avgDistance = items.reduce((sum, item) => sum + item.distance, 0) / items.length;
  const avgScore = items.reduce((sum, item) => sum + Number(item.final_score ?? 0), 0) / items.length;
  const distanceSignal = Math.max(0, Math.min(1, 1 - avgDistance));
  return Math.max(0, Math.min(1, 0.55 * distanceSignal + 0.45 * avgScore));
}

export interface RagDiagnostics {
  confidenceScore: number;
  conflictDetected: boolean;
  staleFilteredCount: number;
  retrievalIntent: RetrievalIntent;
}

export async function getRelevantContext(
  subject: string, 
  body: string, 
  options?: {
    emailId?: number | undefined;
    traceId?: string | undefined;
    accountId?: number | undefined;
    threadId?: string | undefined;
  }
): Promise<{ items: StructuredContextItem[]; builder: RagTraceBuilder; diagnostics: RagDiagnostics }> {
  const retrievalIntent = detectRetrievalIntent(subject, body);
  const rewrittenBody = rewriteQueryForRetrieval(subject, body, retrievalIntent);
  const query = `${subject}\n${rewrittenBody}`.trim();
  const scopedQuery = `${options?.accountId ?? 0}::${query}`;
  const datasetVersion = await getEmbeddingDatasetVersion();
  const key = cacheKey(scopedQuery, datasetVersion);
  const hit = ragResultCache.get(key);
  if (hit && Date.now() - hit.at < RAG_CACHE_TTL_MS) {
    const trace = new RagTraceBuilder(options?.emailId ?? 0, options?.traceId ?? "unknown", `${subject}\n${body}`.slice(0, 200));
    trace.setQueryIntent(classifyQueryIntent(subject, rewrittenBody));
    trace.setTotalSelected(hit.rows.length);
    return {
      items: hit.rows,
      builder: trace,
      diagnostics: {
        confidenceScore: computeRagConfidence(hit.rows),
        conflictDetected: detectContextConflict(hit.rows),
        staleFilteredCount: 0,
        retrievalIntent,
      },
    };
  }

  const trace = new RagTraceBuilder(options?.emailId ?? 0, options?.traceId ?? "unknown", `${subject}\n${body}`.slice(0, 200));
  const intent = classifyQueryIntent(subject, rewrittenBody);
  trace.setQueryIntent(intent);

  const { answers: semanticAnswers, questions: rawQuestions } = await retrieveWithExpansion(
    subject,
    rewrittenBody,
    trace,
    datasetVersion,
    options?.accountId,
  );

  let rawAnswers = applyIntentStrategyBoost(semanticAnswers, retrievalIntent, options?.threadId);
  let fallbackTier: "thread_local" | "semantic" | "safe_generation" = "semantic";

  if (FLAGS.RAG_HYBRID_ENABLED && options?.threadId) {
    const structured = await getStructuredThreadCandidates(options.threadId, options.accountId);
    const queryText = `${subject} ${body}`.toLowerCase();
    const isFollowUp = /follow\s*up|as discussed|as mentioned|regarding previous|earlier|last message|thread/i.test(queryText);
    const semanticW = isFollowUp ? 0.55 : 0.85;
    const structuredW = isFollowUp ? 0.45 : 0.15;

    rawAnswers = [
      ...semanticAnswers.map((a) => ({ ...a, distance: Math.max(0, a.distance * semanticW) })),
      ...structured.map((s) => ({ ...s, distance: Math.max(0, s.distance * structuredW) })),
    ];
    rawAnswers = applyIntentStrategyBoost(rawAnswers, retrievalIntent, options?.threadId);

    if (structured.length > 0) {
      fallbackTier = "thread_local";
    }
  }

  let strongCnt = 0, mediumCnt = 0, weakCnt = 0;
  for(const c of rawAnswers) {
    if(c.confidence === "strong") strongCnt++;
    else if(c.confidence === "medium") mediumCnt++;
    else weakCnt++;
  }
  trace.setTierCounts(strongCnt, mediumCnt, weakCnt);
  trace.setTotalRetrieved(rawAnswers.length + rawQuestions.length);

  const queryWords = `${subject} ${rewrittenBody}`.toLowerCase().split(/\s+/).filter((w) => w.length > 3).filter((w) => !STOP_WORDS.has(w));
  const queryTerms = [...new Set(queryWords)];
  
  let rankedAnswers = rankChunks(rawAnswers, queryTerms, intent);
  const staleChunkIds = new Set(
    rankedAnswers
      .filter((chunk) => estimateAgeDays(chunk.created_at) > STALE_CONTEXT_DAYS)
      .map((chunk) => chunk.chunk_id),
  );
  rankedAnswers = rankedAnswers.filter((chunk) => !staleChunkIds.has(chunk.chunk_id));

  // Phase 1: 3-tier filtering
  let filteredAnswers = filterByConfidenceTiers(rankedAnswers);

  // Hard score filter - but ensure Minimum Context
  const aboveScore = filteredAnswers.filter((c) => c.final_score >= MIN_FINAL_SCORE);
  const belowScore = filteredAnswers.filter((c) => c.final_score < MIN_FINAL_SCORE);

  // Phase 2: Guarantee minimum context
  if (aboveScore.length < 2 && rankedAnswers.length > 0) {
    // grab the absolute best available regardless of thresholds if we're starving
    filteredAnswers = rankedAnswers.slice(0, 2);
  } else {
    filteredAnswers = aboveScore;
  }

  for (const removed of belowScore) {
    if (!filteredAnswers.includes(removed)) {
      trace.addChunk(removed, "filtered", `score ${removed.final_score.toFixed(3)} < ${MIN_FINAL_SCORE}`);
    }
  }

  rankedAnswers = filteredAnswers;
  trace.setTotalAfterRanking(rankedAnswers.length);

  if (rankedAnswers.length === 0) {
    trace.setTotalSelected(0);
    trace.setFallback("none");
    ragResultCache.set(key, { at: Date.now(), datasetVersion, rows: [] });
    return {
      items: [],
      builder: trace,
      diagnostics: { confidenceScore: 0, conflictDetected: false, staleFilteredCount: staleChunkIds.size, retrievalIntent },
    };
  }

  const deduped = deduplicateChunks(rankedAnswers);
  trace.setTotalAfterDedup(deduped.length);

  const dedupedSet = new Set(deduped);
  for (const chunk of rankedAnswers) {
    if (!dedupedSet.has(chunk)) trace.addChunk(chunk, "deduplicated", "semantic near-duplicate");
  }

  const selected = selectBestChunks(deduped, RAG_MAX_CONTEXT_ITEMS * 2);
  for (const chunk of selected) trace.addChunk(chunk, "selected");

  const threadGroups = groupByThread(selected, rawQuestions);
  const contextItems: StructuredContextItem[] = [];
  for (const group of threadGroups.slice(0, RAG_MAX_CONTEXT_ITEMS)) {
    contextItems.push({ 
      chunk_id: group.chunkId,
      question: group.questionText || null, 
      answer: group.answerText, 
      topic: group.topic || subject, 
      distance: group.bestDistance, 
      subject: group.subject, 
      email_id: group.emailId, 
      final_score: group.bestScore,
      embedding: group.embedding,
    });
  }
  const filteredContextItems = filterConflictingContext(contextItems).slice(0, RAG_MAX_CONTEXT_ITEMS);

  // Unknown intent should remain conservative: avoid forcing weak or misleading context.
  if (retrievalIntent === "unknown") {
    const best = filteredContextItems.slice(0, 2);
    const confidence = computeRagConfidence(best);
    if (confidence < 0.65) {
      trace.setFallback("none");
      ragResultCache.set(key, { at: Date.now(), datasetVersion, rows: [] });
      return {
        items: [],
        builder: trace,
        diagnostics: {
          confidenceScore: 0,
          conflictDetected: false,
          staleFilteredCount: staleChunkIds.size,
          retrievalIntent,
        },
      };
    }
  }

  trace.setTotalSelected(filteredContextItems.length);
  if (filteredContextItems.length === 0) {
    fallbackTier = "safe_generation";
  }
  ragResultCache.set(key, { at: Date.now(), datasetVersion, rows: filteredContextItems });

  // Persist tier hint in trace metadata via fallback field for easy downstream diagnostics.
  if (fallbackTier !== "semantic") {
    trace.setFallback(fallbackTier === "thread_local" ? "relaxed_threshold" : "none");
  }
  return {
    items: filteredContextItems,
    builder: trace,
    diagnostics: {
      confidenceScore: computeRagConfidence(filteredContextItems),
      conflictDetected: detectContextConflict(filteredContextItems),
      staleFilteredCount: staleChunkIds.size,
      retrievalIntent,
    },
  };
}
