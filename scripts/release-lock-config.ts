import { getRuntimeConfigSync, setRuntimeConfigValues } from "../src/lib/runtimeConfig";

const SHIP_LOCK = {
  MODE: "production",
  LOG_LEVEL: "adaptive",
  RETRY_LIMIT: "3",
  TIMEOUT_STRICT: "true",
} as const;

async function main() {
  await setRuntimeConfigValues(SHIP_LOCK);

  const snapshot = {
    MODE: getRuntimeConfigSync("MODE"),
    LOG_LEVEL: getRuntimeConfigSync("LOG_LEVEL"),
    RETRY_LIMIT: getRuntimeConfigSync("RETRY_LIMIT"),
    TIMEOUT_STRICT: getRuntimeConfigSync("TIMEOUT_STRICT"),
  };

  if (
    snapshot.MODE !== SHIP_LOCK.MODE ||
    snapshot.LOG_LEVEL !== SHIP_LOCK.LOG_LEVEL ||
    snapshot.RETRY_LIMIT !== SHIP_LOCK.RETRY_LIMIT ||
    snapshot.TIMEOUT_STRICT !== SHIP_LOCK.TIMEOUT_STRICT
  ) {
    throw new Error(`Ship lock mismatch: ${JSON.stringify(snapshot)}`);
  }

  console.log("SHIP MODE LOCKED", snapshot);
}

void main().catch((error) => {
  console.error("RELEASE_LOCK_FAILED", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
