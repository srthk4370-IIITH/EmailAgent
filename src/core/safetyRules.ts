/**
 * Safety Rules — Hard regex blocks for dangerous content.
 *
 * These are deterministic, code-level checks that catch content
 * the LLM should never autonomously send. They run BEFORE any
 * send operation and cannot be overridden by confidence or mode.
 *
 * Voice cloning is preserved — these rules don't suppress tone,
 * they suppress dangerous *intent* in the generated text.
 */

export interface SafetyViolation {
  layer: "hard_block" | "moderation" | "context_gate";
  rule: string;
  matched: string;
  severity: "block" | "review";
}

// ── Legal commitment patterns ─────────────────────────────────────────
const LEGAL_COMMITMENT_PATTERNS = [
  { pattern: /\bwe\s+(will|shall)\s+(refund|pay|compensate|reimburse|credit)\b/i, rule: "legal_commitment_refund" },
  { pattern: /\bi\s+(will|shall)\s+(refund|pay|compensate|reimburse)\b/i, rule: "legal_commitment_personal" },
  { pattern: /\b(guaranteed|guarantee)\s+(refund|payment|outcome|result|delivery)\b/i, rule: "legal_guarantee" },
  { pattern: /\b(binding\s+agreement|legally\s+bound|contract\s+obligat)/i, rule: "legal_binding" },
  { pattern: /\b(agree\s+to\s+pay|commit\s+to\s+pay|obligation\s+to\s+pay)\b/i, rule: "legal_payment_obligation" },
];

// ── Financial promise patterns ────────────────────────────────────────
const FINANCIAL_PATTERNS = [
  { pattern: /\b(invoice\s+approved|payment\s+sent|transfer\s+initiated|wire\s+sent)\b/i, rule: "financial_false_confirmation" },
  { pattern: /\b(funds?\s+(?:have\s+been|were|are)\s+(?:sent|transferred|wired|deposited))\b/i, rule: "financial_false_transfer" },
  { pattern: /\b(approved?\s+(?:the|your)\s+(?:invoice|payment|expense|claim))\b/i, rule: "financial_false_approval" },
  { pattern: /\$\d{3,}|\b\d{4,}\s*(?:dollars|usd|eur|gbp)\b/i, rule: "financial_specific_amount" },
];

// ── Secret / credential patterns ──────────────────────────────────────
const SECRET_PATTERNS = [
  { pattern: /\b(api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token)\b/i, rule: "secret_api_key" },
  { pattern: /\b(password|passwd|credential)\s*[:=]/i, rule: "secret_password" },
  { pattern: /\b(ssn|social\s+security|tax\s+id)\b/i, rule: "secret_pii" },
  { pattern: /\b(credit\s+card|card\s+number|cvv|expir(?:y|ation)\s+date)\b/i, rule: "secret_financial_pii" },
  { pattern: /\b(bearer\s+[a-zA-Z0-9_\-.]+)\b/, rule: "secret_bearer_token" },
  { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/, rule: "secret_openai_key" },
];

// ── Threat / legal action patterns ────────────────────────────────────
const THREAT_PATTERNS = [
  { pattern: /\b(legal\s+action|take\s+(?:you|this)\s+to\s+court|sue\s+(?:you|them|your))\b/i, rule: "threat_legal_action" },
  { pattern: /\b(terminate\s+(?:the\s+|your\s+)?contract|cancel\s+(?:the\s+|your\s+)?agreement)\b/i, rule: "threat_contract_termination" },
  { pattern: /\b(report\s+(?:you|this)\s+to\s+(?:the\s+)?(?:authorities|police|fbi|sec))\b/i, rule: "threat_authority_report" },
  { pattern: /\b(you\s+will\s+(?:regret|suffer|pay\s+for)\s+this)\b/i, rule: "threat_personal" },
  { pattern: /\b(cease\s+and\s+desist)\b/i, rule: "threat_cease_desist" },
];

// ── Medical / health claims ───────────────────────────────────────────
const MEDICAL_PATTERNS = [
  { pattern: /\b(diagnos(?:e|is|ed)|prescrib(?:e|ed)|medical\s+advice)\b/i, rule: "medical_claim" },
];

const ALL_RULE_SETS = [
  { patterns: LEGAL_COMMITMENT_PATTERNS, severity: "block" as const },
  { patterns: FINANCIAL_PATTERNS, severity: "block" as const },
  { patterns: SECRET_PATTERNS, severity: "block" as const },
  { patterns: THREAT_PATTERNS, severity: "block" as const },
  { patterns: MEDICAL_PATTERNS, severity: "review" as const },
];

/**
 * Run all hard regex safety rules against the reply text.
 * Returns a list of all violations found (may be empty).
 */
export function checkHardSafetyRules(replyText: string): SafetyViolation[] {
  const violations: SafetyViolation[] = [];

  for (const ruleSet of ALL_RULE_SETS) {
    for (const { pattern, rule } of ruleSet.patterns) {
      const match = replyText.match(pattern);
      if (match) {
        violations.push({
          layer: "hard_block",
          rule,
          matched: match[0].slice(0, 100),
          severity: ruleSet.severity,
        });
      }
    }
  }

  return violations;
}

/**
 * Context gating: check if the reply should require manual review
 * based on recipient context and aggressiveness of the content.
 *
 * @param recipientEmail - The "To" address
 * @param senderEmail - The user's own email address
 * @param aggressionLevel - From voice cloner (0-1 scale)
 * @param threshold - Aggression threshold for external recipients (default 0.4)
 */
export function checkContextGate(
  recipientEmail: string,
  senderEmail: string,
  aggressionLevel: number,
  threshold = 0.4,
): SafetyViolation | null {
  if (!recipientEmail || !senderEmail) return null;

  const recipientDomain = recipientEmail.split("@")[1]?.toLowerCase() ?? "";
  const senderDomain = senderEmail.split("@")[1]?.toLowerCase() ?? "";

  // Same domain = internal, allow higher aggression
  if (recipientDomain && senderDomain && recipientDomain === senderDomain) {
    return null;
  }

  // External recipient + high aggression = require review
  if (aggressionLevel > threshold) {
    return {
      layer: "context_gate",
      rule: "external_high_aggression",
      matched: `aggression=${aggressionLevel.toFixed(2)} > threshold=${threshold.toFixed(2)} for external domain ${recipientDomain}`,
      severity: "review",
    };
  }

  return null;
}
