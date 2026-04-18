import type { AppConfig } from "../db/config";

export type ReplyDecision = "assist" | "manual" | "auto";

export interface DecisionInput {
  category: string;
  confidence: number;
  config: AppConfig;
  riskScore?: number;
  costScore?: number;
  priorityScore?: number;
  ragConfidence?: number;
}

export interface DecisionOutput {
  decision: ReplyDecision;
  reason: string;
  useRag: boolean;
  modelTier: "small" | "medium" | "large";
}

export function decideAction(input: DecisionInput): DecisionOutput {
  const { global_mode, category_rules, threshold } = input.config;
  const riskScore = Math.max(0, Math.min(1, input.riskScore ?? 0));
  const costScore = Math.max(0, Math.min(1, input.costScore ?? 0));
  const priorityScore = Math.max(0, Math.min(1, input.priorityScore ?? 0.5));
  const ragConfidence = Math.max(0, Math.min(1, input.ragConfidence ?? 0.5));
  const normalizedCategory = (input.category ?? "").trim().toLowerCase();
  const MODE_ORDER = {
    manual: 0,
    assist: 1,
    auto: 2,
  } as const;

  if (global_mode === "manual") {
    return {
      decision: "manual",
      reason: "Global mode is manual",
      useRag: true,
      modelTier: "medium",
    };
  }

  if (input.confidence === 0) {
    // Confidence 0 should always stop before generation.
    return {
      decision: "manual",
      reason: "Classifier confidence is 0",
      useRag: true,
      modelTier: "medium",
    };
  }

  if (riskScore >= 0.72) {
    return {
      decision: "manual",
      reason: `High risk score (${riskScore.toFixed(2)})`,
      useRag: true,
      modelTier: "small",
    };
  }

  const rawRule =
    category_rules[input.category] ??
    category_rules[normalizedCategory] ??
    category_rules[
      Object.keys(category_rules).find((key) => key.toLowerCase() === normalizedCategory) ?? ""
    ];
  const ruleMode = typeof rawRule === "string" ? rawRule : rawRule?.mode;

  const ruleThreshold =
    typeof rawRule === "string"
      ? threshold
      : typeof rawRule?.confidence_threshold === "number"
      ? rawRule.confidence_threshold
      : threshold;

  const restrictedMode = !ruleMode
    ? global_mode
    : MODE_ORDER[global_mode] < MODE_ORDER[ruleMode as ReplyDecision]
    ? global_mode
    : (ruleMode as ReplyDecision);

  if (input.confidence < ruleThreshold) {
    console.info(
      JSON.stringify({
        level: "info",
        event: "threshold_block",
        category: input.category,
        confidence: input.confidence,
        threshold: ruleThreshold,
        ts: new Date().toISOString(),
      }),
    );
    return {
      decision: restrictedMode === "manual" ? "manual" : "assist",
      reason: `Below threshold ${ruleThreshold.toFixed(2)} with confidence ${input.confidence.toFixed(2)}`,
      useRag: true,
      modelTier: "medium",
    };
  }

  if (ragConfidence < 0.3) {
    return {
      decision: "assist",
      reason: `Low RAG confidence (${ragConfidence.toFixed(2)}) - review before send`,
      useRag: false,
      modelTier: "small",
    };
  }

  if (costScore >= 0.75 && priorityScore <= 0.45) {
    return {
      decision: "assist",
      reason: `High estimated cost (${costScore.toFixed(2)}) and low priority (${priorityScore.toFixed(2)})`,
      useRag: false,
      modelTier: "small",
    };
  }

  const finalDecision = restrictedMode;
  return {
    decision: finalDecision,
    reason: `Decision=${finalDecision}, risk=${riskScore.toFixed(2)}, cost=${costScore.toFixed(2)}, priority=${priorityScore.toFixed(2)}, rag=${ragConfidence.toFixed(2)}`,
    useRag: true,
    modelTier: finalDecision === "auto" ? "medium" : "small",
  };
}
