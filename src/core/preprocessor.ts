/**
 * Email preprocessing pipeline.
 *
 * Converts raw email bodies into clean, atomic, semantic Knowledge Units
 * suitable for embedding. This is the foundation of the knowledge system.
 */

export interface ProcessedChunk {
  text: string;
  chunk_type: "answer" | "question" | "explanation" | "unknown";
  sender_type: "us" | "them" | "unknown";
}

// ── Reply separator patterns ──────────────────────────────────────────
const REPLY_SEPARATORS = [
  /^On .+wrote:\s*$/im,                        // Gmail / Outlook threaded
  /^From: .+$/im,                               // Outlook chain
  /^-----\s*Original Message\s*-----/im,        // Outlook classic
  /^-{2,}\s*Forwarded message\s*-{2,}/im,       // Forwarded chains
  /^_{10,}/m,                                    // Line-based separators
  /^Begin forwarded message:/im,                 // Apple Mail
];

// ── Signature patterns ────────────────────────────────────────────────
const SIGNATURE_START_PATTERNS = [
  /^-- $/m,                                      // RFC 3676 (exactly "-- ")
  /^--$/m,                                       // Common variant
  /^(Regards|Best regards|Kind regards|Warm regards),?\s*$/im,
  /^(Best|Thanks|Thank you|Cheers|Sincerely|Yours truly),?\s*$/im,
  /^Sent from my /im,                           // All mobile signatures
  /^Sent from /im,                              // Webmail signatures
  /^Get Outlook for /im,                        // Outlook mobile
  /^Disclaimer:/im,                             // Legal disclaimers
  /^CONFIDENTIALITY NOTICE/im,                  // Corporate footers
  /^This email and any attachments/im,          // Legal footer
  /^This message is intended /im,               // Legal footer variant
];

// ── Quoted line patterns ──────────────────────────────────────────────
function isQuotedLine(line: string): boolean {
  const l = line.trim();
  return l.startsWith(">") || l.startsWith("|");
}

function isNoiseOnlyLine(line: string): boolean {
  const l = line.trim().toLowerCase();
  if (l.length === 0) return false; // blank lines are structural, not noise
  if (/^-{3,}$/.test(l) || /^={3,}$/.test(l) || /^\*{3,}$/.test(l)) return true;
  return false;
}

/**
 * Extract ONLY the latest reply from a threaded email body.
 *
 * Strips:
 * - Quoted replies (On ... wrote:, From:, -----Original Message-----)
 * - Forwarded chains
 * - Signatures (RFC 3676 "--", Regards, Sent from, disclaimers)
 * - Quoted ">" lines
 * - Noise artifacts
 */
export function extractLatestReply(body: string): string {
  if (!body) return "";
  let text = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Step 1: HARD CUT at the FIRST reply separator (Gmail / Outlook / Apple Mail)
  // We identify the earliest occurrence of any separator to ensure zero thread leakage.
  let earliestMatchIndex = -1;
  let separatorLength = 0;

  for (const pattern of REPLY_SEPARATORS) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      if (earliestMatchIndex === -1 || match.index < earliestMatchIndex) {
        earliestMatchIndex = match.index;
        separatorLength = match[0].length;
      }
    }
  }

  if (earliestMatchIndex !== -1) {
    text = text.slice(0, earliestMatchIndex);
  }

  // Step 2: Remove signature block
  const lines = text.split("\n");
  const resultLines: string[] = [];
  for (const line of lines) {
    // Check if this line starts a signature
    const isSignatureStart = SIGNATURE_START_PATTERNS.some((p) => p.test(line));
    if (isSignatureStart) break;

    // Skip quoted lines
    if (isQuotedLine(line)) continue;

    // Skip noise-only lines
    if (isNoiseOnlyLine(line)) continue;

    resultLines.push(line);
  }

  // Step 3: Trim trailing whitespace and empty lines
  while (resultLines.length > 0 && resultLines[resultLines.length - 1]!.trim() === "") {
    resultLines.pop();
  }

  return resultLines.join("\n").trim();
}

/**
 * Extract the quoted question from the other party.
 *
 * Looks for the content AFTER the first "On ... wrote:" or similar separator,
 * strips ">" prefixes, and returns only the most recent quoted layer.
 * Returns null if no meaningful question is found.
 */
export function extractQuotedQuestion(body: string): string | null {
  if (!body) return null;

  // Find the first reply separator
  let splitIndex = -1;
  for (const pattern of REPLY_SEPARATORS) {
    const match = body.match(pattern);
    if (match && match.index !== undefined) {
      if (splitIndex === -1 || match.index < splitIndex) {
        splitIndex = match.index + match[0].length;
      }
    }
  }

  if (splitIndex === -1) return null;

  let questionPart = body.slice(splitIndex);

  // Cut at the NEXT reply separator (only take the most recent question)
  for (const pattern of REPLY_SEPARATORS) {
    const match = questionPart.match(pattern);
    if (match && match.index !== undefined && match.index > 0) {
      questionPart = questionPart.slice(0, match.index);
    }
  }

  // Strip ">" prefixes and clean
  const lines = questionPart.split("\n");
  const extracted: string[] = [];
  for (const line of lines) {
    let l = line.trim();
    // Remove leading ">" markers
    l = l.replace(/^>+\s*/, "").trim();
    if (l.length === 0) continue;

    // Stop at signatures inside the quoted block
    const isSignatureStart = SIGNATURE_START_PATTERNS.some((p) => p.test(l));
    if (isSignatureStart) break;

    extracted.push(l);
  }

  const result = extracted.join("\n").trim();
  // Only return if there's meaningful content (not just a greeting)
  if (result.length < 15) return null;
  return result;
}

/**
 * Semantic chunking: split text into coherent knowledge units.
 *
 * Rules:
 * - Split by paragraph boundaries (double newline)
 * - Merge short paragraphs (<100 chars) with their neighbor
 * - Split long paragraphs (>1000 chars) at sentence boundaries
 * - Each chunk = 50-800 chars ideally (one semantic idea)
 * - Filter out greeting-only chunks
 */
export function semanticChunk(text: string): string[] {
  if (!text || text.trim().length < 20) return [];

  // Split into paragraphs
  const rawParagraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Filter out greeting-only paragraphs
  const paragraphs = rawParagraphs.filter((p) => {
    const lower = p.toLowerCase();
    if (p.length < 50 && /^(hi|hello|dear|hey|good\s+(morning|afternoon|evening))[\s,!.]/i.test(lower)) {
      return false;
    }
    return true;
  });

  if (paragraphs.length === 0) return [];

  // Phase 1: Split large paragraphs at sentence boundaries
  const splitParagraphs: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= 1000) {
      splitParagraphs.push(p);
    } else {
      // Split at sentence boundaries
      const sentences = p.match(/[^.!?]+[.!?]+\s*/g) || [p];
      let current = "";
      for (const s of sentences) {
        if (current.length + s.length > 800 && current.length > 50) {
          splitParagraphs.push(current.trim());
          current = s;
        } else {
          current += s;
        }
      }
      if (current.trim().length > 0) {
        splitParagraphs.push(current.trim());
      }
    }
  }

  // Phase 2: Merge short paragraphs with neighbors
  const chunks: string[] = [];
  let currentChunk = "";

  for (const p of splitParagraphs) {
    if (currentChunk.length === 0) {
      currentChunk = p;
      continue;
    }

    // If adding this paragraph would exceed target, flush
    if (currentChunk.length + p.length > 800 && currentChunk.length >= 50) {
      chunks.push(currentChunk.trim());
      currentChunk = p;
    } else {
      // Merge with current chunk
      currentChunk += "\n\n" + p;
    }
  }

  // Flush remaining
  if (currentChunk.trim().length >= 20) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
