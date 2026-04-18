import { updateServiceHealth } from "../db/systemHealth";
import { evaluateErrorRecovery, toRecoveryMeta } from "./errorIntelligence";
import { saveErrorLog } from "../db/errorLogs";
import { normalizeError, type AppError } from "./errorNormalizer";

function deriveServiceFromOperation(operation: string): "gmail" | "openai" | "worker" {
  const text = operation.toLowerCase();
  if (text.includes("ingest") || text.includes("gmail") || text.includes("history")) return "gmail";
  if (text.includes("llm") || text.includes("generation") || text.includes("classify") || text.includes("model")) return "openai";
  return "worker";
}

async function mirrorHealthFromError(appError: AppError, operation: string): Promise<void> {
  const service = deriveServiceFromOperation(operation);
  const nextStatus = appError.severity === "critical" ? "down" : "degraded";
  await updateServiceHealth(service, nextStatus, `${appError.code}: ${appError.reason}`);
}

export async function handleWorkerError(
  err: unknown,
  context: { worker: string; operation: string; meta?: unknown },
): Promise<AppError> {
  const operationKey = `${context.worker}:${context.operation}`;
  const recovered = evaluateErrorRecovery(
    normalizeError(err, {
      source: "worker",
      operation: operationKey,
      fallbackStatus: 500,
    }),
    {
      source: "worker",
      operation: operationKey,
    },
  );
  const appError = recovered.appError;
  const recoveryMeta = toRecoveryMeta(recovered);

  if (appError.severity === "critical" || appError.severity === "high") {
    try {
      await mirrorHealthFromError(appError, operationKey);
    } catch {
      // Keep worker alive even if health mirroring fails.
    }
  }

  try {
    await saveErrorLog({
      error: appError,
      source: "worker",
      operation: context.operation,
      route: context.worker,
      meta: {
        ...(typeof context.meta === "object" && context.meta !== null ? (context.meta as Record<string, unknown>) : {}),
        raw: err instanceof Error ? err.message : String(err ?? "unknown_error"),
        recovery: recoveryMeta,
      },
    });
  } catch {
    // Keep worker alive even if logging fails.
  }

  return appError;
}
