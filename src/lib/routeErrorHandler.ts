import { NextResponse } from "next/server";

import { saveErrorLog } from "../db/errorLogs";
import { evaluateErrorRecovery, inferSubsystemFromRoute, toRecoveryMeta } from "./errorIntelligence";
import { normalizeApiErrorPayload, normalizeError, type AppError } from "./errorNormalizer";

export type ApiRouteContext = {
  route: string;
  operation: string;
  source?: "api" | "middleware";
};

type ApiHandler = (...args: any[]) => Promise<NextResponse>;

async function getEmailIdFromArgs(args: any[]): Promise<number | null> {
  const context = args[1];
  if (!context || typeof context !== "object") return null;

  if (!("params" in context)) return null;
  const rawParams = (context as { params?: unknown }).params;
  const params =
    rawParams && typeof (rawParams as Promise<unknown>).then === "function"
      ? await (rawParams as Promise<Record<string, unknown>>)
      : (rawParams as Record<string, unknown> | undefined);

  const id = Number(params?.id ?? NaN);
  return Number.isFinite(id) ? id : null;
}

async function logApiError(error: AppError, context: ApiRouteContext, args: any[], meta?: unknown): Promise<void> {
  try {
    const emailId = await getEmailIdFromArgs(args);
    await saveErrorLog({
      error,
      source: context.source ?? "api",
      route: context.route,
      operation: context.operation,
      emailId,
      meta,
    });
  } catch {
    // Error logging should never break request handling.
  }
}

async function normalizeResponseError(response: NextResponse, context: ApiRouteContext, args: any[]): Promise<NextResponse> {
  if (response.status < 400) return response;

  try {
    const payload = await response.clone().json().catch(() => null);
    const recovered = evaluateErrorRecovery(normalizeApiErrorPayload(payload, response.status), {
      source: context.source ?? "api",
      route: context.route,
      operation: context.operation,
      subsystem: inferSubsystemFromRoute(context.route),
    });
    const appError = recovered.appError;
    const recoveryMeta = toRecoveryMeta(recovered);
    await logApiError(appError, context, args, {
      status: response.status,
      existingPayload: payload,
      recovery: recoveryMeta,
    });
    return NextResponse.json({ error: appError, recovery: recoveryMeta }, { status: appError.status });
  } catch (err) {
    const recovered = evaluateErrorRecovery(
      normalizeError(err, {
        route: context.route,
        operation: context.operation,
        source: context.source ?? "api",
        fallbackStatus: response.status,
      }),
      {
        source: context.source ?? "api",
        route: context.route,
        operation: context.operation,
        subsystem: inferSubsystemFromRoute(context.route),
      },
    );
    const appError = recovered.appError;
    const recoveryMeta = toRecoveryMeta(recovered);
    await logApiError(appError, context, args, {
      status: response.status,
      recovery: recoveryMeta,
    });
    return NextResponse.json({ error: appError, recovery: recoveryMeta }, { status: appError.status });
  }
}

export function withApiRoute<T extends ApiHandler>(handler: T, context: ApiRouteContext): T {
  return (async (...args: any[]) => {
    try {
      const response = await handler(...args);
      return await normalizeResponseError(response, context, args);
    } catch (err) {
      const recovered = evaluateErrorRecovery(
        normalizeError(err, {
          route: context.route,
          operation: context.operation,
          source: context.source ?? "api",
        }),
        {
          source: context.source ?? "api",
          route: context.route,
          operation: context.operation,
          subsystem: inferSubsystemFromRoute(context.route),
        },
      );
      const appError = recovered.appError;
      const recoveryMeta = toRecoveryMeta(recovered);
      await logApiError(appError, context, args, {
        thrown: true,
        raw: err instanceof Error ? err.message : String(err ?? "unknown_error"),
        recovery: recoveryMeta,
      });
      return NextResponse.json({ error: appError, recovery: recoveryMeta }, { status: appError.status });
    }
  }) as T;
}
