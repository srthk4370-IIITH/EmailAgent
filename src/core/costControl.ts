/**
 * Cost Control System
 *
 * Tracks daily token usage across all OpenAI calls (classification + generation + embeddings).
 * Enforces a configurable daily budget. When the budget is exceeded:
 * - Generation pauses
 * - Emails are marked "paused_due_to_budget"
 * - UI alert is triggered via system_health
 *
 * Token tracking is atomic (single UPDATE with += for race safety).
 */

import { db } from "../db/client";
import { getRuntimeConfigBooleanSync, getRuntimeConfigSync } from "../lib/runtimeConfig";
import { logger } from "../utils/logger";

export interface CostStatus {
  tokens_used_today: number;
  daily_token_limit: number;
  budget_remaining: number;
  budget_exceeded: boolean;
  percentage_used: number;
}

const DEFAULT_DAILY_TOKEN_LIMIT = 500_000;
const DEFAULT_BUDGET_EXPAND_STEP = 250_000;
const DEFAULT_BUDGET_EXPAND_THRESHOLD_PERCENT = 90;
const DEFAULT_BUDGET_MAX_DAILY_LIMIT = 3_000_000;

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parsePercent(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}

function resolveEffectiveDailyLimit(used: number, baseLimit: number): {
  effectiveLimit: number;
  expanded: boolean;
  thresholdPercent: number;
  step: number;
  maxLimit: number;
} {
  const autoExpandEnabled = getRuntimeConfigBooleanSync("TOKEN_BUDGET_AUTO_EXPAND_ENABLED", true);
  const thresholdPercent = parsePercent(
    getRuntimeConfigSync("TOKEN_BUDGET_EXPAND_THRESHOLD_PERCENT"),
    DEFAULT_BUDGET_EXPAND_THRESHOLD_PERCENT,
  );
  const step = parsePositiveInt(
    getRuntimeConfigSync("TOKEN_BUDGET_EXPAND_STEP"),
    Math.max(DEFAULT_BUDGET_EXPAND_STEP, Math.floor(baseLimit * 0.25)),
  );
  const maxLimit = parsePositiveInt(
    getRuntimeConfigSync("TOKEN_BUDGET_MAX_DAILY_LIMIT"),
    Math.max(baseLimit, DEFAULT_BUDGET_MAX_DAILY_LIMIT),
  );

  if (!autoExpandEnabled || maxLimit <= baseLimit) {
    return {
      effectiveLimit: baseLimit,
      expanded: false,
      thresholdPercent,
      step,
      maxLimit,
    };
  }

  let effectiveLimit = baseLimit;
  let expanded = false;

  while (effectiveLimit < maxLimit) {
    const expandAt = Math.floor((effectiveLimit * thresholdPercent) / 100);
    if (used < expandAt) break;

    const next = Math.min(maxLimit, effectiveLimit + step);
    if (next <= effectiveLimit) break;

    effectiveLimit = next;
    expanded = true;
  }

  return {
    effectiveLimit,
    expanded,
    thresholdPercent,
    step,
    maxLimit,
  };
}

/**
 * Reset the daily counter if the date has changed.
 * Called at the start of each worker tick.
 */
export async function resetDailyTokensIfNeeded(): Promise<void> {
  await db.query(`
    UPDATE config
    SET tokens_used_today = 0,
        token_reset_date = CURRENT_DATE,
        updated_at = NOW()
    WHERE id = 1
      AND token_reset_date < CURRENT_DATE
  `);
}

/**
 * Atomically add tokens to the daily counter.
 * Uses += to be safe under concurrent calls.
 */
export async function trackTokenUsage(tokensIn: number, tokensOut: number): Promise<void> {
  const total = Math.max(0, Math.floor(tokensIn + tokensOut));
  if (total === 0) return;

  await db.query(
    `UPDATE config
     SET tokens_used_today = tokens_used_today + $1,
         updated_at = NOW()
     WHERE id = 1`,
    [total],
  );
}

/**
 * Check whether the daily budget allows more LLM calls.
 * Returns the full cost status for logging/UI.
 */
export async function checkBudget(): Promise<CostStatus> {
  // Also reset if date changed
  await resetDailyTokensIfNeeded();

  const result = await db.query<{
    tokens_used_today: number;
    daily_token_limit: number;
  }>(
    `SELECT tokens_used_today, daily_token_limit
     FROM config
     WHERE id = 1
     LIMIT 1`,
  );

  const row = result.rows[0];
  if (!row) {
    const fallback = resolveEffectiveDailyLimit(0, DEFAULT_DAILY_TOKEN_LIMIT);
    // Config row missing — allow (can't block without config).
    return {
      tokens_used_today: 0,
      daily_token_limit: fallback.effectiveLimit,
      budget_remaining: fallback.effectiveLimit,
      budget_exceeded: false,
      percentage_used: 0,
    };
  }

  const used = row.tokens_used_today ?? 0;
  const baseLimit = Math.max(1, row.daily_token_limit ?? DEFAULT_DAILY_TOKEN_LIMIT);
  const expanded = resolveEffectiveDailyLimit(used, baseLimit);
  const limit = expanded.effectiveLimit;

  if (expanded.expanded && limit > baseLimit) {
    logger.info("cost_control_budget_auto_expanded", {
      used,
      baseLimit,
      effectiveLimit: limit,
      maxLimit: expanded.maxLimit,
      step: expanded.step,
      thresholdPercent: expanded.thresholdPercent,
    });
  }

  const remaining = Math.max(0, limit - used);
  const exceeded = used >= limit;
  const percentage = limit > 0 ? Math.round((used / limit) * 100) : 0;

  return {
    tokens_used_today: used,
    daily_token_limit: limit,
    budget_remaining: remaining,
    budget_exceeded: exceeded,
    percentage_used: percentage,
  };
}

/**
 * Check budget and update system_health if exceeded.
 * Returns true if generation is allowed, false if paused.
 */
export async function isBudgetAvailable(): Promise<boolean> {
  const status = await checkBudget();

  if (status.budget_exceeded) {
    logger.warn("cost_control_budget_exceeded", {
      used: status.tokens_used_today,
      limit: status.daily_token_limit,
    });

    // Update system_health to surface in UI
    await db.query(
      `UPDATE system_health
       SET status = 'degraded',
           error_message = $1,
           meta = $2::jsonb,
           last_checked_at = NOW(),
           updated_at = NOW()
       WHERE service = 'openai'`,
      [
        `Daily token budget exceeded (${status.tokens_used_today.toLocaleString()}/${status.daily_token_limit.toLocaleString()})`,
        JSON.stringify({
          reason: "budget_exceeded",
          tokens_used: status.tokens_used_today,
          limit: status.daily_token_limit,
          percentage: status.percentage_used,
        }),
      ],
    );

    return false;
  }

  // Warn at 80%
  if (status.percentage_used >= 80) {
    logger.info("cost_control_budget_warning", {
      used: status.tokens_used_today,
      limit: status.daily_token_limit,
      percentage: status.percentage_used,
    });
  }

  return true;
}
