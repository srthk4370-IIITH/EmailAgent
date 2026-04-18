import { evaluateErrorRecovery } from "./errorIntelligence";
import { normalizeApiErrorPayload, normalizeError, type AppError } from "./errorNormalizer";

export class AppRequestError extends Error {
  appError: AppError;

  constructor(appError: AppError) {
    super(appError.message);
    this.name = "AppRequestError";
    this.appError = appError;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit): string {
  const method = (init?.method ?? "GET").toUpperCase();
  const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
  return `${method} ${target}`;
}

export async function fetchJsonWithAppError<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: { retries?: number; retryDelayMs?: number },
): Promise<T> {
  const retries = Math.max(0, options?.retries ?? 0);
  const retryDelayMs = Math.max(250, options?.retryDelayMs ?? 800);
  const operation = describeRequest(input, init);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(input, init);
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const recovered = evaluateErrorRecovery(normalizeApiErrorPayload(payload, response.status), {
          source: "ui",
          operation,
          route: operation,
          subsystem: "api",
        });
        const appError = recovered.appError;
        if (attempt < retries && appError.retryable) {
          const waitMs = recovered.cooldownMs ?? appError.retryAfterMs ?? retryDelayMs * (attempt + 1);
          await sleep(waitMs);
          continue;
        }
        throw new AppRequestError(appError);
      }

      return payload as T;
    } catch (err) {
      const baseError = err instanceof AppRequestError
        ? err.appError
        : normalizeError(err, { source: "ui", operation, fallbackStatus: 503 });
      const recovered = evaluateErrorRecovery(baseError, {
        source: "ui",
        operation,
        route: operation,
        subsystem: "api",
      });
      const appError = recovered.appError;

      if (attempt < retries && appError.retryable) {
        const waitMs = recovered.cooldownMs ?? appError.retryAfterMs ?? retryDelayMs * (attempt + 1);
        await sleep(waitMs);
        continue;
      }
      throw new AppRequestError(appError);
    }
  }

  const exhausted = evaluateErrorRecovery(
    normalizeError("exhausted_retries", { source: "ui", operation, fallbackStatus: 503 }),
    {
      source: "ui",
      operation,
      route: operation,
      subsystem: "api",
    },
  );

  throw new AppRequestError(
    exhausted.appError,
  );
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppRequestError) return err.appError;
  return normalizeError(err, { source: "ui", fallbackStatus: 500 });
}
