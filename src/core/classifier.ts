import type { AppConfig } from "../db/config";
import type { EmailRecord } from "../db/emails";
import { callLlm, safeLLMCall } from "../services/llm";
import { z } from "zod";

export interface ClassificationResult {
  category: string;
  confidence: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  promptVersion: string;
  fallbackError?: string;
  reason?: string;
}

function extractJsonPayload(text: string): string {
  const trimmed = text.trim();

  // Handle markdown fenced blocks like ```json ... ```.
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split(/\r?\n/);
    if (lines.length >= 3 && lines[0]?.startsWith("```") && lines[lines.length - 1]?.startsWith("```")) {
      return lines.slice(1, -1).join("\n").trim();
    }
  }

  // Handle extra prose before/after the JSON object.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function normalizeCategoryKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resolveAllowedCategory(rawCategory: string, categories: string[]): string | null {
  const direct = categories.find((item) => item === rawCategory);
  if (direct) return direct;

  const normalizedRaw = normalizeCategoryKey(rawCategory);
  if (!normalizedRaw) return null;

  const normalizedMatch = categories.find((item) => normalizeCategoryKey(item) === normalizedRaw);
  return normalizedMatch ?? null;
}

async function realClassifierCall(
  email: EmailRecord,
  config: AppConfig,
  threadMessages?: unknown[],
  model?: string,
): Promise<ClassificationResult> {
  const categories = Object.keys(config.category_rules);

  const responseSchema = z
    .object({
      category: z.string().min(1),
      confidence: z.coerce.number().min(0).max(1),
    })
    .strict();

  const prompt = [
    "Classify this email into exactly one category from the allowed list.",
    `Allowed categories (exact match required): ${JSON.stringify(categories)}`,
    'Return STRICT JSON only with exactly these keys: {"category":"...","confidence":0.0}',
    "category MUST be EXACTLY one of the allowed category names.",
    "confidence MUST be a number from 0 to 1.",
    "If multiple categories seem applicable, choose the most specific category.",
    "If uncertain, return confidence < 0.5.",
    ...(threadMessages ? ["Recent thread messages:", JSON.stringify(threadMessages)] : []),
    `Subject: ${email.subject}`,
    `Body: ${email.body}`,
  ].join("\n");
  console.log("LLM call Started");
  const llm = await callLlm(prompt, model ? { model, task: "classification" } : { task: "classification" });
  if (llm.error) {
    console.error(llm.error);
    throw new Error(llm.error);
  }
  console.log("LLM response:", llm);
  let parsed: Partial<ClassificationResult>;
  try {
    const raw = JSON.parse(extractJsonPayload(llm.text)) as unknown;
    const validated = responseSchema.safeParse(raw);
    if (!validated.success) {
      return {
        category: categories[0] ?? "general",
        confidence: 0,
        tokensIn: llm.tokensIn,
        tokensOut: llm.tokensOut,
        latencyMs: llm.latencyMs,
        promptVersion: "classifier.invalid_json_fallback.v1",
        reason: "invalid_classification_json_schema",
      };
    }
    parsed = validated.data as Partial<ClassificationResult>;
  } catch {
    return {
      category: categories[0] ?? "general",
      confidence: 0,
      tokensIn: llm.tokensIn,
      tokensOut: llm.tokensOut,
      latencyMs: llm.latencyMs,
      promptVersion: "classifier.invalid_json_fallback.v1",
      reason: "invalid_json_no_retry",
    };
  }

  const rawCategory = typeof parsed.category === "string" ? parsed.category : "";
  const category = resolveAllowedCategory(rawCategory, categories);
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;

  if (!category) {
    return {
      category: categories[0] ?? "general",
      confidence: 0,
      tokensIn: llm.tokensIn,
      tokensOut: llm.tokensOut,
      latencyMs: llm.latencyMs,
      promptVersion: "classifier.v1",
      reason: "invalid_category_no_match",
    };
  }

  return {
    category,
    confidence: Math.max(0, Math.min(1, confidence)),
    tokensIn: llm.tokensIn,
    tokensOut: llm.tokensOut,
    latencyMs: llm.latencyMs,
    promptVersion: "classifier.v1",
  };
}

export async function classifyEmail(email: EmailRecord, config: AppConfig, model?: string): Promise<ClassificationResult> {
  const result = await safeLLMCall(() => realClassifierCall(email, config, undefined, model), "classification");
  if (!result.success) {
    return {
      category: "unknown",
      confidence: 0,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      promptVersion: "classifier.fallback.v1",
      reason: "fallback_due_to_llm_failure",
      fallbackError: result.error,
    };
  }
  return result.data;
}

export async function classifyEmailWithThread(
  email: EmailRecord,
  config: AppConfig,
  threadMessages: unknown[],
  model?: string,
): Promise<ClassificationResult> {
  const result = await safeLLMCall(
    () => realClassifierCall(email, config, threadMessages, model),
    "classification_with_thread",
  );
  if (!result.success) {
    return {
      category: "unknown",
      confidence: 0,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      promptVersion: "classifier.fallback.v2",
      reason: "fallback_due_to_llm_failure",
      fallbackError: result.error,
    };
  }
  return result.data;
}
