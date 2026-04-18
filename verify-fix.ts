import { z } from "zod";

function extractEmailAddress(input: string): string {
  const match = input.match(/<([^>]+)>/);
  const addr = match && match[1] ? match[1] : input;
  return addr.trim();
}

const schema = z.object({
  to: z.string().email(),
});

const testCases = [
  "test@example.com",
  "John Doe <john@example.com>",
  "<jane@example.com>",
  "  space@example.com  "
];

console.log("Verifying Email Extraction + Zod Validation:");
testCases.forEach(input => {
  const extracted = extractEmailAddress(input);
  const result = schema.safeParse({ to: extracted });
  console.log(`Original: "${input}" -> Extracted: "${extracted}" -> Zod Valid: ${result.success}`);
});
