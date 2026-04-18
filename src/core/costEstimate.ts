import type { StructuredContextItem } from "./ragRanker";

export type ModelTier = "small" | "medium" | "large";

export interface CostEstimateInput {
  subject: string;
  body: string;
  ragContext: StructuredContextItem[];
  model: string;
  priorityScore: number;
  budgetRemainingTokens: number;
}

export interface CostEstimateResult {
  promptTokens: number;
  expectedOutputTokens: number;
  estimatedTotalTokens: number;
  costScore: number;
  recommendedModelTier: ModelTier;
  skipRag: boolean;
  compressPrompt: boolean;
  reasons: string[];
}

function estimateTokens(text: string): number {
  // Practical heuristic for GPT-like tokenization.
  return Math.max(1, Math.ceil(text.length / 4));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function modelMultiplier(model: string): number {
  const lower = model.toLowerCase();
  if (lower.includes("mini") || lower.includes("small")) return 0.75;
  if (lower.includes("gpt-4.1") || lower.includes("large")) return 1.2;
  return 1;
}

export function estimateGenerationCost(input: CostEstimateInput): CostEstimateResult {
  const reasons: string[] = [];
  const subjectTokens = estimateTokens(input.subject ?? "");
  const bodyTokens = estimateTokens(input.body ?? "");
  const ragTokens = input.ragContext.reduce((sum, item) => sum + estimateTokens(item.answer ?? ""), 0);
  const systemOverhead = 300;

  const promptTokens = Math.ceil((subjectTokens + bodyTokens + ragTokens + systemOverhead) * modelMultiplier(input.model));
  const expectedOutputTokens = Math.max(120, Math.ceil(bodyTokens * 0.45));
  const estimatedTotalTokens = promptTokens + expectedOutputTokens;

  const budgetPressure = input.budgetRemainingTokens <= 0 ? 1 : clamp01(estimatedTotalTokens / input.budgetRemainingTokens);
  const costScore = clamp01(0.7 * budgetPressure + 0.3 * clamp01(promptTokens / 6000));

  let skipRag = false;
  let compressPrompt = false;
  let recommendedModelTier: ModelTier = "medium";

  if (costScore >= 0.8 && input.priorityScore <= 0.45) {
    skipRag = true;
    compressPrompt = true;
    recommendedModelTier = "small";
    reasons.push("low_priority_high_cost");
  } else if (costScore >= 0.65) {
    compressPrompt = true;
    reasons.push("prompt_compression_recommended");
  }

  if (promptTokens > 4500) {
    compressPrompt = true;
    reasons.push("oversized_prompt");
  }

  if (input.ragContext.length >= 4 && input.priorityScore < 0.6) {
    reasons.push("rag_context_expensive");
  }

  return {
    promptTokens,
    expectedOutputTokens,
    estimatedTotalTokens,
    costScore,
    recommendedModelTier,
    skipRag,
    compressPrompt,
    reasons,
  };
}
