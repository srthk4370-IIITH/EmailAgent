/**
 * OpenAI Moderation API integration.
 *
 * Calls the free moderation endpoint to detect harmful content
 * BEFORE any email is auto-sent. This is Layer 2 of the safety system.
 */

import OpenAI from "openai";
import type { SafetyViolation } from "../core/safetyRules";
import { getRuntimeConfigSync } from "../lib/runtimeConfig";
import { logger } from "../utils/logger";

let moderationClient: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (moderationClient) return moderationClient;
  const apiKey = getRuntimeConfigSync("OPENAI_API_KEY");
  if (!apiKey) return null;
  moderationClient = new OpenAI({ apiKey });
  return moderationClient;
}

export interface ModerationResult {
  flagged: boolean;
  categories: string[];
  scores: Record<string, number>;
}

/**
 * Run OpenAI moderation on the given text.
 * Returns null if the API is unavailable (graceful degradation).
 * Never throws — moderation failure should not block the pipeline.
 */
export async function checkModeration(text: string): Promise<ModerationResult | null> {
  const client = getClient();
  if (!client) {
    logger.warn("moderation_skip: no API key");
    return null;
  }

  try {
    const response = await client.moderations.create({
      input: text,
    });

    const result = response.results[0];
    if (!result) return null;

    const flaggedCategories: string[] = [];
    const scores: Record<string, number> = {};

    for (const [category, flagged] of Object.entries(result.categories)) {
      if (flagged) {
        flaggedCategories.push(category);
      }
    }

    for (const [category, score] of Object.entries(result.category_scores)) {
      scores[category] = typeof score === "number" ? score : 0;
    }

    return {
      flagged: result.flagged,
      categories: flaggedCategories,
      scores,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "moderation_api_error";
    logger.error("moderation_api_failed", { error: message });
    // Moderation failure should NOT block the pipeline.
    // Return null to indicate unavailability; the hard rules still protect.
    return null;
  }
}

/**
 * Convert moderation result into SafetyViolation(s) for unified handling.
 */
export function moderationToViolations(result: ModerationResult): SafetyViolation[] {
  if (!result.flagged) return [];

  return result.categories.map((category) => ({
    layer: "moderation" as const,
    rule: `openai_moderation_${category}`,
    matched: `OpenAI flagged: ${category} (score: ${(result.scores[category] ?? 0).toFixed(3)})`,
    severity: "block" as const,
  }));
}
