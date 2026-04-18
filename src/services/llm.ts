import OpenAI, { APIConnectionError, APIConnectionTimeoutError, RateLimitError } from "openai";

import { db } from "../db/client";
import { trackTokenUsage } from "../core/costControl";
import { recordModelOutcome } from "../core/modelLearning";
import { getRuntimeConfigSync } from "../lib/runtimeConfig";

export const MAX_LLM_TOTAL_MS = 25000;

const FAST_FAIL_RETRY_WINDOW_MS = 25000;
const CIRCUIT_OPEN_FAILURE_COUNT = 5; // open when llmFailureCount > 5
const CIRCUIT_OPEN_WINDOW_MS = 30_000;
const CIRCUIT_DB_THROTTLE_MS = 10_000;

let llmFailureCount = 0;
let lastFailureTime = 0;
let lastCircuitDbWriteAt = 0;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("LLM_TIMEOUT")), ms)),
  ]);
}

function isRetryableLlmError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true; // includes 429
  if (err instanceof APIConnectionError) return true;
  if (err instanceof APIConnectionTimeoutError) return true;
  if (err instanceof Error && err.message === "LLM_TIMEOUT") return true;
  if (err instanceof Error && /429/i.test(err.message)) return true;
  return false;
}

function errorToken(err: unknown): string {
  if (err instanceof Error) return err.message || "llm_failed";
  return "llm_failed";
}

export function isLlmCircuitOpen(): boolean {
  return llmFailureCount > CIRCUIT_OPEN_FAILURE_COUNT && Date.now() - lastFailureTime < CIRCUIT_OPEN_WINDOW_MS;
}

export function getDynamicWorkerBatchSize(defaultSize = 5): number {
  // Controlled overload protection: unstable LLM -> slower parallelism.
  return llmFailureCount > 3 ? 1 : defaultSize;
}

export function getLlmFailureState() {
  return {
    llmFailureCount,
    lastFailureTime,
    circuit_open: isLlmCircuitOpen(),
  };
}

async function syncCircuitStateToDbIfNeeded(nextOpen: boolean, nextCount: number, nextLastFailureTime: number) {
  const now = Date.now();
  if (now - lastCircuitDbWriteAt < CIRCUIT_DB_THROTTLE_MS) return;
  lastCircuitDbWriteAt = now;

  try {
    const lastFailureAt = nextLastFailureTime > 0 ? new Date(nextLastFailureTime) : null;
    await db.query(
      `UPDATE config
       SET llm_failure_count = $1,
           llm_last_failure_at = $2,
           llm_circuit_open = $3,
           llm_circuit_updated_at = NOW()
       WHERE id = 1`,
      [nextCount, lastFailureAt, nextOpen],
    );
  } catch {
    // Metrics visibility should never break pipeline.
  }
}

async function openAiResponsesOnce(
  client: OpenAI,
  prompt: string,
  model: string,
  attemptTimeoutMs: number,
): Promise<{ ok: true; data: LlmResponse } | { ok: false; err: unknown; latencyMs: number }> {
  const start = Date.now();
  try {
    const response = await withTimeout(
      client.responses.create({
        model,
        input: prompt,
      }),
      attemptTimeoutMs,
    );
    const latencyMs = Date.now() - start;
    const tokensIn = response.usage?.input_tokens ?? 0;
    const tokensOut = response.usage?.output_tokens ?? 0;
    return {
      ok: true,
      data: { text: response.output_text.trim(), tokensIn, tokensOut, latencyMs },
    };
  } catch (err: unknown) {
    console.error("LLM ATTEMPT FAILED:", err);
    return { ok: false, err, latencyMs: Date.now() - start };
  }
}

export async function llmJson(prompt: string, options?: { model?: string; task?: string }): Promise<string> {
  const res = await callLlm(prompt, options);
  if (res.error) return '{"category":"general","confidence":0}';
  try {
    JSON.parse(res.text);
    return res.text;
  } catch {
    return '{"category":"general","confidence":0}';
  }
}

export async function llmText(prompt: string, options?: { model?: string; task?: string }): Promise<string> {
  const response = await callLlm(prompt, options);
  if (response.error) return "";
  return response.text.trim();
}

export interface LlmResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  error?: string;
}

export async function safeLLMCall<T>(
  fn: () => Promise<T>,
  context: string,
): Promise<{ success: true; data: T } | { success: false; error: string }> {
  try {
    const res = await fn();
    return { success: true, data: res };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "llm_failed";
    console.error("LLM ERROR:", context, errorMessage);
    return { success: false, error: errorMessage || "llm_failed" };
  }
}

export async function callLlm(prompt: string, options?: { model?: string; task?: string }): Promise<LlmResponse> {
  const apiKey = getRuntimeConfigSync("OPENAI_API_KEY");
  if (!apiKey) {
    return { text: "", tokensIn: 0, tokensOut: 0, latencyMs: 0, error: "no_api_key" };
  }

  // Circuit breaker: unstable LLM -> immediate fallback without waiting.
  if (isLlmCircuitOpen()) {
    // Update system_health when circuit is open
    try {
      await db.query(
        `UPDATE system_health SET status = 'down', error_message = 'LLM circuit breaker open', last_checked_at = NOW(), updated_at = NOW() WHERE service = 'openai'`,
      );
    } catch { /* health update must not break pipeline */ }
    return { text: "", tokensIn: 0, tokensOut: 0, latencyMs: 0, error: "circuit_open" };
  }

  const client = new OpenAI({ apiKey });
  const model = options?.model ?? "gpt-4.1-mini";
  const task = options?.task ?? "generation";
  const startTime = Date.now();

  const doAttempt = async (attemptTimeoutMs: number) => {
    const res = await openAiResponsesOnce(client, prompt, model, attemptTimeoutMs);
    return res;
  };

  // Attempt 1: fail-fast timeout to keep overall latency bounded.
  const attempt1ElapsedBudgetMs = Math.min(MAX_LLM_TOTAL_MS, FAST_FAIL_RETRY_WINDOW_MS);
  const attempt1TimeoutMs = Math.max(400, attempt1ElapsedBudgetMs);
  const first = await doAttempt(attempt1TimeoutMs);
  if (first.ok) {
    llmFailureCount = 0;
    lastFailureTime = 0;
    await syncCircuitStateToDbIfNeeded(false, 0, 0);
    // Track token usage for cost control
    try { await trackTokenUsage(first.data.tokensIn, first.data.tokensOut); } catch { /* non-critical */ }
    try { await recordModelOutcome({ model, task, success: true, tokensIn: first.data.tokensIn, tokensOut: first.data.tokensOut }); } catch { /* non-critical */ }
    // Update system_health on success
    try {
      await db.query(
        `UPDATE system_health SET status = 'ok', error_message = NULL, last_checked_at = NOW(), last_ok_at = NOW(), updated_at = NOW() WHERE service = 'openai'`,
      );
    } catch { /* non-critical */ }
    return first.data;
  }

  const elapsedAfterFirst = Date.now() - startTime;
  const timeLeft = MAX_LLM_TOTAL_MS - elapsedAfterFirst;

  if (!isRetryableLlmError(first.err)) {
    llmFailureCount += 1;
    lastFailureTime = Date.now();
    await syncCircuitStateToDbIfNeeded(isLlmCircuitOpen(), llmFailureCount, lastFailureTime);
    try { await recordModelOutcome({ model, task, success: false, tokensIn: 0, tokensOut: 0 }); } catch { /* non-critical */ }
    return {
      text: "",
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      error: errorToken(first.err),
    };
  }

  // Retry only if (1) failure was fast and (2) we still have time for attempt 2.
  const shouldRetry =
    elapsedAfterFirst <= FAST_FAIL_RETRY_WINDOW_MS && timeLeft > 250 && Date.now() - startTime < MAX_LLM_TOTAL_MS;

  if (!shouldRetry) {
    llmFailureCount += 1;
    lastFailureTime = Date.now();
    await syncCircuitStateToDbIfNeeded(isLlmCircuitOpen(), llmFailureCount, lastFailureTime);
    try { await recordModelOutcome({ model, task, success: false, tokensIn: 0, tokensOut: 0 }); } catch { /* non-critical */ }
    return {
      text: "",
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      error: errorToken(first.err),
    };
  }

  // Attempt 2: only if time remains.
  const attempt2TimeoutMs = Math.max(400, Math.min(timeLeft, 8000));
  const second = await doAttempt(attempt2TimeoutMs);
  if (second.ok) {
    llmFailureCount = 0;
    lastFailureTime = 0;
    await syncCircuitStateToDbIfNeeded(false, 0, 0);
    try { await trackTokenUsage(second.data.tokensIn, second.data.tokensOut); } catch { /* non-critical */ }
    try { await recordModelOutcome({ model, task, success: true, tokensIn: second.data.tokensIn, tokensOut: second.data.tokensOut }); } catch { /* non-critical */ }
    try {
      await db.query(
        `UPDATE system_health SET status = 'ok', error_message = NULL, last_checked_at = NOW(), last_ok_at = NOW(), updated_at = NOW() WHERE service = 'openai'`,
      );
    } catch { /* non-critical */ }
    return second.data;
  }

  llmFailureCount += 1;
  lastFailureTime = Date.now();
  await syncCircuitStateToDbIfNeeded(isLlmCircuitOpen(), llmFailureCount, lastFailureTime);
  try { await recordModelOutcome({ model, task, success: false, tokensIn: 0, tokensOut: 0 }); } catch { /* non-critical */ }

  return {
    text: "",
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: 0,
    error: errorToken(second.err),
  };
}
