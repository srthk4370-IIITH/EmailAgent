import { db } from "../db/client";

interface LogStepInput {
  trace_id: string;
  gmail_id: string | null;
  step: string;
  state: string;
  latency_ms: number;
  error?: string;
  meta?: Record<string, unknown>;
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(JSON.stringify({ level: "info", message, ...meta, ts: new Date().toISOString() }));
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(JSON.stringify({ level: "warn", message, ...meta, ts: new Date().toISOString() }));
  },
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(JSON.stringify({ level: "error", message, ...meta, ts: new Date().toISOString() }));
  },
};

export async function logStep(input: LogStepInput): Promise<void> {
  const payload = {
    trace_id: input.trace_id,
    gmail_id: input.gmail_id,
    step: input.step,
    state: input.state,
    latency_ms: input.latency_ms,
    error: input.error ?? null,
  };
  logger.info("pipeline_step", payload);

  await db.query(
    `
      INSERT INTO logs (trace_id, gmail_id, step, state, latency_ms, error, meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      input.trace_id,
      input.gmail_id,
      input.step,
      input.state,
      input.latency_ms,
      input.error ?? null,
      JSON.stringify(input.meta ?? {}),
    ],
  );
}
