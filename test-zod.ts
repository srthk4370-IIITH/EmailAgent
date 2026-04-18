import { z } from "zod";

const emailSchema = z.string().email();

const testCases = [
  "test@example.com",
  "Name <test@example.com>",
  "<test@example.com>",
  "Name test@example.com"
];

testCases.forEach(email => {
  const result = emailSchema.safeParse(email);
  let message = "";
  if (!result.success) {
    message = ` (${result.error.issues[0]?.message ?? "Invalid format"})`;
  }
  console.log(`Email: "${email}" -> Valid: ${result.success}${message}`);
});
