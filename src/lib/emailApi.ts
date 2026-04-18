import type { EmailRecord } from "../db/emails";

type RiskLevel = "low" | "medium" | "high";

function deriveRiskLevel(email: EmailRecord): RiskLevel {
  if (typeof email.risk_score === "number") {
    if (email.risk_score >= 0.72) return "high";
    if (email.risk_score >= 0.45) return "medium";
    return "low";
  }
  if ((email.state || "").startsWith("ERROR")) return "high";
  if ((email.confidence ?? 0) < 0.55) return "high";
  if ((email.confidence ?? 0) < 0.72) return "medium";
  return "low";
}

function deriveRagStrength(email: EmailRecord): "strong" | "weak" | "none" {
  const ctx = Array.isArray(email.rag_context) ? email.rag_context : [];
  if (ctx.length === 0) return "none";
  const top = Number((ctx[0] as { distance?: number } | undefined)?.distance ?? 1);
  if (ctx.length >= 2 && top < 0.6) return "strong";
  return "weak";
}

export type DraftApi = {
  status: string;
  generated_body: string;
  edited_body: string | null;
  is_fallback?: boolean;
  id?: number;
  email_id?: number;
};

export function shapeEmailListItem(
  email: EmailRecord,
  draft: {
    id: number;
    email_id: number;
    reply: string;
    edited_body: string | null;
    status: string;
    is_fallback?: boolean;
  } | null,
  embeddingChunkCount = 0,
) {
  const parsed =
    email.parsed_content && typeof email.parsed_content === "object" && !Array.isArray(email.parsed_content)
      ? (email.parsed_content as Record<string, unknown>)
      : null;
  const parsedFrom = typeof parsed?.from === "string" ? parsed.from.trim() : "";
  const fromEmail = (email.from_email ?? "").trim() || parsedFrom || "Unknown sender";

  const confidence = email.confidence ?? null;
  const rag_strength = deriveRagStrength(email);
  const risk_level = deriveRiskLevel(email);
  const rag_confidence = typeof email.rag_confidence === "number" ? email.rag_confidence : null;
  const tone_consistency =
    typeof (email as unknown as { tone_consistency?: number }).tone_consistency === "number"
      ? (email as unknown as { tone_consistency?: number }).tone_consistency
      : 0.7;

  return {
    id: email.id,
    subject: email.subject,
    snippet: email.snippet,
    state: email.state,
    category: email.category,
    confidence,
    rag_strength,
    risk_level,
    tone_consistency,
    decision: email.decision,
    decision_reason: email.decision_reason ?? null,
    selected_model: email.selected_model ?? null,
    style_confidence: typeof email.style_confidence === "number" ? email.style_confidence : null,
    clarification_mode: Boolean(email.clarification_mode),
    rag_context: email.rag_context,
    rag_confidence,
    risk_score: typeof email.risk_score === "number" ? email.risk_score : null,
    priority_score: typeof email.priority_score === "number" ? email.priority_score : null,
    cost_score: typeof email.cost_score === "number" ? email.cost_score : null,
    edited_count: email.edited_count ?? 0,
    rejected_count: email.rejected_count ?? 0,
    regenerated_count: email.regenerated_count ?? 0,
    accepted_count: email.accepted_count ?? 0,
    draft: draft
      ? {
          status: draft.status,
          generated_body: draft.reply,
          edited_body: draft.edited_body,
          is_fallback: Boolean(draft.is_fallback),
          id: draft.id,
          email_id: draft.email_id,
        }
      : null,
    trace_id: email.trace_id,
    last_error: email.last_error,
    last_step: email.last_step,
    gmail_id: email.gmail_id,
    thread_id: email.thread_id,
    review_outcome: email.review_outcome ?? null,
    from_email: fromEmail,
    internal_date: email.internal_date,
    source: email.source,
    is_seen: Boolean(email.is_seen),
    embedding_status: email.embedding_status ?? "pending",
    embedding_error: email.embedding_error ?? null,
    embedding_chunk_count: embeddingChunkCount,
  };
}
