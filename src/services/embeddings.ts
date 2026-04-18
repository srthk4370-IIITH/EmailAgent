import OpenAI from "openai";
import { trackTokenUsage } from "../core/costControl";
import { getRuntimeConfigSync } from "../lib/runtimeConfig";
import { withQueryEmbeddingCache } from "../lib/runtimeCache";

function getClient(): OpenAI {
  const apiKey = getRuntimeConfigSync("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }
  return new OpenAI({ apiKey });
}

export async function createEmbedding(text: string): Promise<number[]> {
  const client = getClient();
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  const inputTokens = response.usage?.prompt_tokens ?? Math.max(1, Math.ceil(text.length / 4));
  try {
    await trackTokenUsage(inputTokens, 0);
  } catch {
    // Cost telemetry should never block embedding generation.
  }
  return response.data[0]?.embedding ?? [];
}

export async function createQueryEmbedding(text: string): Promise<number[]> {
  return withQueryEmbeddingCache(text, async () => createEmbedding(text));
}
