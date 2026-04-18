import { normalizeError, type AppError } from "./errorNormalizer";

export type ErrorHandlingSource = "api" | "worker" | "ui" | "middleware";

export type ErrorSubsystem =
  | "gmail"
  | "rag"
  | "llm"
  | "safety"
  | "db"
  | "worker"
  | "api"
  | "system"
  | "auth";

export type RecoveryAction =
  | "none"
  | "reauth_required"
  | "backoff_retry"
  | "cursor_reset_full_resync"
  | "refresh_state_once"
  | "fallback_without_rag"
  | "fallback_manual_mode"
  | "escalate";

export type ErrorRecoveryContext = {
  source: ErrorHandlingSource;
  route?: string;
  operation?: string;
  subsystem?: ErrorSubsystem;
  resourceId?: string | number;
  maxAttempts?: number;
};

export type ErrorRecoveryDecision = {
  appError: AppError;
  subsystem: ErrorSubsystem;
  action: RecoveryAction;
  attempted: boolean;
  recovered: boolean;
  fallbackApplied: boolean;
  userActionRequired: boolean;
  attemptCount: number;
  maxAttempts: number;
  cooldownMs?: number;
};

type RecoveryLoopState = {
  attemptCount: number;
  windowStartedAt: number;
  lastAttemptAt: number;
};

const RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const recoveryState = new Map<string, RecoveryLoopState>();

function normalizeText(input: string): string {
  return input.trim().toLowerCase();
}

function deriveSubsystemFromRoute(route?: string): ErrorSubsystem {
  const value = normalizeText(route ?? "");
  if (!value) return "api";
  if (value.includes("gmail") || value.includes("sync") || value.includes("connect") || value.includes("callback")) return "gmail";
  if (value.includes("rag") || value.includes("embedding")) return "rag";
  if (value.includes("send") || value.includes("draft")) return "safety";
  if (value.includes("health") || value.includes("diagnostic") || value.includes("system")) return "system";
  if (value.includes("auth") || value.includes("login") || value.includes("session")) return "auth";
  return "api";
}

function deriveSubsystemFromOperation(operation?: string): ErrorSubsystem {
  const value = normalizeText(operation ?? "");
  if (!value) return "worker";
  if (value.includes("gmail") || value.includes("ingest") || value.includes("history")) return "gmail";
  if (value.includes("rag") || value.includes("embedding")) return "rag";
  if (value.includes("llm") || value.includes("model") || value.includes("generation") || value.includes("classify")) return "llm";
  if (value.includes("send") || value.includes("safety")) return "safety";
  if (value.includes("db") || value.includes("schema")) return "db";
  return "worker";
}

function resolveSubsystem(context: ErrorRecoveryContext): ErrorSubsystem {
  if (context.subsystem) return context.subsystem;
  if (context.source === "api" || context.source === "middleware" || context.source === "ui") {
    return deriveSubsystemFromRoute(context.route ?? context.operation);
  }
  return deriveSubsystemFromOperation(context.operation);
}

export function inferSubsystemFromRoute(route?: string): ErrorSubsystem {
  return deriveSubsystemFromRoute(route);
}

function buildRecoveryKey(error: AppError, context: ErrorRecoveryContext, subsystem: ErrorSubsystem): string {
  const resource = context.resourceId != null ? String(context.resourceId) : "global";
  const operation = normalizeText(context.operation ?? context.route ?? "unknown");
  return [context.source, subsystem, error.code, resource, operation].join("|");
}

function nextAttemptState(key: string, maxAttempts: number): { allowed: boolean; attemptCount: number } {
  const now = Date.now();
  const previous = recoveryState.get(key);

  if (!previous || now - previous.windowStartedAt > RECOVERY_WINDOW_MS) {
    recoveryState.set(key, {
      attemptCount: 1,
      windowStartedAt: now,
      lastAttemptAt: now,
    });
    return { allowed: true, attemptCount: 1 };
  }

  const attemptCount = previous.attemptCount + 1;
  recoveryState.set(key, {
    attemptCount,
    windowStartedAt: previous.windowStartedAt,
    lastAttemptAt: now,
  });

  return { allowed: attemptCount <= maxAttempts, attemptCount };
}

function withManualFallbackGuidance(error: AppError): AppError {
  return {
    ...error,
    severity: error.severity === "critical" ? "critical" : "high",
    autoRecoverable: false,
    retryable: false,
    reason: `${error.reason} Automatic generation was disabled for safety and reliability.`,
    fix: "Review and approve a manual draft before sending.",
    fixNowPath: error.fixNowPath ?? "/inbox",
  };
}

function withRagFallbackGuidance(error: AppError): AppError {
  return {
    ...error,
    severity: error.severity === "critical" ? "critical" : "medium",
    retryable: true,
    autoRecoverable: true,
    reason: `${error.reason} The system switched to generation without RAG context.`,
    fix: "Retry if context quality remains poor, or continue with clarification/manual review.",
  };
}

function withAuthGuidance(error: AppError): AppError {
  const fixNowPath =
    error.fixNowPath ??
    (error.code === "AUTH_REQUIRED"
      ? "/login"
      : error.code === "GMAIL_AUTH"
      ? "/onboarding"
      : "/settings");

  return {
    ...error,
    category: "AUTH",
    severity: "critical",
    retryable: false,
    autoRecoverable: false,
    fixNowPath,
  };
}

function withExhaustedRecovery(error: AppError): AppError {
  const suffix = "Automatic recovery attempts were exhausted.";
  const reason = error.reason.includes(suffix) ? error.reason : `${error.reason} ${suffix}`;
  return {
    ...error,
    severity: error.severity === "critical" ? "critical" : "high",
    retryable: false,
    autoRecoverable: false,
    reason,
    fix: "Use Fix now and complete the recommended remediation before retrying.",
    fixNowPath: error.fixNowPath ?? "/settings",
  };
}

function isHistoryCursorError(error: AppError): boolean {
  const text = normalizeText(`${error.code} ${error.message} ${error.reason}`);
  return text.includes("history") || text.includes("cursor") || text.includes("starthistoryid");
}

function defaultMaxAttempts(action: RecoveryAction): number {
  if (action === "cursor_reset_full_resync") return 2;
  if (action === "refresh_state_once") return 1;
  if (action === "backoff_retry") return DEFAULT_MAX_ATTEMPTS;
  return 1;
}

function computeBackoffMs(attemptCount: number): number {
  const base = 1_000;
  const exponential = base * Math.pow(2, Math.max(0, attemptCount - 1));
  return Math.min(exponential, 30_000);
}

function resolveAction(error: AppError, subsystem: ErrorSubsystem): RecoveryAction {
  if (error.category === "AUTH") return "reauth_required";

  if (subsystem === "rag" && (error.category === "NETWORK" || error.category === "API" || error.category === "UNKNOWN")) {
    return "fallback_without_rag";
  }

  if (
    subsystem === "llm" &&
    (error.category === "RATE_LIMIT" || error.category === "NETWORK" || error.category === "API" || error.category === "UNKNOWN")
  ) {
    return "fallback_manual_mode";
  }

  if (subsystem === "safety") {
    return "fallback_manual_mode";
  }

  if (error.category === "RATE_LIMIT" || error.category === "NETWORK") {
    return "backoff_retry";
  }

  if (error.category === "DATA_INCONSISTENCY") {
    return isHistoryCursorError(error) ? "cursor_reset_full_resync" : "refresh_state_once";
  }

  if (error.category === "STATE") {
    return "refresh_state_once";
  }

  if (error.category === "API") {
    return error.retryable ? "backoff_retry" : "escalate";
  }

  return "escalate";
}

export function evaluateErrorRecovery(errorLike: unknown, context: ErrorRecoveryContext): ErrorRecoveryDecision {
  const appError = normalizeError(errorLike, {
    source: context.source,
    ...(context.route ? { route: context.route } : {}),
    ...(context.operation ? { operation: context.operation } : {}),
  });

  const subsystem = resolveSubsystem(context);
  const action = resolveAction(appError, subsystem);

  if (action === "none") {
    return {
      appError,
      subsystem,
      action,
      attempted: false,
      recovered: false,
      fallbackApplied: false,
      userActionRequired: false,
      attemptCount: 0,
      maxAttempts: 0,
    };
  }

  if (action === "reauth_required") {
    return {
      appError: withAuthGuidance(appError),
      subsystem,
      action,
      attempted: false,
      recovered: false,
      fallbackApplied: false,
      userActionRequired: true,
      attemptCount: 0,
      maxAttempts: 0,
    };
  }

  if (action === "fallback_without_rag") {
    return {
      appError: withRagFallbackGuidance(appError),
      subsystem,
      action,
      attempted: true,
      recovered: true,
      fallbackApplied: true,
      userActionRequired: false,
      attemptCount: 1,
      maxAttempts: 1,
    };
  }

  if (action === "fallback_manual_mode") {
    return {
      appError: withManualFallbackGuidance(appError),
      subsystem,
      action,
      attempted: true,
      recovered: true,
      fallbackApplied: true,
      userActionRequired: true,
      attemptCount: 1,
      maxAttempts: 1,
    };
  }

  const maxAttempts = Math.max(1, context.maxAttempts ?? defaultMaxAttempts(action));
  const key = buildRecoveryKey(appError, context, subsystem);
  const attempt = nextAttemptState(key, maxAttempts);

  if (!attempt.allowed) {
    return {
      appError: withExhaustedRecovery(appError),
      subsystem,
      action: "escalate",
      attempted: false,
      recovered: false,
      fallbackApplied: false,
      userActionRequired: true,
      attemptCount: attempt.attemptCount,
      maxAttempts,
    };
  }

  const cooldownMs =
    action === "backoff_retry"
      ? appError.retryAfterMs ?? computeBackoffMs(attempt.attemptCount)
      : undefined;

  return {
    appError,
    subsystem,
    action,
    attempted: true,
    recovered: false,
    fallbackApplied: false,
    userActionRequired: false,
    attemptCount: attempt.attemptCount,
    maxAttempts,
    ...(typeof cooldownMs === "number" ? { cooldownMs } : {}),
  };
}

export function toRecoveryMeta(decision: ErrorRecoveryDecision): Record<string, unknown> {
  return {
    subsystem: decision.subsystem,
    action: decision.action,
    attempted: decision.attempted,
    recovered: decision.recovered,
    fallbackApplied: decision.fallbackApplied,
    userActionRequired: decision.userActionRequired,
    attemptCount: decision.attemptCount,
    maxAttempts: decision.maxAttempts,
    ...(typeof decision.cooldownMs === "number" ? { cooldownMs: decision.cooldownMs } : {}),
  };
}
