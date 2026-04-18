import crypto from "crypto";

import type { EmailRecord } from "../db/emails";
import { withLlmResponseCache } from "../lib/runtimeCache";
import { callLlm, safeLLMCall } from "../services/llm";
import type { StructuredContextItem } from "./ragRanker";
import { cleanEmailBody } from "../utils/cleanEmail";
import { validateReply } from "./replyValidator";
import { assessThreadToneConsistency } from "./toneSignature";
import {
  compareVoiceStyle,
  extractVoiceStyleFeatures,
  selectVoiceStyleReferences,
  summarizeThreadTone,
  summarizeVoiceStyle,
  type StyleReference,
  type ThreadToneProfile,
  type VoiceStyleFeatures,
} from "./voiceCloner";
import { styleConfidenceFromSignature, type StyleSignature } from "./styleSignature";
import { getUserStyleSignature } from "../db/auth";

export interface GenerationResult {
  reply: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  promptVersion: string;
  fallbackError?: string | undefined;
  isFallback?: boolean | undefined;
  contextStrength?: "strong" | "weak" | "none" | undefined;
  validationIssues?: number | undefined;
  contextUtilizationPct?: number | undefined;
  contextChunksUsed?: number | undefined;
  toneConsistency?: number | undefined;
  voiceMatchScore?: number | undefined;
  styleConfidence?: number | undefined;
}

// ── Context strength classification ───────────────────────────────────

function classifyContextStrength(
  ragContext: StructuredContextItem[],
): "strong" | "weak" | "none" {
  if (ragContext.length === 0) return "none";

  const avgDistance =
    ragContext.reduce((sum, c) => sum + c.distance, 0) / ragContext.length;

  if (ragContext.length >= 2 && avgDistance < 0.6) return "strong";
  return "weak";
}

// ── Knowledge block formatting ────────────────────────────────────────

function formatKnowledgeBlocks(
  ragContext: StructuredContextItem[],
  strength: "strong" | "weak" | "none",
): string {
  if (strength === "none") {
    return "No relevant past knowledge found. Write a helpful reply from scratch.";
  }

  const blocks = ragContext
    .map((item, i) => {
      const relevanceHeader = i < 2 ? "[HIGH RELEVANCE]" : "[MEDIUM RELEVANCE]";
      const parts = [`${relevanceHeader} BLOCK ${i + 1}:`];
      if (item.topic) parts.push(`  Topic: ${item.topic}`);
      if (item.question) parts.push(`  Related Question: ${item.question}`);
      
      parts.push(`  Summary:\n  ${item.answer.replace(/\n/g, "\n  ")}`);
      
      return parts.join("\n");
    })
    .join("\n\n");

  return blocks;
}

// ── Utilization Detection ─────────────────────────────────────────────

function computeUtilizationMetrics(reply: string, context: StructuredContextItem[]) {
  if (context.length === 0) return { pct: 0, chunksUsed: 0 };
  const replyLower = reply.toLowerCase();
  let utilizedChunks = 0;
  for (const item of context) {
    const chunkWords = item.answer.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    if (chunkWords.length === 0) continue;
    const matchCount = chunkWords.filter((w) => replyLower.includes(w)).length;
    if (matchCount / chunkWords.length >= 0.25) utilizedChunks++;
  }
  return {
    pct: utilizedChunks / context.length,
    chunksUsed: utilizedChunks,
  };
}

function hashStyleReferences(references: StyleReference[], threadTone: ThreadToneProfile | null): string {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        refs: references.map((reference) => ({
          emailId: reference.emailId,
          threadId: reference.threadId,
          distance: reference.distance,
          features: reference.features,
        })),
        threadTone: threadTone
          ? {
              tone: threadTone.tone,
              intensity: threadTone.intensity,
              verbosity: threadTone.verbosity,
              punctuation_style: threadTone.punctuation_style,
              slang_usage: threadTone.slang_usage,
              consistency: threadTone.consistency,
            }
          : null,
      }),
    )
    .digest("hex");
}

function formatVoiceStyleFeatures(features: VoiceStyleFeatures): string {
  const summary = summarizeVoiceStyle(features);
  return [
    `avg_length: ${features.avg_length.toFixed(1)} words per sentence`,
    `punctuation_density: ${features.punctuation_density.toFixed(3)}`,
    `aggression_level: ${features.aggression_level.toFixed(3)}`,
    `slang_usage: ${features.slang_usage.toFixed(3)} (${summary.slang_usage})`,
    `directness_level: ${features.directness_level.toFixed(3)}`,
    `tone: ${summary.tone}`,
    `intensity: ${summary.intensity}`,
    `verbosity: ${summary.verbosity}`,
    `punctuation_style: ${summary.punctuation_style}`,
  ].join("\n");
}

function formatStyleReferences(references: StyleReference[]): string {
  if (references.length === 0) {
    return "No style references were found. Use a natural human tone that matches the current thread.";
  }

  return references
    .map((reference, index) => {
      const snippet = reference.body.length > 900 ? `${reference.body.slice(0, 900).trim()}...` : reference.body;
      return [
        `REFERENCE ${index + 1}:`,
        `Subject: ${reference.subject}`,
        `Thread: ${reference.threadId}`,
        `Style features:`,
        formatVoiceStyleFeatures(reference.features),
        `Reply excerpt:`,
        snippet,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function buildReplyPrompt(input: {
  email: EmailRecord;
  cleanBody: string;
  knowledgeBlocks: string;
  threadContext: string;
  styleReferences: StyleReference[];
  styleTarget: VoiceStyleFeatures;
  threadTone: ThreadToneProfile;
  fallbackToneMode: boolean;
}): string {
  const styleSummary = summarizeVoiceStyle(input.styleTarget);

  return [
    "You are writing as the user. You are not an assistant.",
    "",
    "You will be given STYLE REFERENCES and STYLE FEATURES.",
    "Your job is to CLONE the user's voice.",
    "",
    "STYLE REFERENCES:",
    formatStyleReferences(input.styleReferences),
    "",
    "STYLE FEATURES:",
    `* tone: ${styleSummary.tone}`,
    `* intensity: ${styleSummary.intensity}`,
    `* verbosity: ${styleSummary.verbosity}`,
    `* punctuation style: ${styleSummary.punctuation_style}`,
    `* slang usage: ${styleSummary.slang_usage}`,
    `* avg length: ${input.styleTarget.avg_length.toFixed(1)} words`,
    `* punctuation density: ${input.styleTarget.punctuation_density.toFixed(3)}`,
    `* aggression level: ${input.styleTarget.aggression_level.toFixed(3)}`,
    `* directness level: ${input.styleTarget.directness_level.toFixed(3)}`,
    "",
    "THREAD CONTINUITY:",
    `* thread tone: ${input.threadTone.tone}`,
    `* thread intensity: ${input.threadTone.intensity}`,
    `* continuity score: ${input.threadTone.consistency.toFixed(2)}`,
    "",
    "CURRENT EMAIL:",
    `Subject: ${input.email.subject}`,
    "Message:",
    input.cleanBody,
    "",
    "THREAD CONTEXT:",
    input.threadContext,
    "",
    "RULES:",
    "* Match tone EXACTLY (do not neutralize)",
    "* Match emotional intensity",
    "* Match sentence structure and rhythm",
    "* Use similar wording style (but do not copy sentences)",
    "* If aggressive -> be aggressive",
    "* If casual -> be casual",
    "* If short -> stay short",
    input.fallbackToneMode ? "* The RAG signal is weak, so stay natural and human, not robotic." : "* Use the references and thread continuity as the primary style controls.",
    "",
    "STRICT:",
    "* Do NOT sound like AI",
    "* Do NOT over-explain",
    "* Do NOT sanitize tone unless unsafe",
    "* Do NOT mix tones randomly",
    "",
    "OUTPUT:",
    "Return only the reply.",
    "",
    "KNOWLEDGE:",
    input.knowledgeBlocks,
  ].join("\n");
}

function buildRepairPrompt(input: {
  basePrompt: string;
  mismatchNotes: string[];
}): string {
  return [
    input.basePrompt,
    "",
    "REPAIR INSTRUCTIONS:",
    `The generated reply missed the target voice: ${input.mismatchNotes.join(", ") || "voice drift"}`,
    "Rewrite the reply so it matches the style references, style features, and thread continuity more closely.",
    "Return only the reply.",
  ].join("\n");
}

async function buildVoiceContext(
  email: EmailRecord,
  threadMessages: unknown[],
  userId?: number | null,
): Promise<{
  styleReferences: StyleReference[];
  styleTarget: VoiceStyleFeatures;
  threadTone: ThreadToneProfile;
  cacheKey: string;
  fallbackToneMode: boolean;
  userSignature: StyleSignature | null;
}> {
  const threadBodies = (threadMessages ?? [])
    .map((message) => (typeof message === "object" && message && "body" in (message as object) ? String((message as any).body ?? "") : ""))
    .filter(Boolean);

  const styleContext = await selectVoiceStyleReferences({
    email,
    accountId: email.account_id ?? null,
    userId: userId ?? null,
    limit: 3,
  });

  const threadTone = summarizeThreadTone(threadBodies);
  const styleTarget = styleContext.target ?? threadTone.features ?? extractVoiceStyleFeatures(cleanEmailBody(email.body));
  const fallbackToneMode = styleContext.references.length === 0 || styleContext.target == null;
  const rawSignature = userId ? await getUserStyleSignature(userId) : null;
  const userSignature = (rawSignature as StyleSignature | null) ?? null;

  return {
    styleReferences: styleContext.references,
    styleTarget,
    threadTone,
    cacheKey: hashStyleReferences(styleContext.references, threadTone),
    fallbackToneMode,
    userSignature,
  };
}

function cacheIdentity(email: EmailRecord, ragContext: StructuredContextItem[], voiceCacheKey: string): string[] {
  const emailHash = crypto
    .createHash("sha1")
    .update(`${email.subject}\n${cleanEmailBody(email.body)}`)
    .digest("hex");
  const contextHash = crypto
    .createHash("sha1")
    .update(
      JSON.stringify(
        ragContext.map((item) => ({
          chunk_id: item.chunk_id,
          subject: item.subject,
          answer: item.answer,
          distance: item.distance,
        })),
      ),
    )
    .digest("hex");
    return ["generator.v8", emailHash, contextHash, voiceCacheKey];
  return ["generator.v7", emailHash, contextHash];
}

// ── Main generator ────────────────────────────────────────────────────
//
// REMOVED: The "6-point self-validation" prompt block.
//
// Why: LLMs don't truly validate — they rationalize. Self-validation
// adds tokens and verbosity but does NOT improve correctness.
//
// Replaced with: programmatic post-validation in replyValidator.ts
// that catches real issues (repetition, leakage, stale data) via
// code-level pattern matching after the LLM generates.

async function realGeneratorCall(
  email: EmailRecord,
  ragContext: StructuredContextItem[],
  threadMessages: unknown[],
  identity?: { displayName?: string | null; email?: string | null },
  voiceContext?: Awaited<ReturnType<typeof buildVoiceContext>>,
  model?: string,
  userId?: number | null,
): Promise<GenerationResult> {
  const cleanBody = cleanEmailBody(email.body);
  const contextStrength = classifyContextStrength(ragContext);
  const knowledgeBlocks = formatKnowledgeBlocks(ragContext, contextStrength);
  const builtVoiceContext = voiceContext ?? (await buildVoiceContext(email, threadMessages, userId ?? null));
  const threadBodies = (threadMessages ?? [])
    .map((message) => (typeof message === "object" && message && "body" in (message as object) ? String((message as any).body ?? "") : ""))
    .filter(Boolean);
  const ownerHints = [identity?.displayName, identity?.email, "us"]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  const isOwner = (fromValue: unknown) => {
    const candidate = typeof fromValue === "string" ? fromValue.toLowerCase() : "";
    return ownerHints.some((hint) => candidate.includes(hint));
  };

  const lastUserMsg = [...(threadMessages ?? [])].reverse().find((message) => !isOwner((message as any)?.from));
  const lastAssistantMsg = [...(threadMessages ?? [])].reverse().find((message) => isOwner((message as any)?.from));

  const threadContextParts: string[] = [];
  if (lastUserMsg) {
    const body = String((lastUserMsg as any)?.body ?? "").substring(0, 300);
    threadContextParts.push(`LATEST USER MESSAGE (From: ${(lastUserMsg as any)?.from ?? "unknown"}):\n${body}${String((lastUserMsg as any)?.body ?? "").length > 300 ? "..." : ""}`);
  }
  if (lastAssistantMsg) {
    const body = String((lastAssistantMsg as any)?.body ?? "").substring(0, 300);
    threadContextParts.push(`LATEST ASSISTANT RESPONSE:\n${body}${String((lastAssistantMsg as any)?.body ?? "").length > 300 ? "..." : ""}`);
  }

  const threadContext = threadContextParts.length > 0
    ? threadContextParts.join("\n\n---\n\n")
    : "No previous relevant messages in this thread.";

  const basePrompt = buildReplyPrompt({
    email,
    cleanBody,
    knowledgeBlocks,
    threadContext,
    styleReferences: builtVoiceContext.styleReferences,
    styleTarget: builtVoiceContext.styleTarget,
    threadTone: builtVoiceContext.threadTone,
    fallbackToneMode: builtVoiceContext.fallbackToneMode,
  });

  const attempts = [basePrompt, buildRepairPrompt({ basePrompt, mismatchNotes: [] })];
  let lastReply = "";
  let llmMetrics = { tokensIn: 0, tokensOut: 0, latencyMs: 0 };
  let validationIssues: number | undefined;
  let voiceMatchScore: number | undefined;
  let selectedPromptVersion = "generator.v8";

  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    const prompt = attempts[attemptIndex]!;
    const llm = await callLlm(prompt, model ? { model, task: "generation" } : { task: "generation" });
    if (llm.error) {
      if (attemptIndex === attempts.length - 1) {
        throw new Error(llm.error);
      }
      continue;
    }

    let replyText = (llm.text ?? "").toString().trim();
    if (replyText.length < 5) {
      if (attemptIndex === attempts.length - 1) {
        throw new Error("generator: empty/too-short reply");
      }
      continue;
    }

    const validation = validateReply(replyText, email.body, email.trace_id ?? undefined);
    replyText = validation.cleaned_reply;

    const expectedVoice = builtVoiceContext.styleTarget;
    const actualVoice = extractVoiceStyleFeatures(replyText);
    const voiceComparison = compareVoiceStyle(actualVoice, expectedVoice);
    const signatureConfidence = styleConfidenceFromSignature(actualVoice, builtVoiceContext.userSignature);
    const threadConsistency = threadBodies.length > 0 ? assessThreadToneConsistency(threadBodies, replyText) : 0.7;
    const meetsVoiceTarget = voiceComparison.score >= 0.6 && threadConsistency >= 0.45 && signatureConfidence >= 0.55;

    llmMetrics = {
      tokensIn: llm.tokensIn,
      tokensOut: llm.tokensOut,
      latencyMs: llm.latencyMs,
    };
    validationIssues = validation.issues.length > 0 ? validation.issues.length : undefined;
    voiceMatchScore = Number((voiceComparison.score * 0.5 + threadConsistency * 0.25 + signatureConfidence * 0.25).toFixed(3));

    if (meetsVoiceTarget) {
      lastReply = replyText;
      selectedPromptVersion = attemptIndex === 0 ? "generator.v8" : "generator.v8.repair";
      break;
    }

    if (attemptIndex === 0) {
      attempts[1] = buildRepairPrompt({
        basePrompt,
        mismatchNotes: voiceComparison.notes.length > 0 ? voiceComparison.notes : ["voice drift"],
      });
      lastReply = replyText;
      selectedPromptVersion = "generator.v8.repair";
      continue;
    }

    lastReply = replyText;
  }

  if (!lastReply.trim()) {
    const threadTone = builtVoiceContext.threadTone.tone;
    lastReply =
      threadTone === "aggressive"
        ? "I saw this. I’ll handle it and follow up directly."
        : threadTone === "casual"
          ? "Got it. I’ll take a look and get back to you soon."
          : "Got it. I’ll review this and reply shortly.";
  }

  const utilization = computeUtilizationMetrics(lastReply, ragContext);
  const toneConsistency = assessThreadToneConsistency(threadBodies, lastReply);

  return {
    reply: lastReply,
    tokensIn: llmMetrics.tokensIn,
    tokensOut: llmMetrics.tokensOut,
    latencyMs: llmMetrics.latencyMs,
    promptVersion: selectedPromptVersion,
    isFallback: voiceMatchScore != null ? voiceMatchScore < 0.6 : false,
    contextStrength,
    validationIssues,
    contextUtilizationPct: utilization.pct,
    contextChunksUsed: utilization.chunksUsed,
    toneConsistency,
    voiceMatchScore,
    styleConfidence: voiceMatchScore,
  };
}

export async function generateReply(
  email: EmailRecord,
  ragContext: StructuredContextItem[],
  threadMessages: unknown[],
  identity?: { displayName?: string | null; email?: string | null },
  model?: string,
  userId?: number | null,
): Promise<GenerationResult> {
  const voiceContext = await buildVoiceContext(email, threadMessages, userId ?? null);
  const result = await safeLLMCall(
    () =>
      withLlmResponseCache(cacheIdentity(email, ragContext, voiceContext.cacheKey), () =>
        realGeneratorCall(email, ragContext, threadMessages, identity, voiceContext, model, userId ?? null),
      ),
    "generation",
  );

  if (!result.success) {
    return {
      reply: `Hi, we received your message regarding "${email.subject}". Our team will look into it shortly.`,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      promptVersion: "generator.fallback.v3",
      fallbackError: result.error,
      isFallback: true,
      contextStrength: "none",
    };
  }

  return result.data;
}
