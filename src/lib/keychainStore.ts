import fs from "fs";
import os from "os";
import path from "path";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

type SecretMap = Record<string, string>;

export interface KeychainStore {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  getSecretSync(key: string): string | null;
  setSecretSync(key: string, value: string): void;
  deleteSecretSync(key: string): void;
}

const SERVICE_DIR = path.join(os.homedir(), ".emailagent");
const KEY_PATH = path.join(SERVICE_DIR, "runtime-keychain.key");
const DATA_PATH = path.join(SERVICE_DIR, "runtime-keychain.json.enc");

function ensureDir(): void {
  if (!fs.existsSync(SERVICE_DIR)) {
    fs.mkdirSync(SERVICE_DIR, { recursive: true });
  }
}

function getOrCreateKeySync(): Buffer {
  ensureDir();
  if (!fs.existsSync(KEY_PATH)) {
    fs.writeFileSync(KEY_PATH, randomBytes(32));
  }
  const key = fs.readFileSync(KEY_PATH);
  if (key.length === 32) return key;

  // Recover from unexpected key size by rotating a fresh key.
  const nextKey = randomBytes(32);
  fs.writeFileSync(KEY_PATH, nextKey);
  return nextKey;
}

function encryptSync(payload: SecretMap): string {
  const key = getOrCreateKeySync();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

function decryptSync(raw: string): SecretMap {
  try {
    const parsed = JSON.parse(raw) as { iv?: string; tag?: string; data?: string };
    if (!parsed.iv || !parsed.tag || !parsed.data) return {};

    const key = getOrCreateKeySync();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    const value = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");

    const payload = JSON.parse(value);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    return payload as SecretMap;
  } catch {
    return {};
  }
}

function readSecretsSync(): SecretMap {
  ensureDir();
  if (!fs.existsSync(DATA_PATH)) return {};
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  if (!raw.trim()) return {};
  return decryptSync(raw);
}

function writeSecretsSync(next: SecretMap): void {
  ensureDir();
  fs.writeFileSync(DATA_PATH, encryptSync(next));
}

class FileKeychainStore implements KeychainStore {
  async getSecret(key: string): Promise<string | null> {
    return this.getSecretSync(key);
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.setSecretSync(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.deleteSecretSync(key);
  }

  getSecretSync(key: string): string | null {
    const map = readSecretsSync();
    const value = map[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  setSecretSync(key: string, value: string): void {
    const map = readSecretsSync();
    map[key] = value;
    writeSecretsSync(map);
  }

  deleteSecretSync(key: string): void {
    const map = readSecretsSync();
    if (!(key in map)) return;
    delete map[key];
    writeSecretsSync(map);
  }
}

export const keychainStore: KeychainStore = new FileKeychainStore();
