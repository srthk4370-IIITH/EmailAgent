declare const EdgeRuntime: string | undefined;

const EMERGENCY_AUTH_SECRET = "emailagent-emergency-auth-secret-v1";

function normalizeSecret(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readEnvAuthSecret(): string | null {
  return normalizeSecret(process.env.AUTH_SECRET ?? process.env.MIDDLEWARE_VERIFY_SECRET ?? null);
}

function syncProcessAuthSecret(secret: string): void {
  process.env.AUTH_SECRET = secret;
  process.env.MIDDLEWARE_VERIFY_SECRET = secret;
}

async function deriveBootstrapSecret(seed: string): Promise<string> {
  const encoded = new TextEncoder().encode(`emailagent-auth:${seed}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function createRandomSecret(): Promise<string> {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function bootstrapRuntimeAuthSecret(): Promise<string | null> {
  if (typeof EdgeRuntime !== "undefined") {
    return null;
  }

  const runtimeConfig = await import("./runtimeConfig");
  const draftSecret = normalizeSecret(await runtimeConfig.getRuntimeConfig("ONBOARDING_DRAFT_SECRET"));
  const dbSeed = normalizeSecret(await runtimeConfig.getRuntimeConfig("DATABASE_URL"));
  const seed = draftSecret ?? dbSeed;

  const nextSecret = seed ? await deriveBootstrapSecret(seed) : await createRandomSecret();
  await runtimeConfig.setRuntimeConfig("AUTH_SECRET", nextSecret);
  return normalizeSecret(nextSecret);
}

async function readRuntimeAuthSecret(): Promise<string | null> {
  if (typeof EdgeRuntime !== "undefined") {
    return null;
  }

  const runtimeConfig = await import("./runtimeConfig");
  const authSecret = normalizeSecret(await runtimeConfig.getRuntimeConfig("AUTH_SECRET"));
  if (authSecret) return authSecret;

  // Backward compatibility for existing installs that still store this key.
  const legacySecret = normalizeSecret(await runtimeConfig.getRuntimeConfig("MIDDLEWARE_VERIFY_SECRET"));
  if (legacySecret) {
    await runtimeConfig.setRuntimeConfig("AUTH_SECRET", legacySecret);
    return legacySecret;
  }

  return bootstrapRuntimeAuthSecret();
}

export async function getAuthSecret(): Promise<string | null> {
  const envSecret = readEnvAuthSecret();
  if (envSecret) return envSecret;

  let runtimeSecret: string | null = null;
  try {
    runtimeSecret = await readRuntimeAuthSecret();
  } catch {
    runtimeSecret = null;
  }

  if (!runtimeSecret) {
    // Keep middleware/session verification operational even when runtime config
    // storage is unavailable (for example in edge-like middleware contexts).
    syncProcessAuthSecret(EMERGENCY_AUTH_SECRET);
    return EMERGENCY_AUTH_SECRET;
  }

  // Keep process env aligned for middleware/session checks in the same runtime process.
  syncProcessAuthSecret(runtimeSecret);
  return runtimeSecret;
}
