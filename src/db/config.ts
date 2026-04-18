import { z } from "zod";

import { db } from "./client";

export const decisionModeSchema = z.enum(["assist", "manual", "auto"]);
export const globalModeSchema = z.enum(["assist", "manual", "auto"]);
export const sendModeSchema = z.enum(["dry", "live"]);

const categoryRuleObjectSchema = z
  .object({
    mode: decisionModeSchema,
    confidence_threshold: z.number().min(0).max(1),
    description: z.string().optional(),
  })
  .strict();

const categoryRuleValueSchema = z.union([decisionModeSchema, categoryRuleObjectSchema]);
const categoryColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const configSchema = z.object({
  global_mode: globalModeSchema,
  threshold: z.number().min(0).max(1),
  daily_token_limit: z.number().int().positive().default(500000),
  // Backward compatible: values can be either a mode string (legacy) or an object with mode + threshold.
  category_rules: z.record(z.string().min(1), categoryRuleValueSchema),
  category_colors: z.record(z.string().min(1), categoryColorSchema).default({}),
  tone: z.string().min(1),
  send_mode: sendModeSchema.default("dry"),
  last_gmail_history_id: z.string().nullable().optional(),
  config_version: z.number().int().nonnegative().default(1),
});

export type AppConfig = z.infer<typeof configSchema>;

export async function getConfig(): Promise<AppConfig> {
  const result = await db.query<{
    global_mode: string;
    threshold: number;
    daily_token_limit: number;
    category_rules: unknown;
    category_colors: unknown;
    tone: string;
    send_mode: string;
    last_gmail_history_id: string | null;
    config_version: number;
  }>(
    "SELECT global_mode, threshold, COALESCE(daily_token_limit, 500000) AS daily_token_limit, category_rules, COALESCE(category_colors, '{}'::jsonb) AS category_colors, tone, COALESCE(send_mode, 'dry') AS send_mode, last_gmail_history_id, COALESCE(config_version, 1) AS config_version FROM config WHERE id = 1 LIMIT 1",
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Missing config row");
  }

  return configSchema.parse({
    ...row,
    last_gmail_history_id: row.last_gmail_history_id ?? null,
  });
}

export async function updateConfig(input: Partial<AppConfig>, expectedVersion?: number): Promise<AppConfig> {
  const current = await getConfig();
  const merged = configSchema.parse({
    ...current,
    ...input,
    config_version: current.config_version,
  });

  const params = [
    merged.global_mode,
    merged.threshold,
    merged.daily_token_limit,
    JSON.stringify(merged.category_rules),
    JSON.stringify(merged.category_colors ?? {}),
    merged.tone,
    merged.send_mode,
    merged.last_gmail_history_id ?? null,
  ];

  const result = expectedVersion == null
    ? await db.query(
        `
          UPDATE config
          SET global_mode = $1, threshold = $2, daily_token_limit = $3, category_rules = $4::jsonb, category_colors = $5::jsonb, tone = $6, send_mode = $7,
              last_gmail_history_id = $8, config_version = config_version + 1, updated_at = NOW()
          WHERE id = 1
        `,
        params,
      )
    : await db.query(
        `
          UPDATE config
          SET global_mode = $1, threshold = $2, daily_token_limit = $3, category_rules = $4::jsonb, category_colors = $5::jsonb, tone = $6, send_mode = $7,
              last_gmail_history_id = $8, config_version = config_version + 1, updated_at = NOW()
          WHERE id = 1 AND config_version = $9
        `,
        [...params, expectedVersion],
      );

  if (expectedVersion != null && result.rowCount === 0) {
    throw new Error("CONFIG_VERSION_CONFLICT");
  }

  return getConfig();
}
