import { checkHardSafetyRules, type SafetyViolation } from "./safetyRules";
import { checkModeration } from "../services/moderation";

export interface RiskScoreInput {
  replyText: string;
  aggressionToneScore?: number;
  recipientEmail?: string | null;
  senderEmail?: string | null;
  additionalViolations?: SafetyViolation[];
}

export interface RiskScoreResult {
  score: number;
  reasons: string[];
  components: {
    regex: number;
    moderation: number;
    aggression: number;
    recipient: number;
    legalFinancialIntent: number;
  };
}

const LEGAL_FINANCIAL_INTENT = [
  /\b(refund|reimburse|compensate|chargeback|invoice|payment|wire|bank\s+transfer|settlement)\b/i,
  /\b(guarantee|legally\s+binding|obligation|contract\s+termination|cease\s+and\s+desist)\b/i,
];

function isExternalRecipient(recipientEmail?: string | null, senderEmail?: string | null): boolean {
  if (!recipientEmail || !senderEmail) return false;
  const recipientDomain = recipientEmail.split("@")[1]?.toLowerCase() ?? "";
  const senderDomain = senderEmail.split("@")[1]?.toLowerCase() ?? "";
  if (!recipientDomain || !senderDomain) return false;
  return recipientDomain !== senderDomain;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function legalFinancialIntentScore(text: string): number {
  const hits = LEGAL_FINANCIAL_INTENT.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  if (hits === 0) return 0;
  if (hits === 1) return 0.55;
  return 0.9;
}

export async function computeRiskScore(input: RiskScoreInput): Promise<RiskScoreResult> {
  const replyText = input.replyText ?? "";
  const reasons: string[] = [];

  const hardViolations = checkHardSafetyRules(replyText);
  const mergedViolations = [...hardViolations, ...(input.additionalViolations ?? [])];
  const blockCount = mergedViolations.filter((v) => v.severity === "block").length;
  const reviewCount = mergedViolations.filter((v) => v.severity === "review").length;
  const regexComponent = clamp01(blockCount * 0.5 + reviewCount * 0.2);
  if (regexComponent > 0) {
    reasons.push(`regex_hits:${blockCount + reviewCount}`);
  }

  let moderationComponent = 0;
  try {
    const moderation = await checkModeration(replyText);
    if (moderation?.flagged) {
      const maxScore = Math.max(0, ...Object.values(moderation.scores));
      moderationComponent = clamp01(maxScore);
      reasons.push(`moderation:${moderation.categories.join(",") || "flagged"}`);
    }
  } catch {
    // Graceful degradation: risk engine should still produce output.
  }

  const aggression = clamp01(input.aggressionToneScore ?? 0);
  if (aggression >= 0.7) {
    reasons.push(`aggression:${aggression.toFixed(2)}`);
  }

  const external = isExternalRecipient(input.recipientEmail, input.senderEmail);
  const recipientComponent = external ? 1 : 0;
  if (external) {
    reasons.push("external_recipient");
  }

  const legalFinancial = legalFinancialIntentScore(replyText);
  if (legalFinancial > 0) {
    reasons.push("legal_financial_intent");
  }

  const weighted =
    regexComponent * 0.35 +
    moderationComponent * 0.3 +
    aggression * 0.15 +
    recipientComponent * 0.08 +
    legalFinancial * 0.12;

  return {
    score: clamp01(weighted),
    reasons,
    components: {
      regex: regexComponent,
      moderation: moderationComponent,
      aggression,
      recipient: recipientComponent,
      legalFinancialIntent: legalFinancial,
    },
  };
}
