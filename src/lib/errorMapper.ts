import { apiError, type ApiErrorShape } from "./apiError";
import { redactSensitiveText } from "./redaction";

type ErrorFallback = {
  error: string;
  cause: string;
  fix: string;
};

type ErrorPattern = {
  test: (message: string) => boolean;
  shape: ApiErrorShape;
  retryable: boolean;
};

const patterns: ErrorPattern[] = [
  {
    test: (message) => message.includes("api key") || message.includes("no_api_key") || message.includes("invalid_api_key"),
    shape: apiError(
      "OPENAI_KEY_INVALID",
      "Your OpenAI key is missing, invalid, or expired.",
      "Create a new API key in OpenAI dashboard, copy it fully, save it in OPENAI_API_KEY, then retry.",
    ),
    retryable: false,
  },
  {
    test: (message) => message.includes("quota") || message.includes("rate") || message.includes("429"),
    shape: apiError(
      "OPENAI_RATE_LIMIT",
      "OpenAI rejected this request due to quota or rate limits.",
      "Check billing/usage limits, wait briefly, and retry.",
    ),
    retryable: true,
  },
  {
    test: (message) =>
      message.includes("database_url") || message.includes("password authentication") || message.includes("getaddrinfo") || message.includes("connect"),
    shape: apiError(
      "DATABASE_CONNECTION_FAILED",
      "The app could not connect to your database with current settings.",
      "Verify DATABASE_URL, host/port, credentials, and SSL settings, then retry.",
    ),
    retryable: false,
  },
  {
    test: (message) => message.includes("redirect") || message.includes("invalid_grant") || message.includes("oauth"),
    shape: apiError(
      "OAUTH_CONFIGURATION_INVALID",
      "Google OAuth configuration is incomplete or redirect URLs do not match.",
      "Use the exact callback URL shown in onboarding and verify client ID/secret.",
    ),
    retryable: false,
  },
  {
    test: (message) => message.includes("scope") || message.includes("refresh token") || message.includes("gmail"),
    shape: apiError(
      "GMAIL_PERMISSION_INVALID",
      "Gmail connection is missing required permissions or valid token.",
      "Reconnect Gmail and approve all required Gmail scopes.",
    ),
    retryable: false,
  },
  {
    test: (message) => message.includes("timeout") || message.includes("network") || message.includes("econnreset"),
    shape: apiError(
      "NETWORK_TIMEOUT",
      "A network timeout occurred while validating this step.",
      "Check internet connectivity and retry.",
    ),
    retryable: true,
  },
];

export function mapSystemError(err: unknown, fallback: ErrorFallback): ApiErrorShape & { retryable: boolean } {
  const message = (err instanceof Error ? err.message : String(err ?? "unknown_error")).toLowerCase();
  const matched = patterns.find((pattern) => pattern.test(message));
  if (matched) {
    return {
      ...matched.shape,
      cause: redactSensitiveText(matched.shape.cause),
      fix: redactSensitiveText(matched.shape.fix),
      retryable: matched.retryable,
    };
  }
  return {
    ...apiError(
      fallback.error,
      redactSensitiveText(fallback.cause),
      redactSensitiveText(fallback.fix),
    ),
    retryable: false,
  };
}
