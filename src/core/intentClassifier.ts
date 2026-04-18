import { z } from "zod";
import { callLlm } from "../services/llm";

export interface IntentScores {
  aggression_score: number;
  sarcasm_score: number;
  coercion_score: number;
  legal_risk_score: number;
  financial_risk_score: number;
  notes?: string | undefined;
}

export interface IntentGateInput {
  message: string;
  recipientEmail?: string;
  senderEmail?: string;
  model?: string;
}

export interface IntentGateResult {
  scores: IntentScores;
  blockAutoSend: boolean;
  forceManual: boolean;
  reasons: string[];
}

const RESPONSE_SCHEMA = z.object({
  aggression_score: z.number().min(0).max(1),
  sarcasm_score: z.number().min(0).max(1),
  coercion_score: z.number().min(0).max(1),
  legal_risk_score: z.number().min(0).max(1),
  financial_risk_score: z.number().min(0).max(1),
  notes: z.string().optional(),
});

function isExternal(recipientEmail?: string, senderEmail?: string): boolean {
  if (!recipientEmail || !senderEmail) return false;
  const recipientDomain = recipientEmail.split("@")[1]?.toLowerCase() ?? "";
  const senderDomain = senderEmail.split("@")[1]?.toLowerCase() ?? "";
  return Boolean(recipientDomain && senderDomain && recipientDomain !== senderDomain);
}

function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function applyHeuristicSafetySignals(message: string, scores: IntentScores): IntentScores {
  const text = message.toLowerCase();
  const heuristic = {
    aggression: /(publicly shame|ignore(?:d|ing)? my last \d+ emails?|world[- ]class support|fantastic job ignoring|truly world[- ]class|you will regret|suffer for this)/i.test(text),
    sarcasm: /(great service|fantastic job|world[- ]class support|truly world[- ]class|i guess if your team ever has time|maybe someone could finally respond|so helpful)/i.test(text),
    coercion: /(it would be unfortunate|need this handled|before eod|today|leadership reviews|vendor reliability|if you do not|immediately|urgent legal escalation)/i.test(text),
    legal: /(legal action|take .* to court|sue|cease and desist|contract|agreement|liability|legally reviewed)/i.test(text),
    financial: /(refund|payment|invoice|transfer|wire|compensate|reimburse|credit)/i.test(text),
  };

  return {
    aggression_score: Math.max(scores.aggression_score, heuristic.aggression ? 0.85 : 0),
    sarcasm_score: Math.max(scores.sarcasm_score, heuristic.sarcasm ? 0.8 : 0),
    coercion_score: Math.max(scores.coercion_score, heuristic.coercion ? 0.8 : 0),
    legal_risk_score: Math.max(scores.legal_risk_score, heuristic.legal ? 0.9 : 0),
    financial_risk_score: Math.max(scores.financial_risk_score, heuristic.financial ? 0.65 : 0),
    ...(scores.notes ? { notes: scores.notes } : {}),
  };
}

export async function classifyIntentRisks(input: IntentGateInput): Promise<IntentGateResult> {
  const prompt = [
    "Score the following email reply for semantic safety risks.",
    "Return strict JSON only with keys:",
    '{"aggression_score":0-1,"sarcasm_score":0-1,"coercion_score":0-1,"legal_risk_score":0-1,"financial_risk_score":0-1,"notes":"optional"}',
    "Guidelines:",
    "- coercion means manipulation, pressure, implicit threats, forceful asks",
    "- legal risk means commitments, liabilities, contractual assertions",
    "- financial risk means payment promises, refunds, transfer commitments",
    "- sarcasm should be high when literal words are polite but intent is cutting/hostile",
    "Message:",
    input.message,
  ].join("\n");

  const llm = await callLlm(prompt, input.model ? { model: input.model, task: "intent" } : { task: "intent" });
  let scores: IntentScores = {
    aggression_score: 0,
    sarcasm_score: 0,
    coercion_score: 0,
    legal_risk_score: 0,
    financial_risk_score: 0,
  };

  if (!llm.error) {
    try {
      const raw = JSON.parse(extractJsonPayload(llm.text)) as unknown;
      const parsed = RESPONSE_SCHEMA.safeParse(raw);
      if (parsed.success) {
        scores = {
          aggression_score: parsed.data.aggression_score,
          sarcasm_score: parsed.data.sarcasm_score,
          coercion_score: parsed.data.coercion_score,
          legal_risk_score: parsed.data.legal_risk_score,
          financial_risk_score: parsed.data.financial_risk_score,
          ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
        };
      }
    } catch {
      // Keep zeroed scores if parse fails.
    }
  }

  scores = applyHeuristicSafetySignals(input.message, scores);

  const external = isExternal(input.recipientEmail, input.senderEmail);
  const reasons: string[] = [];
  const blockAutoSend =
    (external && scores.sarcasm_score >= 0.55) ||
    scores.coercion_score >= 0.5 ||
    scores.aggression_score >= 0.6;
  const forceManual =
    scores.legal_risk_score >= 0.5 ||
    scores.financial_risk_score >= 0.5 ||
    scores.coercion_score >= 0.65;

  if (external && scores.sarcasm_score >= 0.55) reasons.push("high_sarcasm_external");
  if (scores.coercion_score >= 0.5) reasons.push("high_coercion");
  if (scores.aggression_score >= 0.6) reasons.push("high_aggression");
  if (scores.legal_risk_score >= 0.5) reasons.push("legal_risk_manual");
  if (scores.financial_risk_score >= 0.5) reasons.push("financial_risk_manual");

  return {
    scores,
    blockAutoSend,
    forceManual,
    reasons,
  };
}
