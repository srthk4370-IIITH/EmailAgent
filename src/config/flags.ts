import { getRuntimeConfigBooleanSync } from "../lib/runtimeConfig";

export const FLAGS = {
  MULTI_ACCOUNT_ENABLED: getRuntimeConfigBooleanSync("MULTI_ACCOUNT_ENABLED", false),
  RAG_HYBRID_ENABLED: getRuntimeConfigBooleanSync("RAG_HYBRID_ENABLED", false),
  STRICT_ERROR_ENVELOPE_ENABLED: getRuntimeConfigBooleanSync("STRICT_ERROR_ENVELOPE_ENABLED", false),
};
