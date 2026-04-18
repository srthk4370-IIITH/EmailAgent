/**
 * Process Worker — Classification + generation pipeline.
 *
 * Responsible for:
 * - Processing queued embedding jobs
 * - Recovering stuck PROCESSING emails
 * - Running the classification → decision → generation → draft pipeline
 *
 * Does NOT do Gmail sync or sending.
 */

import { countProcessableEmails, resetStuckProcessingEmails } from "../db/emails";
import { processQueuedJobs } from "../core/jobQueue";
import { processPendingEmails } from "../core/processor";
import { logger } from "../utils/logger";
import { isShutdownRequested } from "./workerBase";

export async function processTick(): Promise<boolean> {
  if (isShutdownRequested()) return false;

  // Recover stuck emails first
  const recovered = await resetStuckProcessingEmails();
  if (recovered > 0) {
    logger.info("Process worker recovered stuck emails", { count: recovered });
  }

  // Process embedding jobs
  await processQueuedJobs(10);

  if (isShutdownRequested()) return false;

  // Check how many emails need processing
  const pending = await countProcessableEmails();
  if (pending === 0) {
    return false; // idle — no work
  }

  const batchSize = Math.min(20, pending);
  await processPendingEmails(batchSize, {
    shouldStop: isShutdownRequested,
    maxParallel: 3,
  });

  return true; // did work
}
