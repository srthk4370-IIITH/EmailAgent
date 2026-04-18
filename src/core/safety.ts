/**
 * Multi-Layer Safety System
 *
 * Layer 1: Hard regex blocks (safetyRules.ts) — deterministic, instant
 * Layer 2: OpenAI Moderation API (moderation.ts) — ML-based content safety
 * Layer 3: Context gating (safetyRules.ts) — recipient-aware blocking
 *
 * Voice cloning is PRESERVED. These layers block dangerous *intent*,
 * not tone. An aggressive reply to an internal colleague is fine.
 * An aggressive reply with legal threats to an external client is not.
 */

import { db } from "../db/client";
import { logger } from "../utils/logger";
import {
  checkHardSafetyRules,
  checkContextGate,
  type SafetyViolation,
} from "./safetyRules";
import {
  checkModeration,
  moderationToViolations,
} from "../services/moderation";

export interface SafetyResult {
  ok: boolean;
  autoSendAllowed: boolean;
  reasons: string[];
  violations: SafetyViolation[];
}

/**
 * Quick synchronous checks (length, basic sanity).
 * Preserved from the original implementation for backward compatibility.
 */
export function runSafetyChecks(reply: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const normalized = reply.trim();

  if (normalized.length === 0) reasons.push("empty_response");
  if (normalized.length < 15 || normalized.length > 2000) reasons.push("length_sanity_failed");

  // These are now covered by safetyRules.ts with much better patterns,
  // but keep for backward compat since processor.ts calls this directly.
  const hardViolations = checkHardSafetyRules(normalized);
  for (const v of hardViolations) {
    reasons.push(`${v.layer}:${v.rule}`);
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Full multi-layer safety check (async — calls OpenAI moderation API).
 *
 * Use this before any auto-send or ready-to-send transition.
 * Returns whether auto-send is allowed and all violations found.
 */
export async function runFullSafetyCheck(input: {
  replyText: string;
  recipientEmail?: string;
  senderEmail?: string;
  aggressionLevel?: number;
  emailId?: number;
}): Promise<SafetyResult> {
  const allViolations: SafetyViolation[] = [];
  const reasons: string[] = [];

  // ── Layer 1: Hard regex blocks ──────────────────────────────────────
  const hardViolations = checkHardSafetyRules(input.replyText);
  allViolations.push(...hardViolations);

  // ── Layer 2: OpenAI Moderation ──────────────────────────────────────
  try {
    const modResult = await checkModeration(input.replyText);
    if (modResult) {
      const modViolations = moderationToViolations(modResult);
      allViolations.push(...modViolations);
    }
  } catch {
    // Moderation API failure must NOT block the pipeline.
    // Hard rules already provide baseline protection.
    logger.warn("safety_moderation_unavailable");
  }

  // ── Layer 3: Context gating ─────────────────────────────────────────
  if (input.recipientEmail && input.senderEmail && input.aggressionLevel != null) {
    const contextViolation = checkContextGate(
      input.recipientEmail,
      input.senderEmail,
      input.aggressionLevel,
    );
    if (contextViolation) {
      allViolations.push(contextViolation);
    }
  }

  // ── Length sanity ───────────────────────────────────────────────────
  const trimmed = input.replyText.trim();
  if (trimmed.length === 0) reasons.push("empty_response");
  if (trimmed.length < 15 || trimmed.length > 2000) reasons.push("length_sanity_failed");

  // ── Aggregate ───────────────────────────────────────────────────────
  for (const v of allViolations) {
    reasons.push(`${v.layer}:${v.rule}`);
  }

  const hasBlocks = allViolations.some((v) => v.severity === "block");
  const hasReviews = allViolations.some((v) => v.severity === "review");
  const autoSendAllowed = !hasBlocks && !hasReviews && reasons.length === 0;
  const ok = !hasBlocks && reasons.length === 0;

  // ── Persist safety blocks for audit trail ───────────────────────────
  if (allViolations.length > 0 && input.emailId) {
    try {
      for (const v of allViolations) {
        await db.query(
          `INSERT INTO safety_blocks (email_id, layer, reason, details)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [input.emailId, v.layer, v.rule, JSON.stringify({ matched: v.matched, severity: v.severity })],
        );
      }
      await db.query(
        `UPDATE emails SET safety_review_required = true, safety_block_reason = $2, updated_at = NOW() WHERE id = $1`,
        [input.emailId, allViolations.map((v) => v.rule).join(", ")],
      );
    } catch (err) {
      // Audit trail write failure must not break the pipeline.
      logger.error("safety_audit_write_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (allViolations.length > 0) {
    logger.info("safety_check_result", {
      emailId: input.emailId,
      ok,
      autoSendAllowed,
      violations: allViolations.length,
      blocks: allViolations.filter((v) => v.severity === "block").length,
      reviews: allViolations.filter((v) => v.severity === "review").length,
    });
  }

  return { ok, autoSendAllowed, reasons, violations: allViolations };
}
