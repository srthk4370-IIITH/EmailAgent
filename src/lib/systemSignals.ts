import { saveLog } from "../db/logs";
import { logger } from "../utils/logger";

export type SystemSignal =
  | "EMAIL_LIST_REQUEST"
  | "EMAIL_LIST_DEGRADED"
  | "EMAIL_LIST_TIMEOUT"
  | "PROCESS_FORCE_USED"
  | "SEND_BLOCKED_SAFETY"
  | "GMAIL_DISCONNECTED"
  | "AUTH_FAILURE"
  | "WORKER_LOOP_RETRY";

type EmitSystemSignalInput = {
  state?: string;
  traceId?: string;
  gmailId?: string | null;
  latencyMs?: number;
  error?: string | null;
  meta?: Record<string, unknown>;
};

function normalizeTraceId(signal: SystemSignal, traceId?: string): string {
  const normalized = (traceId ?? "").trim();
  if (normalized.length > 0) return normalized;
  return `signal:${signal.toLowerCase()}`;
}

export async function emitSystemSignal(
  signal: SystemSignal,
  input: EmitSystemSignalInput = {},
): Promise<void> {
  const state = (input.state ?? signal).trim() || signal;
  const error = input.error ?? null;
  const traceId = normalizeTraceId(signal, input.traceId);
  const meta = input.meta ?? {};

  logger.warn("system_signal", {
    signal,
    state,
    error,
    ...meta,
  });

  try {
    await saveLog({
      traceId,
      gmailId: input.gmailId ?? null,
      step: signal,
      state,
      latency_ms: Math.max(0, Math.round(input.latencyMs ?? 0)),
      error,
      meta: {
        signal,
        ...meta,
      },
    });
  } catch (persistError) {
    logger.warn("system_signal_persist_failed", {
      signal,
      reason: persistError instanceof Error ? persistError.message : String(persistError),
    });
  }
}
