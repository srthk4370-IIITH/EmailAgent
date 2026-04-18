import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { getRuntimeConfigSync } from "./runtimeConfig";

export type OnboardingDraft = {
  openaiKey?: string;
  databaseProvider?: "postgresql" | "supabase" | "firebase";
  databaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  updatedAt?: string;
};

type EncodedPayload = {
  v: 1;
  iv: string;
  tag: string;
  data: string;
};

type StoredDraftEnvelope = {
  draft: OnboardingDraft;
  iat: number;
  exp: number;
};

function getPrimarySecretMaterial() {
  return (
    getRuntimeConfigSync("ONBOARDING_DRAFT_SECRET") ||
    getRuntimeConfigSync("AUTH_SECRET") ||
    getRuntimeConfigSync("MIDDLEWARE_VERIFY_SECRET") ||
    getRuntimeConfigSync("DATABASE_URL") ||
    "local-dev-onboarding-draft-secret"
  );
}

function getSecretCandidates() {
  const primary = getPrimarySecretMaterial();
  const previous = (getRuntimeConfigSync("ONBOARDING_DRAFT_SECRET_PREVIOUS") || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [primary, ...previous];
}

function getKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function getDraftTtlMs() {
  const ttlHours = Number(getRuntimeConfigSync("ONBOARDING_DRAFT_TTL_HOURS") ?? 24);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    return 24 * 60 * 60 * 1000;
  }
  return Math.floor(ttlHours * 60 * 60 * 1000);
}

export function encryptOnboardingDraft(draft: OnboardingDraft): string {
  const now = Date.now();
  const envelope: StoredDraftEnvelope = {
    draft,
    iat: now,
    exp: now + getDraftTtlMs(),
  };

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(getPrimarySecretMaterial()), iv);
  const encoded = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncodedPayload = {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encoded.toString("base64"),
  };

  return JSON.stringify(payload);
}

export function decryptOnboardingDraft(input: string | null | undefined): OnboardingDraft | null {
  if (!input) return null;

  const parsed = (() => {
    try {
      return JSON.parse(input) as EncodedPayload;
    } catch {
      return null;
    }
  })();

  if (!parsed || !parsed.iv || !parsed.tag || !parsed.data) return null;

  for (const secret of getSecretCandidates()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", getKey(secret), Buffer.from(parsed.iv, "base64"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      const decoded = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, "base64")),
        decipher.final(),
      ]).toString("utf8");

      const envelope = JSON.parse(decoded) as StoredDraftEnvelope;
      if (typeof envelope.exp !== "number" || Date.now() > envelope.exp) {
        return null;
      }
      return envelope.draft ?? null;
    } catch {
      // Try next rotated key candidate.
    }
  }

  return null;
}
