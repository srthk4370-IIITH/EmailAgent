const MAX_STORED_LEN = 500_000;

/** Strip risky markup and control chars before persisting email fields (plain-text safe storage). */
export function sanitizeStoredEmailText(input: string): string {
  let s = input.slice(0, MAX_STORED_LEN);
  s = s.replace(/\0/g, "");
  s = s.replace(/<\/(script|iframe|object|embed)\b[^>]*>/gi, "");
  s = s.replace(/<(script|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, " ");
  // Remove HTML-like tags, but preserve email addresses commonly written as: `Name <addr@example.com>`.
  // We keep any `<...>` chunk that contains an `@`.
  s = s.replace(/<(?![^>]*@)[^>]{0,800}>/g, " ");
  s = s.replace(/javascript:/gi, "");
  s = s.replace(/on\w+\s*=/gi, "");
  return s.trim();
}

/** Extract a pure email address from a string that may contain a name (e.g., "John Doe <john@example.com>"). */
export function extractEmailAddress(input: string): string {
  const match = input.match(/<([^>]+)>/);
  const addr = match && match[1] ? match[1] : input;
  return addr.trim();
}
