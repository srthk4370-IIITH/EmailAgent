import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getConfig, type AppConfig, updateConfig } from "../../../db/config";
import { releaseDryModeReadyToSendBacklog } from "../../../db/emails";
import { apiError } from "../../../lib/apiError";
import {
  getRuntimeConfigBooleanSync,
  getRuntimeConfigSync,
  setRuntimeConfigValues,
  type RuntimeConfigKey,
} from "../../../lib/runtimeConfig";
import { logSlowApi } from "../../../utils/api";
import { withApiRoute } from "../../../lib/routeErrorHandler";

const categoryRuleObjectSchema = z
  .object({
    mode: z.enum(["assist", "manual", "auto"]),
    confidence_threshold: z.number().min(0).max(1),
    description: z.string().optional(),
  })
  .strict();

const categoryRuleValueSchema = z.union([z.enum(["assist", "manual", "auto"]), categoryRuleObjectSchema]);
const categoryColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const DEFAULT_BUDGET_EXPAND_THRESHOLD_PERCENT = 90;
const DEFAULT_BUDGET_EXPAND_STEP = 250_000;
const DEFAULT_BUDGET_MAX_DAILY_LIMIT = 3_000_000;
const DEFAULT_SHIP_MODE = "production";
const DEFAULT_SHIP_LOG_LEVEL = "adaptive";
const DEFAULT_SHIP_RETRY_LIMIT = 3;

type BudgetRuntimeSettings = {
  token_budget_auto_expand_enabled: boolean;
  token_budget_max_daily_limit: number;
  token_budget_expand_step: number;
  token_budget_expand_threshold_percent: number;
};

type ShipRuntimeSettings = {
  mode: string;
  log_level: string;
  retry_limit: number;
  timeout_strict: boolean;
};

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

function readBudgetRuntimeSettings(): BudgetRuntimeSettings {
  return {
    token_budget_auto_expand_enabled: getRuntimeConfigBooleanSync("TOKEN_BUDGET_AUTO_EXPAND_ENABLED", true),
    token_budget_max_daily_limit: parsePositiveInt(
      getRuntimeConfigSync("TOKEN_BUDGET_MAX_DAILY_LIMIT"),
      DEFAULT_BUDGET_MAX_DAILY_LIMIT,
    ),
    token_budget_expand_step: parsePositiveInt(
      getRuntimeConfigSync("TOKEN_BUDGET_EXPAND_STEP"),
      DEFAULT_BUDGET_EXPAND_STEP,
    ),
    token_budget_expand_threshold_percent: parsePercent(
      getRuntimeConfigSync("TOKEN_BUDGET_EXPAND_THRESHOLD_PERCENT"),
      DEFAULT_BUDGET_EXPAND_THRESHOLD_PERCENT,
    ),
  };
}

function readShipRuntimeSettings(): ShipRuntimeSettings {
  return {
    mode: getRuntimeConfigSync("MODE") ?? DEFAULT_SHIP_MODE,
    log_level: getRuntimeConfigSync("LOG_LEVEL") ?? DEFAULT_SHIP_LOG_LEVEL,
    retry_limit: parsePositiveInt(getRuntimeConfigSync("RETRY_LIMIT"), DEFAULT_SHIP_RETRY_LIMIT),
    timeout_strict: getRuntimeConfigBooleanSync("TIMEOUT_STRICT", true),
  };
}

function withRuntimeSettings(config: AppConfig): AppConfig & BudgetRuntimeSettings & ShipRuntimeSettings {
  return {
    ...config,
    ...readBudgetRuntimeSettings(),
    ...readShipRuntimeSettings(),
  };
}

const updateSchema = z.object({
  expected_config_version: z.number().int().nonnegative().optional(),
  global_mode: z.enum(["assist", "manual", "auto"]).optional(),
  send_mode: z.enum(["dry", "live"]).optional(),
  threshold: z.number().min(0).max(1).optional(),
  daily_token_limit: z.number().int().positive().optional(),
  token_budget_auto_expand_enabled: z.boolean().optional(),
  token_budget_max_daily_limit: z.number().int().positive().optional(),
  token_budget_expand_step: z.number().int().positive().optional(),
  token_budget_expand_threshold_percent: z.number().int().min(1).max(100).optional(),
  mode: z.enum(["development", "production"]).optional(),
  log_level: z.enum(["adaptive", "debug", "info", "warn", "error"]).optional(),
  retry_limit: z.number().int().positive().max(10).optional(),
  timeout_strict: z.boolean().optional(),
  category_rules: z.record(z.string().min(1), categoryRuleValueSchema).optional(),
  category_colors: z.record(z.string().min(1), categoryColorSchema).optional(),
  tone: z.string().min(1).optional(),
});

async function GETHandler() {
  const start = Date.now();
  try {
    const config = await getConfig();
    const response = NextResponse.json(withRuntimeSettings(config));
    logSlowApi("/api/config", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "CONFIG_READ_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry loading settings. If it persists, verify database health.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/config", start);
    return response;
  }
}

async function POSTHandler(request: NextRequest) {
  const start = Date.now();
  try {
    const body = await request.json();
    const parsed = updateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const dbUpdatePayload: Partial<AppConfig> = {
      ...(parsed.data.global_mode ? { global_mode: parsed.data.global_mode } : {}),
      ...(parsed.data.send_mode ? { send_mode: parsed.data.send_mode } : {}),
      ...(typeof parsed.data.threshold === "number" ? { threshold: parsed.data.threshold } : {}),
      ...(typeof parsed.data.daily_token_limit === "number"
        ? { daily_token_limit: parsed.data.daily_token_limit }
        : {}),
      ...(parsed.data.category_rules ? { category_rules: parsed.data.category_rules } : {}),
      ...(parsed.data.category_colors ? { category_colors: parsed.data.category_colors } : {}),
      ...(parsed.data.tone ? { tone: parsed.data.tone } : {}),
    };

    const runtimeUpdates: Partial<Record<RuntimeConfigKey, string | null | undefined>> = {
      ...(typeof parsed.data.token_budget_auto_expand_enabled === "boolean"
        ? {
            TOKEN_BUDGET_AUTO_EXPAND_ENABLED: parsed.data.token_budget_auto_expand_enabled ? "true" : "false",
          }
        : {}),
      ...(typeof parsed.data.token_budget_max_daily_limit === "number"
        ? { TOKEN_BUDGET_MAX_DAILY_LIMIT: String(parsed.data.token_budget_max_daily_limit) }
        : {}),
      ...(typeof parsed.data.token_budget_expand_step === "number"
        ? { TOKEN_BUDGET_EXPAND_STEP: String(parsed.data.token_budget_expand_step) }
        : {}),
      ...(typeof parsed.data.token_budget_expand_threshold_percent === "number"
        ? {
            TOKEN_BUDGET_EXPAND_THRESHOLD_PERCENT: String(
              parsed.data.token_budget_expand_threshold_percent,
            ),
          }
        : {}),
      ...(parsed.data.mode ? { MODE: parsed.data.mode } : {}),
      ...(parsed.data.log_level ? { LOG_LEVEL: parsed.data.log_level } : {}),
      ...(typeof parsed.data.retry_limit === "number"
        ? { RETRY_LIMIT: String(parsed.data.retry_limit) }
        : {}),
      ...(typeof parsed.data.timeout_strict === "boolean"
        ? { TIMEOUT_STRICT: parsed.data.timeout_strict ? "true" : "false" }
        : {}),
    };

    const updatedBaseConfig =
      Object.keys(dbUpdatePayload).length > 0
        ? await updateConfig(dbUpdatePayload, parsed.data.expected_config_version)
        : await getConfig();

    if (Object.keys(runtimeUpdates).length > 0) {
      await setRuntimeConfigValues(runtimeUpdates);
    }

    if (parsed.data.send_mode === "live") {
      // When operators switch to live mode, immediately release dry-mode cooldowns.
      await releaseDryModeReadyToSendBacklog().catch(() => {});
    }

    const response = NextResponse.json(withRuntimeSettings(updatedBaseConfig));
    logSlowApi("/api/config", start);
    return response;
  } catch (err) {
    if (err instanceof Error && err.message === "CONFIG_VERSION_CONFLICT") {
      const response = NextResponse.json(
        apiError(
          "CONFIG_VERSION_CONFLICT",
          "stale_write",
          "Refresh settings and retry. Another update was applied first.",
        ),
        { status: 409 },
      );
      logSlowApi("/api/config", start);
      return response;
    }

    const response = NextResponse.json(
      apiError(
        "CONFIG_UPDATE_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry saving settings. If it persists, refresh and run diagnostics.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/config", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/config', operation: 'GET' });
export const POST = withApiRoute(POSTHandler, { route: '/config', operation: 'POST' });
