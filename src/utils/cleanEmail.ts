export function cleanEmailBody(text?: string): string {
  let cleaned = text ?? "";

  // Stop at common reply separators
  cleaned = cleaned.split(/On .* wrote:/i)[0] ?? "";
  cleaned = cleaned.split(/From: .*$/im)[0] ?? "";
  cleaned = cleaned.split(/-----Original Message-----/i)[0] ?? "";

  // Remove quoted lines
  cleaned = cleaned
    .split("\n")
    .filter(line => {
      const l = line.trim();
      return (
        !l.startsWith(">") &&
        !l.startsWith("|") &&
        !l.match(/^On .* wrote:/i)
      );
    })
    .join("\n");

  return cleaned.trim();
}