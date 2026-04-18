export type ModelTier = "low" | "mid" | "high";
export type ModelTask = "classification" | "generation" | "intent";

export interface ModelRoutingInput {
  priorityScore: number;
  riskScore: number;
  costScore: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function selectModelTier(input: ModelRoutingInput): ModelTier {
  const priority = clamp01(input.priorityScore);
  const risk = clamp01(input.riskScore);
  const cost = clamp01(input.costScore);

  if (risk >= 0.75 || priority >= 0.8) return "high";
  if (cost >= 0.75 && priority <= 0.45 && risk < 0.55) return "low";
  return "mid";
}

export function modelForTask(task: ModelTask, tier: ModelTier): string {
  if (task === "generation") {
    if (tier === "high") return "gpt-4.1";
    if (tier === "mid") return "gpt-4.1-mini";
    return "gpt-4o-mini";
  }

  if (task === "classification") {
    if (tier === "high") return "gpt-4.1-mini";
    if (tier === "mid") return "gpt-4o-mini";
    return "gpt-4o-mini";
  }

  // intent
  if (tier === "high") return "gpt-4.1-mini";
  if (tier === "mid") return "gpt-4o-mini";
  return "gpt-4o-mini";
}
