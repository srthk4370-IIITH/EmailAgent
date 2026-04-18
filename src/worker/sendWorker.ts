/**
 * Send Worker — Email sending only.
 *
 * Responsible for:
 * - Recovering stale send attempts
 * - Processing READY_TO_SEND emails (the send path in processOneEmail)
 *
 * Isolated so that send operations (which touch Gmail API)
 * don't get queued behind classification/generation work.
 *
 * Note: The actual send logic lives inside processOneEmail in processor.ts.
 * This worker ensures READY_TO_SEND emails are prioritized by filtering
 * the processable queue to only READY_TO_SEND state.
 */

import { db } from "../db/client";
import { recoverStaleSendAttempts } from "../db/sendAttempts";
import { processPendingEmails } from "../core/processor";
import { logger } from "../utils/logger";
import { isShutdownRequested } from "./workerBase";

export async function sendTick(): Promise<boolean> {
  if (isShutdownRequested()) return false;

  // Recover stale send attempts
  const recovered = await recoverStaleSendAttempts(180);
  if (recovered.length > 0) {
    logger.warn("Send worker recovered stale send attempts", { count: recovered.length });
  }

  if (isShutdownRequested()) return false;

  // Check for READY_TO_SEND emails specifically
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM emails
     WHERE state = 'READY_TO_SEND'
       AND review_outcome IS DISTINCT FROM 'rejected'`,
  );
  const sendableCount = Number(result.rows[0]?.count ?? 0);

  if (sendableCount === 0) {
    return false; // idle
  }

  // Process only the sendable batch.
  // processPendingEmails prioritizes READY_TO_SEND (ORDER BY CASE WHEN state = 'READY_TO_SEND' THEN 0...)
  // so sending gets priority even through the shared processor.
  const batchSize = Math.min(10, sendableCount);
  await processPendingEmails(batchSize, {
    shouldStop: isShutdownRequested,
    maxParallel: 2,
  });

  return true; // did work
}
