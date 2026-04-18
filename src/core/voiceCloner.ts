import { db } from "../db/client";
import { searchNearestEmbeddings } from "../db/embeddings";
import type { EmailRecord } from "../db/emails";
import { cleanEmailBody } from "../utils/cleanEmail";
import { createQueryEmbedding } from "../services/embeddings";
import { assessThreadToneConsistency, computeToneSignature } from "./toneSignature";
import { getUserStyleSignature } from "../db/auth";
import { lockToSignature, type StyleSignature } from "./styleSignature";

export type VoiceStyleFeatures = {
  avg_length: number;
  punctuation_density: number;
  aggression_level: number;
  slang_usage: number;
  directness_level: number;
};

export type StyleReference = {
  emailId: number;
  threadId: string;
  subject: string;
  body: string;
  distance: number;
  features: VoiceStyleFeatures;
};

export type ThreadToneProfile = {
  tone: string;
  intensity: string;
  verbosity: string;
  punctuation_style: string;
  slang_usage: string;
  consistency: number;
  features: VoiceStyleFeatures;
};

const SLANG_PATTERNS = /\b(gonna|wanna|kinda|sorta|btw|lmk|tbh|lol|idk|thx|pls|ok|okay|yeah|yep|nah|cool|fine|sure|np|fyi)\b/gi;
const DIRECTNESS_PATTERNS = /\b(need|need to|please|send|confirm|do this|fix|update|ship|review|reply|call|finish|share|send me)\b/gi;
const AGGRESSION_PATTERNS = /\b(unacceptable|ridiculous|frustrated|annoyed|angry|stop|not acceptable|no more|don't|do not|won't|can't|never)\b/gi;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function blendFeatureTargets(input: {
  references: StyleReference[];
  currentEmailText: string;
  threadTone: ThreadToneProfile;
}): VoiceStyleFeatures {
  const current = extractVoiceStyleFeatures(input.currentEmailText);
  if (input.references.length === 0) {
    return {
      avg_length: Number(((current.avg_length * 0.6) + (input.threadTone.features.avg_length * 0.4)).toFixed(2)),
      punctuation_density: Number(((current.punctuation_density * 0.55) + (input.threadTone.features.punctuation_density * 0.45)).toFixed(4)),
      aggression_level: Number(clamp((current.aggression_level * 0.5) + (input.threadTone.features.aggression_level * 0.5)).toFixed(4)),
      slang_usage: Number(clamp((current.slang_usage * 0.55) + (input.threadTone.features.slang_usage * 0.45)).toFixed(4)),
      directness_level: Number(clamp((current.directness_level * 0.5) + (input.threadTone.features.directness_level * 0.5)).toFixed(4)),
    };
  }

  const weighted = input.references.reduce(
    (acc, ref) => {
      const weight = Math.max(0.15, 1 - Math.min(1, ref.distance));
      acc.weight += weight;
      acc.avg_length += ref.features.avg_length * weight;
      acc.punctuation_density += ref.features.punctuation_density * weight;
      acc.aggression_level += ref.features.aggression_level * weight;
      acc.slang_usage += ref.features.slang_usage * weight;
      acc.directness_level += ref.features.directness_level * weight;
      return acc;
    },
    {
      weight: 0,
      avg_length: 0,
      punctuation_density: 0,
      aggression_level: 0,
      slang_usage: 0,
      directness_level: 0,
    },
  );

  const referenceTarget: VoiceStyleFeatures = {
    avg_length: Number((weighted.avg_length / Math.max(0.01, weighted.weight)).toFixed(2)),
    punctuation_density: Number((weighted.punctuation_density / Math.max(0.01, weighted.weight)).toFixed(4)),
    aggression_level: Number(clamp(weighted.aggression_level / Math.max(0.01, weighted.weight)).toFixed(4)),
    slang_usage: Number(clamp(weighted.slang_usage / Math.max(0.01, weighted.weight)).toFixed(4)),
    directness_level: Number(clamp(weighted.directness_level / Math.max(0.01, weighted.weight)).toFixed(4)),
  };

  // Blend to avoid overfitting to a single past conversation style.
  return {
    avg_length: Number((referenceTarget.avg_length * 0.55 + current.avg_length * 0.2 + input.threadTone.features.avg_length * 0.25).toFixed(2)),
    punctuation_density: Number((referenceTarget.punctuation_density * 0.55 + current.punctuation_density * 0.2 + input.threadTone.features.punctuation_density * 0.25).toFixed(4)),
    aggression_level: Number(clamp(referenceTarget.aggression_level * 0.5 + current.aggression_level * 0.2 + input.threadTone.features.aggression_level * 0.3).toFixed(4)),
    slang_usage: Number(clamp(referenceTarget.slang_usage * 0.55 + current.slang_usage * 0.15 + input.threadTone.features.slang_usage * 0.3).toFixed(4)),
    directness_level: Number(clamp(referenceTarget.directness_level * 0.55 + current.directness_level * 0.2 + input.threadTone.features.directness_level * 0.25).toFixed(4)),
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countSentences(text: string): number {
  return Math.max(1, (text.match(/[.!?]+/g) || []).length);
}

function countPunctuation(text: string): number {
  return (text.match(/[!?.,;:]/g) || []).length;
}

export function extractVoiceStyleFeatures(text: string): VoiceStyleFeatures {
  const clean = cleanEmailBody(text).trim();
  if (!clean) {
    return {
      avg_length: 0,
      punctuation_density: 0,
      aggression_level: 0,
      slang_usage: 0,
      directness_level: 0,
    };
  }

  const words = countWords(clean);
  const sentences = countSentences(clean);
  const punctuation = countPunctuation(clean);
  const avgLength = words / sentences;
  const punctuationDensity = punctuation / Math.max(1, words);

  const slangHits = clean.match(SLANG_PATTERNS)?.length ?? 0;
  const directnessHits = clean.match(DIRECTNESS_PATTERNS)?.length ?? 0;
  const aggressionHits = clean.match(AGGRESSION_PATTERNS)?.length ?? 0;
  const exclaimBonus = (clean.match(/!/g) || []).length * 0.12;
  const allCapsBonus = (clean.match(/\b[A-Z]{3,}\b/g) || []).length * 0.08;
  const shortSentenceRatio = clean
    .split(/[.!?]+/)
    .filter(Boolean)
    .filter((sentence) => countWords(sentence) <= 8).length / sentences;

  return {
    avg_length: Number(avgLength.toFixed(2)),
    punctuation_density: Number(punctuationDensity.toFixed(4)),
    aggression_level: Number(clamp((aggressionHits * 0.16) + exclaimBonus + allCapsBonus).toFixed(4)),
    slang_usage: Number(clamp((slangHits / Math.max(4, words / 8)) * 0.9).toFixed(4)),
    directness_level: Number(clamp((directnessHits * 0.14) + shortSentenceRatio * 0.45).toFixed(4)),
  };
}

export function summarizeVoiceStyle(features: VoiceStyleFeatures): {
  tone: string;
  intensity: string;
  verbosity: string;
  punctuation_style: string;
  slang_usage: string;
} {
  const tone =
    features.aggression_level >= 0.55
      ? "aggressive"
      : features.directness_level >= 0.65
        ? "direct"
        : features.slang_usage >= 0.25
          ? "casual"
          : features.avg_length >= 24
            ? "considered"
            : "calm";

  const intensity =
    features.aggression_level >= 0.6
      ? "high"
      : features.directness_level >= 0.7
        ? "medium-high"
        : features.punctuation_density >= 0.08
          ? "medium"
          : "low";

  const verbosity =
    features.avg_length <= 10
      ? "short"
      : features.avg_length <= 18
        ? "moderate"
        : features.avg_length <= 28
          ? "detailed"
          : "verbose";

  const punctuation_style =
    features.punctuation_density >= 0.09
      ? "dense"
      : features.punctuation_density >= 0.04
        ? "balanced"
        : "minimal";

  const slang_usage =
    features.slang_usage >= 0.4
      ? "high"
      : features.slang_usage >= 0.15
        ? "some"
        : "none";

  return { tone, intensity, verbosity, punctuation_style, slang_usage };
}

export function compareVoiceStyle(actual: VoiceStyleFeatures, target: VoiceStyleFeatures): { score: number; notes: string[] } {
  const notes: string[] = [];
  const lengthDelta = Math.abs(actual.avg_length - target.avg_length) / Math.max(1, target.avg_length);
  const punctuationDelta = Math.abs(actual.punctuation_density - target.punctuation_density);
  const aggressionDelta = Math.abs(actual.aggression_level - target.aggression_level);
  const slangDelta = Math.abs(actual.slang_usage - target.slang_usage);
  const directnessDelta = Math.abs(actual.directness_level - target.directness_level);

  if (lengthDelta > 0.45) notes.push("sentence length drifted");
  if (punctuationDelta > 0.05) notes.push("punctuation style drifted");
  if (aggressionDelta > 0.2) notes.push("emotional intensity drifted");
  if (slangDelta > 0.2) notes.push("slang usage drifted");
  if (directnessDelta > 0.2) notes.push("directness drifted");

  const score = clamp(1 - ((lengthDelta * 0.25) + (punctuationDelta * 3) + (aggressionDelta * 0.22) + (slangDelta * 0.18) + (directnessDelta * 0.22)), 0, 1);
  return { score, notes };
}

export function summarizeThreadTone(threadTexts: string[]): ThreadToneProfile {
  const validTexts = threadTexts.map((text) => cleanEmailBody(text)).filter(Boolean);
  if (validTexts.length === 0) {
    const empty = extractVoiceStyleFeatures("");
    return {
      tone: "calm",
      intensity: "low",
      verbosity: "short",
      punctuation_style: "minimal",
      slang_usage: "none",
      consistency: 0.7,
      features: empty,
    };
  }

  const signatures = validTexts.map((text) => computeToneSignature(text));
  const total = signatures.reduce(
    (acc, current) => ({
      avgSentenceLength: acc.avgSentenceLength + current.avgSentenceLength,
      questionDensity: acc.questionDensity + current.questionDensity,
      exclaimDensity: acc.exclaimDensity + current.exclaimDensity,
      formalDensity: acc.formalDensity + current.formalDensity,
    }),
    { avgSentenceLength: 0, questionDensity: 0, exclaimDensity: 0, formalDensity: 0 },
  );

  const count = signatures.length;
  const avgLength = total.avgSentenceLength / count;
  const punctuationDensity = (total.questionDensity + total.exclaimDensity) / count;
  const features: VoiceStyleFeatures = {
    avg_length: Number(avgLength.toFixed(2)),
    punctuation_density: Number(punctuationDensity.toFixed(4)),
    aggression_level: Number(clamp(total.exclaimDensity / Math.max(1, count) * 2).toFixed(4)),
    slang_usage: Number(clamp(validTexts.join(" ").match(SLANG_PATTERNS)?.length ? 0.3 : 0).toFixed(4)),
    directness_level: Number(clamp((avgLength <= 12 ? 0.7 : 0.3) + (total.questionDensity / Math.max(1, count)) * 0.25).toFixed(4)),
  };

  const style = summarizeVoiceStyle(features);
  const consistency = assessThreadToneConsistency(validTexts, validTexts[validTexts.length - 1] ?? null);

  return {
    ...style,
    consistency,
    features,
  };
}

async function loadSentStyleEmails(emailIds: number[], accountId?: number | null): Promise<Array<{ id: number; thread_id: string; subject: string; body: string }>> {
  if (emailIds.length === 0) return [];
  const params: Array<number | number[]> = [emailIds];
  let sql = `
    SELECT id, thread_id, subject, body
    FROM emails
    WHERE id = ANY($1::int[])
      AND source = 'sent'
      AND COALESCE(parsed_content->>'app_generated', 'false') <> 'true'
  `;
  if (accountId != null) {
    params.push(accountId);
    sql += ` AND account_id = $2`;
  }
  const result = await db.query<{ id: number; thread_id: string; subject: string; body: string }>(sql, params as unknown[]);
  return result.rows;
}

export async function selectVoiceStyleReferences(input: {
  email: EmailRecord;
  accountId?: number | null;
  userId?: number | null;
  limit?: number;
}): Promise<{ references: StyleReference[]; target: VoiceStyleFeatures | null; threadTone: ThreadToneProfile | null }> {
  const subject = input.email.subject || "";
  const body = cleanEmailBody(input.email.body || "");
  if (!subject && !body) {
    return { references: [], target: null, threadTone: null };
  }

  const embedding = await createQueryEmbedding(`${subject}\n${body}`.trim());
  if (embedding.length !== 1536) {
    return { references: [], target: null, threadTone: null };
  }

  const raw = await searchNearestEmbeddings(embedding, Math.max(8, input.limit ?? 3) * 3, {
    chunkTypes: ["answer", "explanation"],
    maxDistance: 0.7,
    accountId: input.accountId ?? undefined,
  });

  const uniqueEmailIds: number[] = [];
  const seenThreads = new Set<string>();
  for (const row of raw) {
    if (!row.subject || !row.chunk_text) continue;
    const threadKey = row.thread_id ? `${row.thread_id}` : `email-${row.email_id}`;
    if (seenThreads.has(threadKey)) continue;
    seenThreads.add(threadKey);
    uniqueEmailIds.push(row.email_id);
    if (uniqueEmailIds.length >= Math.max(6, input.limit ?? 3) * 2) break;
  }

  const sentEmails = await loadSentStyleEmails(uniqueEmailIds, input.accountId ?? null);
  const emailById = new Map(sentEmails.map((row) => [row.id, row]));

  const references: StyleReference[] = [];
  const chosenThreads = new Set<string>();
  for (const row of raw) {
    if (references.length >= (input.limit ?? 3)) break;
    const email = emailById.get(row.email_id);
    if (!email) continue;
    if (chosenThreads.has(email.thread_id)) continue;

    const cleanedBody = cleanEmailBody(email.body);
    if (cleanedBody.length < 40) continue;

    references.push({
      emailId: email.id,
      threadId: email.thread_id,
      subject: email.subject,
      body: cleanedBody.slice(0, 1200),
      distance: row.distance,
      features: extractVoiceStyleFeatures(cleanedBody),
    });
    chosenThreads.add(email.thread_id);
  }

  const threadTone = summarizeThreadTone([input.email.body]);
  const dynamicTarget = blendFeatureTargets({
    references,
    currentEmailText: input.email.body,
    threadTone,
  });
  const signatureRaw = input.userId ? await getUserStyleSignature(input.userId) : null;
  const signature = (signatureRaw as StyleSignature | null) ?? null;
  const target = lockToSignature(dynamicTarget, signature);

  return { references, target, threadTone };
}
