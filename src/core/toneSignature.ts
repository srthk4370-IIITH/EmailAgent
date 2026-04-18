export interface ToneSignature {
  avgSentenceLength: number;
  questionDensity: number;
  exclaimDensity: number;
  formalDensity: number;
}

function sentenceCount(text: string): number {
  return (text.match(/[.!?]+/g) || []).length || 1;
}

export function computeToneSignature(text: string): ToneSignature {
  const clean = (text || "").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const sCount = sentenceCount(clean);
  const qCount = (clean.match(/\?/g) || []).length;
  const eCount = (clean.match(/!/g) || []).length;
  const formalHits = (clean.match(/\b(please|kindly|regards|thank you|appreciate|sincerely)\b/gi) || []).length;

  return {
    avgSentenceLength: words.length / sCount,
    questionDensity: qCount / sCount,
    exclaimDensity: eCount / sCount,
    formalDensity: words.length > 0 ? formalHits / words.length : 0,
  };
}

export function toneSimilarity(a: ToneSignature, b: ToneSignature): number {
  const delta =
    Math.abs(a.avgSentenceLength - b.avgSentenceLength) / Math.max(1, a.avgSentenceLength, b.avgSentenceLength) +
    Math.abs(a.questionDensity - b.questionDensity) +
    Math.abs(a.exclaimDensity - b.exclaimDensity) +
    Math.abs(a.formalDensity - b.formalDensity) * 2;
  return Math.max(0, 1 - delta / 4);
}

export function assessThreadToneConsistency(threadTexts: string[], replyText?: string | null): number {
  const samples = threadTexts.map((t) => computeToneSignature(t)).filter((s) => Number.isFinite(s.avgSentenceLength));
  if (samples.length < 2 || !replyText) return 0.7;

  const baseline = samples.reduce(
    (acc, s) => ({
      avgSentenceLength: acc.avgSentenceLength + s.avgSentenceLength,
      questionDensity: acc.questionDensity + s.questionDensity,
      exclaimDensity: acc.exclaimDensity + s.exclaimDensity,
      formalDensity: acc.formalDensity + s.formalDensity,
    }),
    { avgSentenceLength: 0, questionDensity: 0, exclaimDensity: 0, formalDensity: 0 },
  );

  const n = samples.length;
  const centroid: ToneSignature = {
    avgSentenceLength: baseline.avgSentenceLength / n,
    questionDensity: baseline.questionDensity / n,
    exclaimDensity: baseline.exclaimDensity / n,
    formalDensity: baseline.formalDensity / n,
  };

  const replySig = computeToneSignature(replyText);
  return toneSimilarity(centroid, replySig);
}
