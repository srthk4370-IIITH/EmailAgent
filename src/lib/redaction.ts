export function redactSensitiveText(input: string): string {
  let value = input;

  // OpenAI keys and similar token-like secrets.
  value = value.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-***redacted***");

  // Gmail OAuth secret-like values in key=value snippets.
  value = value.replace(/(client_secret\s*[=:]\s*)([^\s,;]+)/gi, "$1***redacted***");
  value = value.replace(/(openai_api_key\s*[=:]\s*)([^\s,;]+)/gi, "$1***redacted***");

  // Password part in postgres-like URLs.
  value = value.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)([^@\s]+)(@)/gi, "$1***redacted***$3");

  return value;
}

export function maskSecretPreview(input: string): string {
  if (!input) return "";
  if (input.length <= 8) return "********";
  return `${input.slice(0, 3)}***${input.slice(-2)}`;
}
