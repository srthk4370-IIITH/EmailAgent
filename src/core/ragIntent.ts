export type RetrievalIntent = "product_query" | "support_query" | "generic_query" | "unknown";

const PRODUCT_PATTERNS = /\b(product|feature|features|plan|pricing|price|tier|integration|api|roadmap|compare|trial)\b/i;
const SUPPORT_PATTERNS = /\b(error|bug|issue|not\s+working|failed|cannot|can't|login|reset|help|support|ticket|incident)\b/i;
const GENERIC_PATTERNS = /\b(update|status|question|details|information|explain|clarify|summary)\b/i;
const VAGUE_PATTERNS = /\b(this|that|it|thing|stuff|tell me about this|what about this|can you explain)\b/i;

export function detectRetrievalIntent(subject: string, body: string): RetrievalIntent {
  const text = `${subject} ${body}`.toLowerCase();
  if (PRODUCT_PATTERNS.test(text)) return "product_query";
  if (SUPPORT_PATTERNS.test(text)) return "support_query";
  if (VAGUE_PATTERNS.test(text) && text.trim().split(/\s+/).length <= 14) return "unknown";
  if (GENERIC_PATTERNS.test(text)) return "generic_query";
  return "unknown";
}

export function rewriteQueryForRetrieval(subject: string, body: string, intent: RetrievalIntent): string {
  const cleanSubject = (subject || "(no subject)").trim();
  const cleanBody = (body || "").trim();

  if (intent === "unknown") {
    return [
      "User intent is ambiguous.",
      "Likely asks for explanation of prior topic or product in current thread.",
      `Subject: ${cleanSubject}`,
      `Original: ${cleanBody}`,
      "Retrieve only broad, high-confidence context. Prefer concise explanatory references.",
    ].join("\n");
  }

  if (intent === "product_query") {
    return [
      "Intent: product information request.",
      "Focus on product name, features, pricing, and plan constraints.",
      `Subject: ${cleanSubject}`,
      `Question: ${cleanBody}`,
    ].join("\n");
  }

  if (intent === "support_query") {
    return [
      "Intent: support/troubleshooting request.",
      "Focus on past issue-resolution conversations and practical steps.",
      `Subject: ${cleanSubject}`,
      `Issue: ${cleanBody}`,
    ].join("\n");
  }

  return [
    "Intent: general email reply context retrieval.",
    `Subject: ${cleanSubject}`,
    `Message: ${cleanBody}`,
  ].join("\n");
}

export function keywordBoostTerms(intent: RetrievalIntent): string[] {
  if (intent === "product_query") {
    return ["product", "feature", "features", "pricing", "price", "plan", "api", "integration"];
  }
  if (intent === "support_query") {
    return ["issue", "error", "fix", "resolved", "workaround", "steps", "support"];
  }
  return [];
}
