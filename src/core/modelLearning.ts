import { db } from "../db/client";
import type { ModelTask, ModelTier } from "./modelRouter";

export interface ModelPerfRow {
  model: string;
  task: string;
  attempts: number;
  successes: number;
  total_tokens: number;
  total_cost_units: number;
}

let modelTableReady: boolean | null = null;

async function ensureModelPerformanceTable(): Promise<boolean> {
  if (modelTableReady === true) return true;
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS model_performance (
         id SERIAL PRIMARY KEY,
         model TEXT NOT NULL,
         task TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         successes INTEGER NOT NULL DEFAULT 0,
         total_tokens BIGINT NOT NULL DEFAULT 0,
         total_cost_units DOUBLE PRECISION NOT NULL DEFAULT 0,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE(model, task)
       )`,
    );
    modelTableReady = true;
    return true;
  } catch {
    modelTableReady = false;
    return false;
  }
}

export async function recordModelOutcome(input: {
  model: string;
  task: string;
  success: boolean;
  tokensIn: number;
  tokensOut: number;
}): Promise<void> {
  if (!(await ensureModelPerformanceTable())) return;
  const totalTokens = Math.max(0, Math.floor((input.tokensIn ?? 0) + (input.tokensOut ?? 0)));
  // Cost units are abstracted to avoid hard-coding provider pricing constants.
  const costUnits = totalTokens / 1000;

  try {
    await db.query(
      `INSERT INTO model_performance (model, task, attempts, successes, total_tokens, total_cost_units, updated_at)
       VALUES ($1, $2, 1, $3, $4, $5, NOW())
       ON CONFLICT (model, task)
       DO UPDATE SET
         attempts = model_performance.attempts + 1,
         successes = model_performance.successes + EXCLUDED.successes,
         total_tokens = model_performance.total_tokens + EXCLUDED.total_tokens,
         total_cost_units = model_performance.total_cost_units + EXCLUDED.total_cost_units,
         updated_at = NOW()`,
      [input.model, input.task, input.success ? 1 : 0, totalTokens, costUnits],
    );
  } catch {
    // Model learning should never break generation path.
  }
}

function modelsForTier(task: ModelTask, tier: ModelTier): string[] {
  if (task === "generation") {
    if (tier === "high") return ["gpt-4.1", "gpt-4.1-mini"];
    if (tier === "mid") return ["gpt-4.1-mini", "gpt-4o-mini"];
    return ["gpt-4o-mini", "gpt-4.1-mini"];
  }

  if (tier === "high") return ["gpt-4.1-mini", "gpt-4o-mini"];
  return ["gpt-4o-mini", "gpt-4.1-mini"];
}

export async function chooseAdaptiveModel(task: ModelTask, tier: ModelTier, fallback: string): Promise<string> {
  if (!(await ensureModelPerformanceTable())) return fallback;
  const candidates = modelsForTier(task, tier);
  let stats;
  try {
    stats = await db.query<ModelPerfRow>(
      `SELECT model, task, attempts, successes, total_tokens, total_cost_units
       FROM model_performance
       WHERE task = $1
         AND model = ANY($2::text[])`,
      [task, candidates],
    );
  } catch {
    return fallback;
  }

  if (stats.rows.length === 0) return fallback;

  let bestModel = fallback;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const row of stats.rows) {
    const attempts = Math.max(1, row.attempts);
    const successRate = row.successes / attempts;
    const costPerSuccess = row.successes > 0 ? row.total_cost_units / row.successes : row.total_cost_units;
    const score = successRate - Math.min(1.5, costPerSuccess * 0.15);
    if (score > bestScore) {
      bestScore = score;
      bestModel = row.model;
    }
  }

  return bestModel;
}
