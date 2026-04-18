import type { VoiceStyleFeatures } from "./voiceCloner";

export interface StyleSignature {
  tone_baseline: number;
  sentence_style: number;
  vocabulary_bias: number;
  aggression_baseline: number;
  sample_count: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function signatureFromFeatures(features: VoiceStyleFeatures): StyleSignature {
  return {
    tone_baseline: clamp01((features.directness_level + features.punctuation_density * 3) / 2),
    sentence_style: clamp01(features.avg_length / 32),
    vocabulary_bias: clamp01(features.slang_usage),
    aggression_baseline: clamp01(features.aggression_level),
    sample_count: 1,
  };
}

export function mergeStyleSignature(
  existing: StyleSignature | null,
  latest: VoiceStyleFeatures,
): StyleSignature {
  const incoming = signatureFromFeatures(latest);
  if (!existing) return incoming;

  const n = Math.max(1, existing.sample_count);
  const alpha = 1 / Math.min(24, n + 1);

  return {
    tone_baseline: clamp01(existing.tone_baseline * (1 - alpha) + incoming.tone_baseline * alpha),
    sentence_style: clamp01(existing.sentence_style * (1 - alpha) + incoming.sentence_style * alpha),
    vocabulary_bias: clamp01(existing.vocabulary_bias * (1 - alpha) + incoming.vocabulary_bias * alpha),
    aggression_baseline: clamp01(existing.aggression_baseline * (1 - alpha) + incoming.aggression_baseline * alpha),
    sample_count: n + 1,
  };
}

export function lockToSignature(
  dynamic: VoiceStyleFeatures,
  signature: StyleSignature | null,
): VoiceStyleFeatures {
  if (!signature) return dynamic;

  return {
    avg_length: Number(((dynamic.avg_length * 0.35) + (signature.sentence_style * 32 * 0.65)).toFixed(2)),
    punctuation_density: Number(((dynamic.punctuation_density * 0.4) + (signature.tone_baseline / 3) * 0.6).toFixed(4)),
    aggression_level: Number(clamp01(dynamic.aggression_level * 0.35 + signature.aggression_baseline * 0.65).toFixed(4)),
    slang_usage: Number(clamp01(dynamic.slang_usage * 0.35 + signature.vocabulary_bias * 0.65).toFixed(4)),
    directness_level: Number(clamp01(dynamic.directness_level * 0.35 + signature.tone_baseline * 0.65).toFixed(4)),
  };
}

export function styleConfidenceFromSignature(
  actual: VoiceStyleFeatures,
  signature: StyleSignature | null,
): number {
  if (!signature) return 0.6;

  const d1 = Math.abs(actual.directness_level - signature.tone_baseline);
  const d2 = Math.abs(actual.aggression_level - signature.aggression_baseline);
  const d3 = Math.abs(actual.slang_usage - signature.vocabulary_bias);
  const d4 = Math.abs(actual.avg_length / 32 - signature.sentence_style);

  return clamp01(1 - (d1 * 0.35 + d2 * 0.3 + d3 * 0.2 + d4 * 0.15));
}
