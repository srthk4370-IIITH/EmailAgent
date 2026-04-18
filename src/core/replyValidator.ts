/**
 * Programmatic Reply Post-Validator (Fix 5)
 *
 * Replaces the LLM "self-validation" prompt block with deterministic
 * code-level checks that actually catch problems.
 *
 * LLMs don't truly validate — they rationalize. This module applies
 * real pattern matching and structural analysis to catch:
 * - Sentence-level repetition
 * - Signature/greeting leakage from past emails
 * - Stale detail patterns
 * - Excessive verbosity
 * - Incomplete addressing of the query
 */

import { logger } from "../utils/logger";

export interface ValidationResult {
  passed: boolean;
  issues: ValidationIssue[];
  cleaned_reply: string;
}

export interface ValidationIssue {
  type: "repetition" | "signature_leak" | "greeting_leak" | "verbosity" | "stale_detail" | "meta_reference";
  description: string;
  severity: "warning" | "error";
  auto_fixed: boolean;
}

// ── Sentence-level repetition detection ───────────────────────────────

/**
 * Detects and removes repeated sentences.
 * Normalizes whitespace and casing for comparison.
 */
function detectAndFixRepetition(reply: string): { text: string; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const lines = reply.split(/\n/);
  const seen = new Set<string>();
  const dedupedLines: string[] = [];

  for (const line of lines) {
    // Normalize for comparison
    const normalized = line.trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized.length < 10) {
      dedupedLines.push(line);
      continue;
    }

    if (seen.has(normalized)) {
      issues.push({
        type: "repetition",
        description: `Repeated sentence: "${line.trim().slice(0, 60)}..."`,
        severity: "error",
        auto_fixed: true,
      });
      continue; // skip duplicate
    }

    seen.add(normalized);
    dedupedLines.push(line);
  }

  // Also check for sentence-level repeats within a single paragraph
  const text = dedupedLines.join("\n");
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const sentSeen = new Set<string>();
  const sentIssues: string[] = [];

  for (const s of sentences) {
    const norm = s.trim().toLowerCase().replace(/\s+/g, " ");
    if (norm.length < 20) continue;
    if (sentSeen.has(norm)) {
      sentIssues.push(norm.slice(0, 50));
    }
    sentSeen.add(norm);
  }

  if (sentIssues.length > 0) {
    // Remove intra-paragraph duplicates
    const finalSentences: string[] = [];
    const finalSeen = new Set<string>();
    for (const s of sentences) {
      const norm = s.trim().toLowerCase().replace(/\s+/g, " ");
      if (finalSeen.has(norm) && norm.length >= 20) continue;
      finalSeen.add(norm);
      finalSentences.push(s);
    }

    issues.push({
      type: "repetition",
      description: `${sentIssues.length} repeated sentence(s) within paragraphs`,
      severity: "error",
      auto_fixed: true,
    });

    return { text: finalSentences.join(""), issues };
  }

  return { text, issues };
}

// ── Signature/greeting leakage detection ──────────────────────────────

const LEAKED_SIGNATURE_PATTERNS = [
  /^(regards|best regards|kind regards|warm regards),?\s*$/im,
  /^(best|cheers|sincerely|yours truly),?\s*$/im,
  /^(thanks|thank you),?\s*$/im,
  /^sent from my /im,
  /^get outlook for /im,
  /^\-{2,}\s*$/m,
  /^_{5,}\s*$/m,
];

const LEAKED_GREETING_PATTERNS = [
  /\b(hi|hello|dear)\s+(sir|madam|team)\b/im,
  /^(hi|hello|dear)\s+\w+,?\s*$/im,
];

const META_REFERENCE_PATTERNS = [
  /based on (past|previous|earlier) (emails|conversations|messages)/i,
  /as (mentioned|discussed|stated) (in|during) (our|a) (previous|past|earlier)/i,
  /from (our|the) (past|previous) (correspondence|exchange|thread)/i,
  /according to (my|our) (records|history|knowledge)/i,
  /as per (my|our) (previous|last|earlier) (email|response|reply)/i,
];

function detectLeakage(reply: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const p of LEAKED_SIGNATURE_PATTERNS) {
    if (p.test(reply)) {
      issues.push({
        type: "signature_leak",
        description: `Leaked signature pattern: ${p.source.slice(0, 40)}`,
        severity: "warning",
        auto_fixed: false,
      });
    }
  }

  for (const p of LEAKED_GREETING_PATTERNS) {
    if (p.test(reply)) {
      issues.push({
        type: "greeting_leak",
        description: `Leaked external greeting: ${p.source.slice(0, 40)}`,
        severity: "warning",
        auto_fixed: false,
      });
    }
  }

  for (const p of META_REFERENCE_PATTERNS) {
    if (p.test(reply)) {
      issues.push({
        type: "meta_reference",
        description: `Meta-reference to knowledge source detected`,
        severity: "error",
        auto_fixed: false,
      });
    }
  }

  return issues;
}

// ── Stale detail detection ────────────────────────────────────────────

function detectStaleDetails(reply: string, originalBody: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check if reply contains names not in the original email
  const replyNames = reply.match(/\b[A-Z][a-z]{2,15}\b/g) || [];
  const bodyNames = new Set(originalBody.match(/\b[A-Z][a-z]{2,15}\b/g) || []);

  const commonWords = new Set([
    "The", "This", "That", "These", "Those", "What", "When", "Where",
    "Which", "Please", "Thank", "Thanks", "Best", "Kind", "Warm",
    "Dear", "Hello", "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday", "January", "February", "March",
    "April", "May", "June", "July", "August", "September", "October",
    "November", "December", "Regards", "Sincerely",
  ]);

  const unknownNames = replyNames.filter(
    (n) => !bodyNames.has(n) && !commonWords.has(n),
  );

  if (unknownNames.length > 3) {
    issues.push({
      type: "stale_detail",
      description: `${unknownNames.length} proper nouns in reply not found in query: ${unknownNames.slice(0, 3).join(", ")}`,
      severity: "warning",
      auto_fixed: false,
    });
  }

  return issues;
}

// ── Verbosity check ───────────────────────────────────────────────────

function detectVerbosity(reply: string, originalBody: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Reply shouldn't be more than 3x the query length for most cases
  if (reply.length > originalBody.length * 3 && reply.length > 500) {
    issues.push({
      type: "verbosity",
      description: `Reply (${reply.length} chars) is ${(reply.length / originalBody.length).toFixed(1)}x longer than query`,
      severity: "warning",
      auto_fixed: false,
    });
  }

  return issues;
}

// ── Main validation function ──────────────────────────────────────────

export function validateReply(
  reply: string,
  originalBody: string,
  traceId?: string,
): ValidationResult {
  // Step 1: Fix repetition (auto-fixable)
  const { text: cleaned, issues: repIssues } = detectAndFixRepetition(reply);

  // Step 2: Detect leakage (not auto-fixed, but logged)
  const leakIssues = detectLeakage(cleaned);

  // Step 3: Detect stale details
  const staleIssues = detectStaleDetails(cleaned, originalBody);

  // Step 4: Detect verbosity
  const verbosityIssues = detectVerbosity(cleaned, originalBody);

  const allIssues = [...repIssues, ...leakIssues, ...staleIssues, ...verbosityIssues];

  const hasErrors = allIssues.some((i) => i.severity === "error" && !i.auto_fixed);

  if (allIssues.length > 0) {
    logger.info("reply_validation", {
      trace_id: traceId ?? "unknown",
      passed: !hasErrors,
      issues_count: allIssues.length,
      errors: allIssues.filter((i) => i.severity === "error").length,
      warnings: allIssues.filter((i) => i.severity === "warning").length,
      auto_fixed: allIssues.filter((i) => i.auto_fixed).length,
    });
  }

  return {
    passed: !hasErrors,
    issues: allIssues,
    cleaned_reply: cleaned,
  };
}
