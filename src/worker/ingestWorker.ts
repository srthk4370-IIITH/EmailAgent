/**
 * Ingest Worker — Gmail sync only.
 *
 * Responsible for:
 * - Gmail mailbox sync (incremental via History API)
 * - Thread state reconciliation
 * - Compose request processing
 *
 * Does NOT do classification, generation, or sending.
 * Runs independently so Gmail API latency doesn't block processing.
 */

import { ingestInboxEmails, processComposeRequests } from "../core/processor";
import { resetDailyTokensIfNeeded } from "../core/costControl";
import { logger } from "../utils/logger";
import { isShutdownRequested } from "./workerBase";

export async function ingestTick(): Promise<boolean> {
  if (isShutdownRequested()) return false;

  // Reset daily token counter if date changed (cheap, idempotent)
  try { await resetDailyTokensIfNeeded(); } catch { /* non-critical */ }

  await ingestInboxEmails();

  if (isShutdownRequested()) return false;

  await processComposeRequests();

  // Ingest always returns true (it did work — even if no new emails, it checked)
  return true;
}
