import crypto from "crypto";
import { db } from "../db/client";

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const MAX_CACHE_ENTRIES = 500;
const QUERY_EMBEDDING_TTL_MS = 30 * 60 * 1000;
const RETRIEVAL_TTL_MS = 3 * 60 * 1000;
const LLM_RESPONSE_TTL_MS = 10 * 60 * 1000;

const queryEmbeddingCache = new Map<string, CacheEntry<number[]>>();
const retrievalCache = new Map<string, CacheEntry<unknown>>();
const llmResponseCache = new Map<string, CacheEntry<unknown>>();

// TIER 3 CACHE: Stampede Protection (Promise Locking)
const activeLoads = new Map<string, Promise<any>>();

function hashKey(parts: Array<string | number>): string {
  return crypto.createHash("sha1").update(parts.join("::")).digest("hex");
}

function pruneCache<T>(store: Map<string, CacheEntry<T>>): void {
  const now = Date.now();

  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }

  if (store.size <= MAX_CACHE_ENTRIES) return;

  const overflow = store.size - MAX_CACHE_ENTRIES;
  const oldestKeys = Array.from(store.entries())
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, overflow)
    .map(([key]) => key);

  for (const key of oldestKeys) {
    store.delete(key);
  }
}

async function withCache<T>(
  store: Map<string, CacheEntry<T>>,
  keyParts: Array<string | number>,
  ttlMs: number,
  loader: () => Promise<T>,
  namespace = "default",
): Promise<T> {
  const key = hashKey([namespace, ...keyParts]);
  const now = Date.now();
  
  // 1. Memory Hit
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  // 2. Persistent Hit (DB)
  try {
    const dbHit = await db.query<{ value: T; expires_at: string }>(
      "SELECT value, expires_at FROM system_cache WHERE namespace = $1 AND key = $2",
      [namespace, key]
    );
    if (dbHit.rows[0] && new Date(dbHit.rows[0].expires_at).getTime() > now) {
      const val = dbHit.rows[0].value;
      store.set(key, { value: val, expiresAt: new Date(dbHit.rows[0].expires_at).getTime() });
      return val;
    }
  } catch (err) {
    console.error(`[CACHE] DB read error in namespace ${namespace}:`, err);
  }

  // 3. Stampede Protection (Promise Locking)
  const existingLoad = activeLoads.get(key);
  if (existingLoad) return existingLoad as Promise<T>;

  const loadPromise = (async () => {
    try {
      const value = await loader();
      const expiresAt = now + ttlMs;
      
      // Update memory
      store.set(key, { value, expiresAt });
      pruneCache(store);
      
      // Update DB
      try {
        await db.query(
          `INSERT INTO system_cache (namespace, key, value, expires_at) 
           VALUES ($1, $2, $3, $4) 
           ON CONFLICT (namespace, key) DO UPDATE SET value = $3, expires_at = $4`,
          [namespace, key, JSON.stringify(value), new Date(expiresAt)]
        );
      } catch (dbErr) {
         // Silently fail DB write; we have memory cache
      }
      return value;
    } finally {
      activeLoads.delete(key);
    }
  })();

  activeLoads.set(key, loadPromise);
  return loadPromise;
}

export async function withQueryEmbeddingCache(
  text: string,
  loader: () => Promise<number[]>,
): Promise<number[]> {
  return withCache(queryEmbeddingCache, [text], QUERY_EMBEDDING_TTL_MS, loader, "embeddings");
}

export async function withRetrievalCache<T>(
  keyParts: Array<string | number>,
  datasetVersion: number,
  loader: () => Promise<T>,
): Promise<T> {
  return withCache(
    retrievalCache as Map<string, CacheEntry<T>>,
    [datasetVersion, ...keyParts],
    RETRIEVAL_TTL_MS,
    loader,
    "retrieval"
  );
}

export async function withLlmResponseCache<T>(
  keyParts: Array<string | number>,
  loader: () => Promise<T>,
): Promise<T> {
  return withCache(
    llmResponseCache as Map<string, CacheEntry<T>>,
    keyParts,
    LLM_RESPONSE_TTL_MS,
    loader,
    "llm-responses"
  );
}
