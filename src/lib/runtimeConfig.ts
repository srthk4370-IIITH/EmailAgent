import fs from "fs";
import os from "os";
import path from "path";

import dotenv from "dotenv";

import { keychainStore } from "./keychainStore";

dotenv.config({ path: ".env.local" });
dotenv.config();

export type RuntimeConfigKey =
  | "DATABASE_URL"
  | "OPENAI_API_KEY"
  | "GMAIL_CLIENT_ID"
  | "GMAIL_CLIENT_SECRET"
  | "GMAIL_REDIRECT_URI"
  | "GMAIL_REFRESH_TOKEN"
  | "TOKEN_BUDGET_AUTO_EXPAND_ENABLED"
  | "TOKEN_BUDGET_MAX_DAILY_LIMIT"
  | "TOKEN_BUDGET_EXPAND_STEP"
  | "TOKEN_BUDGET_EXPAND_THRESHOLD_PERCENT"
  | "SESSION_COOKIE_SECURE"
  | "MIDDLEWARE_VERIFY_SECRET"
  | "ONBOARDING_DRAFT_SECRET"
  | "ONBOARDING_DRAFT_SECRET_PREVIOUS"
  | "ONBOARDING_DRAFT_TTL_HOURS"
  | "RAG_HYBRID_ENABLED"
  | "STRICT_ERROR_ENVELOPE_ENABLED"
  | "MULTI_ACCOUNT_ENABLED"
  | "DEBUG_RAG_RANKING"
  | "NODE_ENV";

type RuntimeConfigMap = Partial<Record<RuntimeConfigKey, string>>;

const LEGACY_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

const SECRET_KEYS = new Set<RuntimeConfigKey>([
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REDIRECT_URI",
  "GMAIL_REFRESH_TOKEN",
  "MIDDLEWARE_VERIFY_SECRET",
  "ONBOARDING_DRAFT_SECRET",
  "ONBOARDING_DRAFT_SECRET_PREVIOUS",
]);

const CONFIG_DIR = path.join(os.homedir(), ".emailagent");
const CONFIG_FILE = path.join(CONFIG_DIR, "runtime-config.json");

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readRuntimeConfigFileSync(): RuntimeConfigMap {
  try {
    ensureConfigDir();
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as RuntimeConfigMap;
  } catch {
    return {};
  }
}

function writeRuntimeConfigFileSync(config: RuntimeConfigMap): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function isSecretKey(key: RuntimeConfigKey): boolean {
  return SECRET_KEYS.has(key);
}

function getFromLegacyEnv(key: RuntimeConfigKey): string | null {
  const value = LEGACY_ENV[key];
  if (!value || !value.trim()) return null;
  return value;
}

function normalizeValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

export function getRuntimeConfigSync(key: RuntimeConfigKey): string | null {
  if (isSecretKey(key)) {
    const secret = normalizeValue(keychainStore.getSecretSync(key));
    if (secret) return secret;

    const fallback = getFromLegacyEnv(key);
    if (fallback) {
      keychainStore.setSecretSync(key, fallback);
      return fallback;
    }
    return null;
  }

  const persisted = normalizeValue(readRuntimeConfigFileSync()[key]);
  if (persisted) return persisted;

  const fallback = getFromLegacyEnv(key);
  if (fallback) {
    setRuntimeConfigSync(key, fallback);
    return fallback;
  }
  return null;
}

export async function getRuntimeConfig(key: RuntimeConfigKey): Promise<string | null> {
  return getRuntimeConfigSync(key);
}

export function setRuntimeConfigSync(key: RuntimeConfigKey, value: string): void {
  const next = normalizeValue(value);
  if (!next) return;

  if (isSecretKey(key)) {
    keychainStore.setSecretSync(key, next);
    return;
  }

  const map = readRuntimeConfigFileSync();
  map[key] = next;
  writeRuntimeConfigFileSync(map);
}

export async function setRuntimeConfig(key: RuntimeConfigKey, value: string): Promise<void> {
  setRuntimeConfigSync(key, value);
}

export async function setRuntimeConfigValues(values: Partial<Record<RuntimeConfigKey, string | null | undefined>>): Promise<void> {
  for (const [key, value] of Object.entries(values) as Array<[RuntimeConfigKey, string | null | undefined]>) {
    const normalized = normalizeValue(value);
    if (normalized) {
      setRuntimeConfigSync(key, normalized);
    }
  }
}

export function getRuntimeConfigBooleanSync(key: RuntimeConfigKey, fallback = false): boolean {
  const raw = getRuntimeConfigSync(key);
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

export function getRuntimeConfigRequiredSync(key: RuntimeConfigKey): string {
  const value = getRuntimeConfigSync(key);
  if (!value) {
    throw new Error(`Missing runtime configuration value: ${key}`);
  }
  return value;
}

export function getRuntimeConfigSnapshot(keys: RuntimeConfigKey[]): Record<RuntimeConfigKey, boolean> {
  const status = {} as Record<RuntimeConfigKey, boolean>;
  for (const key of keys) {
    status[key] = Boolean(getRuntimeConfigSync(key));
  }
  return status;
}
