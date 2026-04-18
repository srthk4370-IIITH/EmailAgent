export interface PriorityScoreInput {
  fromEmail?: string | null;
  subject: string;
  body: string;
  threadActivityCount: number;
}

export interface PriorityScoreResult {
  score: number;
  reasons: string[];
}

const URGENCY_PATTERNS = [
  /\b(urgent|asap|immediately|today|deadline|blocking|critical|high\s+priority)\b/i,
  /\b(by\s+eod|before\s+tomorrow|time\s+sensitive|need\s+this\s+now)\b/i,
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function senderImportance(email: string): number {
  const lower = email.toLowerCase();
  if (lower.includes("ceo") || lower.includes("founder") || lower.includes("leadership")) return 1;
  if (lower.includes("legal") || lower.includes("finance") || lower.includes("security")) return 0.8;
  if (lower.includes("support") || lower.includes("customer")) return 0.65;
  return 0.45;
}

function urgencyScore(subject: string, body: string): number {
  const text = `${subject} ${body}`;
  const hits = URGENCY_PATTERNS.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  if (hits === 0) return 0.2;
  if (hits === 1) return 0.65;
  return 0.9;
}

function threadActivityScore(count: number): number {
  if (count <= 1) return 0.2;
  if (count <= 3) return 0.45;
  if (count <= 6) return 0.7;
  return 0.9;
}

export function computePriorityScore(input: PriorityScoreInput): PriorityScoreResult {
  const reasons: string[] = [];
  const sender = senderImportance(input.fromEmail ?? "");
  const urgency = urgencyScore(input.subject, input.body);
  const activity = threadActivityScore(input.threadActivityCount);

  if (urgency >= 0.65) reasons.push("urgency_keywords");
  if (activity >= 0.7) reasons.push("active_thread");
  if (sender >= 0.8) reasons.push("high_importance_sender");

  const score = clamp01(sender * 0.35 + urgency * 0.4 + activity * 0.25);
  return { score, reasons };
}
