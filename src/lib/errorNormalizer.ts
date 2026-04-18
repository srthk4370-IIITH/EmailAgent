export type AppErrorCategory =
  | "AUTH"
  | "RATE_LIMIT"
  | "DATA_INCONSISTENCY"
  | "NETWORK"
  | "API"
  | "STATE"
  | "UNKNOWN";

export type AppErrorSeverity = "low" | "medium" | "high" | "critical";

export type AppError = {
  code: string;
  category: AppErrorCategory;
  severity: AppErrorSeverity;
  retryable: boolean;
  autoRecoverable: boolean;
  message: string;
  reason: string;
  fix: string;
  status: number;
  fixNowPath?: string;
  retryAfterMs?: number;
  timestamp: string;
};

type ErrorSource = "api" | "worker" | "ui" | "middleware";

type ErrorContext = {
  operation?: string;
  route?: string;
  source?: ErrorSource;
  fallbackStatus?: number;
};

type NormalizerRule = {
  code: string;
  category: AppErrorCategory;
  status: number;
  severity: AppErrorSeverity;
  retryable: boolean;
  autoRecoverable: boolean;
  message: string;
  reason: string;
  fix: string;
  fixNowPath?: string;
  retryAfterMs?: number;
  test: (text: string, status: number) => boolean;
};

type ErrorPayloadLike = {
  error?: unknown;
  code?: unknown;
  category?: unknown;
  message?: unknown;
  cause?: unknown;
  reason?: unknown;
  fix?: unknown;
  severity?: unknown;
  retryable?: unknown;
  autoRecoverable?: unknown;
  status?: unknown;
  fixNowPath?: unknown;
  retryAfterMs?: unknown;
};

const KNOWN_CATEGORIES = new Set<AppErrorCategory>([
  "AUTH",
  "RATE_LIMIT",
  "DATA_INCONSISTENCY",
  "NETWORK",
  "API",
  "STATE",
  "UNKNOWN",
]);

const LEGACY_SEVERITY_MAP: Record<string, AppErrorSeverity> = {
  info: "low",
  warning: "medium",
  error: "high",
};

const RULES: NormalizerRule[] = [
  {
    code: "INVALID_HISTORY_CURSOR",
    category: "DATA_INCONSISTENCY",
    status: 409,
    severity: "high",
    retryable: true,
    autoRecoverable: true,
    message: "Mailbox cursor invalidated",
    reason: "Gmail history cursor is stale or no longer valid.",
    fix: "Run one full mailbox resync and persist the new history baseline cursor.",
    test: (text, status) =>
      text.includes("starthistoryid") ||
      (status === 400 && text.includes("historyid") && (text.includes("invalid") || text.includes("too old") || text.includes("expired"))),
  },
  {
    code: "OPENAI_AUTH",
    category: "AUTH",
    status: 401,
    severity: "critical",
    retryable: false,
    autoRecoverable: false,
    message: "OpenAI credentials invalid",
    reason: "The OpenAI API key is missing, revoked, or malformed.",
    fix: "Update OPENAI_API_KEY in Settings, then retry.",
    fixNowPath: "/settings",
    test: (text, status) =>
      (status === 401 && text.includes("openai")) ||
      text.includes("invalid_api_key") ||
      text.includes("no_api_key"),
  },
  {
    code: "GMAIL_AUTH",
    category: "AUTH",
    status: 401,
    severity: "critical",
    retryable: false,
    autoRecoverable: false,
    message: "Gmail disconnected",
    reason: "Google authentication is missing, expired, or revoked.",
    fix: "Reconnect Gmail in onboarding/settings and approve required scopes.",
    fixNowPath: "/onboarding",
    test: (text) =>
      text.includes("gmail") &&
      (text.includes("invalid_grant") ||
        text.includes("refresh token") ||
        (text.includes("token") && text.includes("expired")) ||
        text.includes("missing or invalid")),
  },
  {
    code: "RATE_LIMIT",
    category: "RATE_LIMIT",
    status: 429,
    severity: "medium",
    retryable: true,
    autoRecoverable: true,
    retryAfterMs: 8_000,
    message: "Rate limit reached",
    reason: "Too many requests were sent in a short interval.",
    fix: "Wait briefly and retry. If this repeats, reduce burst traffic or increase provider quota.",
    test: (text, status) =>
      status === 429 || text.includes("rate limit") || text.includes("quota") || text.includes("too many requests"),
  },
  {
    code: "OPENAI_UNAVAILABLE",
    category: "NETWORK",
    status: 503,
    severity: "high",
    retryable: true,
    autoRecoverable: true,
    retryAfterMs: 5_000,
    message: "OpenAI service unavailable",
    reason: "Model provider is temporarily unreachable or timing out.",
    fix: "Retry soon. If persistent, check network and provider status.",
    test: (text) =>
      text.includes("llm_timeout") ||
      text.includes("apiconnection") ||
      (text.includes("openai") &&
        (text.includes("timeout") || text.includes("network") || text.includes("econnreset") || text.includes("unreachable"))),
  },
  {
    code: "DB_ERROR",
    category: "STATE",
    status: 503,
    severity: "critical",
    retryable: true,
    autoRecoverable: true,
    retryAfterMs: 4_000,
    message: "Database unavailable",
    reason: "Required data could not be read or written.",
    fix: "Verify database connectivity, credentials, migrations, then retry.",
    fixNowPath: "/settings",
    test: (text) =>
      text.includes("database") ||
      (text.includes("db") &&
        (text.includes("timeout") ||
          text.includes("connect") ||
          text.includes("relation") ||
          text.includes("deadlock") ||
          text.includes("password authentication") ||
          text.includes("database_url") ||
          text.includes("connection"))),
  },
  {
    code: "WORKER_FAILURE",
    category: "STATE",
    status: 500,
    severity: "high",
    retryable: true,
    autoRecoverable: true,
    retryAfterMs: 3_000,
    message: "Background worker failed",
    reason: "A worker operation failed unexpectedly.",
    fix: "Retry the action. If failures continue, inspect worker/system health logs.",
    test: (text) => text.includes("worker") || text.includes("tick failed") || text.includes("heartbeat") || text.includes("stalled"),
  },
  {
    code: "AUTH_REQUIRED",
    category: "AUTH",
    status: 401,
    severity: "high",
    retryable: false,
    autoRecoverable: false,
    message: "Authentication required",
    reason: "Session is missing or expired.",
    fix: "Sign in again and retry the action.",
    fixNowPath: "/login",
    test: (text, status) => status === 401 || text.includes("unauthorized") || text.includes("forbidden") || text.includes("session"),
  },
  {
    code: "VALIDATION_ERROR",
    category: "API",
    status: 400,
    severity: "low",
    retryable: false,
    autoRecoverable: false,
    message: "Invalid request input",
    reason: "One or more required fields are malformed or missing.",
    fix: "Correct invalid input values, then submit again.",
    test: (text, status) =>
      status === 400 && (text.includes("zod") || text.includes("validation") || text.includes("invalid request")),
  },
  {
    code: "NETWORK_TIMEOUT",
    category: "NETWORK",
    status: 503,
    severity: "high",
    retryable: true,
    autoRecoverable: true,
    retryAfterMs: 4_000,
    message: "Network timeout",
    reason: "A required dependency did not respond in time.",
    fix: "Retry shortly. If repeated, inspect network connectivity and upstream service status.",
    test: (text) => text.includes("timeout") || text.includes("network") || text.includes("econnreset") || text.includes("enotfound"),
  },
];

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeText(input: string): string {
  return input.trim().toLowerCase();
}

function toFiniteStatus(value: unknown, fallback: number): number {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  return fallback;
}

function clampRetryAfterMs(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.round(n), 120_000);
}

function humanizeCode(code: string): string {
  return code
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function normalizeSeverity(rawSeverity: string, fallback: AppErrorSeverity): AppErrorSeverity {
  const normalized = rawSeverity.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "critical") {
    return normalized;
  }
  if (LEGACY_SEVERITY_MAP[normalized]) {
    return LEGACY_SEVERITY_MAP[normalized];
  }
  return fallback;
}

function normalizeCategory(rawCategory: string, fallback: AppErrorCategory): AppErrorCategory {
  const candidate = rawCategory.trim().toUpperCase() as AppErrorCategory;
  return KNOWN_CATEGORIES.has(candidate) ? candidate : fallback;
}

function inferCategory(text: string, status: number, code = ""): AppErrorCategory {
  const normalizedCode = code.toUpperCase();

  if (
    status === 401 ||
    status === 403 ||
    normalizedCode.includes("AUTH") ||
    normalizedCode.includes("TOKEN") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("invalid_grant")
  ) {
    return "AUTH";
  }

  if (
    status === 429 ||
    normalizedCode.includes("RATE") ||
    text.includes("rate limit") ||
    text.includes("quota") ||
    text.includes("too many requests")
  ) {
    return "RATE_LIMIT";
  }

  if (
    normalizedCode.includes("HISTORY") ||
    normalizedCode.includes("CURSOR") ||
    (text.includes("historyid") && (text.includes("invalid") || text.includes("expired") || text.includes("too old")))
  ) {
    return "DATA_INCONSISTENCY";
  }

  if (
    normalizedCode.includes("TIMEOUT") ||
    normalizedCode.includes("NETWORK") ||
    text.includes("timeout") ||
    text.includes("network") ||
    text.includes("econnreset") ||
    text.includes("enotfound") ||
    text.includes("unreachable")
  ) {
    return "NETWORK";
  }

  if (status === 409 || status === 412 || normalizedCode.includes("STATE") || normalizedCode.includes("DB")) {
    return "STATE";
  }

  if (status >= 400 && status < 500) {
    return "API";
  }

  if (status >= 500) {
    return "STATE";
  }

  return "UNKNOWN";
}

function defaultSeverityForCategory(category: AppErrorCategory, status: number): AppErrorSeverity {
  if (category === "AUTH") return "critical";
  if (category === "RATE_LIMIT") return "medium";
  if (category === "DATA_INCONSISTENCY") return "high";
  if (category === "NETWORK") return "high";
  if (category === "STATE") return status >= 500 ? "critical" : "high";
  if (category === "API") return status >= 500 ? "high" : "low";
  return "high";
}

function defaultRetryable(category: AppErrorCategory, status: number): boolean {
  if (category === "AUTH") return false;
  if (category === "RATE_LIMIT") return true;
  if (category === "DATA_INCONSISTENCY") return true;
  if (category === "NETWORK") return true;
  if (category === "STATE") return true;
  if (category === "API") return status >= 500;
  return status >= 500;
}

function defaultAutoRecoverable(category: AppErrorCategory, retryable: boolean): boolean {
  if (category === "AUTH") return false;
  if (category === "API") return retryable;
  if (category === "UNKNOWN") return retryable;
  return retryable;
}

function defaultFixNowPath(category: AppErrorCategory, code: string): string | undefined {
  if (code === "AUTH_REQUIRED") return "/login";
  if (code === "GMAIL_AUTH") return "/onboarding";
  if (code === "OPENAI_AUTH") return "/settings";
  if (category === "AUTH") return "/settings";
  if (category === "STATE") return "/settings";
  return undefined;
}

function buildAppError(input: {
  code: string;
  category: AppErrorCategory;
  severity: AppErrorSeverity;
  retryable: boolean;
  autoRecoverable: boolean;
  message: string;
  reason: string;
  fix: string;
  status: number;
  fixNowPath?: string;
  retryAfterMs?: number;
}): AppError {
  const base = {
    code: input.code,
    category: input.category,
    severity: input.severity,
    retryable: input.retryable,
    autoRecoverable: input.autoRecoverable,
    message: input.message,
    reason: input.reason,
    fix: input.fix,
    status: input.status,
    timestamp: new Date().toISOString(),
  };

  const withFixPath = input.fixNowPath ? { ...base, fixNowPath: input.fixNowPath } : base;
  return typeof input.retryAfterMs === "number" ? { ...withFixPath, retryAfterMs: input.retryAfterMs } : withFixPath;
}

function pickMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (isObject(error)) {
    const payload = error as ErrorPayloadLike;
    const rawError = payload.error;
    if (typeof rawError === "string") return rawError;
    if (isObject(rawError) && typeof rawError.message === "string") return rawError.message;
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.reason === "string") return payload.reason;
    if (typeof payload.cause === "string") return payload.cause;
  }
  return asString(error) || "unknown_error";
}

function fromStructuredPayload(payload: ErrorPayloadLike, fallbackStatus: number): AppError | null {
  const rawError = payload.error;
  const nested = isObject(rawError) ? (rawError as ErrorPayloadLike) : null;
  const source = nested ?? payload;

  const code = asString(source.code || source.error).trim();
  const message = asString(source.message).trim();
  const reason = asString(source.reason || source.cause).trim();
  const fix = asString(source.fix).trim();
  const status = toFiniteStatus(source.status, fallbackStatus);
  const text = normalizeText([code, message, reason].filter(Boolean).join(" "));

  if (!code && !message && !reason && !fix) return null;

  const inferredCategory = inferCategory(text, status, code);
  const category = normalizeCategory(asString(source.category), inferredCategory);
  const severity = normalizeSeverity(asString(source.severity), defaultSeverityForCategory(category, status));

  const retryableFromPayload = typeof source.retryable === "boolean" ? source.retryable : null;
  const retryable = retryableFromPayload ?? defaultRetryable(category, status);

  const autoRecoverableFromPayload = typeof source.autoRecoverable === "boolean" ? source.autoRecoverable : null;
  const autoRecoverable = autoRecoverableFromPayload ?? defaultAutoRecoverable(category, retryable);

  const retryAfterMs = clampRetryAfterMs(source.retryAfterMs);
  const fixNowPath = asString(source.fixNowPath) || defaultFixNowPath(category, code || "UNKNOWN_ERROR");

  return buildAppError({
    code: code || "UNKNOWN_ERROR",
    category,
    severity,
    retryable,
    autoRecoverable,
    message: message || (code ? humanizeCode(code) : "Unexpected error"),
    reason: reason || "The request could not be completed.",
    fix: fix || "Retry the action. If the issue persists, contact support.",
    status,
    ...(fixNowPath ? { fixNowPath } : {}),
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  });
}

export function normalizeApiErrorPayload(payload: unknown, status = 500): AppError {
  if (isObject(payload)) {
    const structured = fromStructuredPayload(payload as ErrorPayloadLike, status);
    if (structured) return structured;
  }
  return normalizeError(payload, { fallbackStatus: status, source: "api" });
}

export function normalizeError(error: unknown, context: ErrorContext = {}): AppError {
  if (isObject(error)) {
    const structured = fromStructuredPayload(
      error as ErrorPayloadLike,
      toFiniteStatus((error as ErrorPayloadLike).status, context.fallbackStatus ?? 500),
    );
    if (structured) return structured;
  }

  const fallbackStatus = context.fallbackStatus ?? 500;
  const status = isObject(error) ? toFiniteStatus((error as { status?: unknown }).status, fallbackStatus) : fallbackStatus;
  const text = normalizeText(pickMessage(error));

  const rule = RULES.find((candidate) => candidate.test(text, status));
  if (rule) {
    return buildAppError({
      code: rule.code,
      category: rule.category,
      message: rule.message,
      reason: rule.reason,
      fix: rule.fix,
      severity: rule.severity,
      retryable: rule.retryable,
      autoRecoverable: rule.autoRecoverable,
      status: rule.status,
      ...(rule.fixNowPath ? { fixNowPath: rule.fixNowPath } : {}),
      ...(typeof rule.retryAfterMs === "number" ? { retryAfterMs: rule.retryAfterMs } : {}),
    });
  }

  const category = inferCategory(text, status);
  const severity = defaultSeverityForCategory(category, status);
  const retryable = defaultRetryable(category, status);
  const autoRecoverable = defaultAutoRecoverable(category, retryable);

  const operation = context.operation ? ` while ${context.operation}` : "";
  const route = context.route ? ` for ${context.route}` : "";
  const fixNowPath = defaultFixNowPath(category, "UNKNOWN_ERROR");

  return buildAppError({
    code: "UNKNOWN_ERROR",
    category,
    message: "Operation failed",
    reason: `The system hit an unexpected error${operation}${route}.`,
    fix: "Retry the action. If this repeats, review logs and dependency health.",
    severity,
    retryable,
    autoRecoverable,
    status,
    ...(fixNowPath ? { fixNowPath } : {}),
    ...(retryable ? { retryAfterMs: 2_000 } : {}),
  });
}

export function isAppError(value: unknown): value is AppError {
  if (!isObject(value)) return false;
  return (
    typeof value.code === "string" &&
    typeof value.category === "string" &&
    KNOWN_CATEGORIES.has(value.category as AppErrorCategory) &&
    typeof value.message === "string" &&
    typeof value.reason === "string" &&
    typeof value.fix === "string" &&
    (value.severity === "low" || value.severity === "medium" || value.severity === "high" || value.severity === "critical") &&
    typeof value.retryable === "boolean" &&
    typeof value.autoRecoverable === "boolean"
  );
}

export function requiresPersistentGuidance(error: AppError): boolean {
  return error.severity === "critical" || (!error.autoRecoverable && !error.retryable);
}
