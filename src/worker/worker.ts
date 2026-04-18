/**
 * Worker Orchestrator — Runs all three worker loops concurrently.
 *
 * Architecture:
 * - ingestWorker: Gmail sync (30s interval, 60s idle)
 * - processWorker: Classification + generation (10s interval, 30s idle)
 * - sendWorker: Email sending (5s interval, 30s idle)
 *
 * Each worker runs independently with its own backoff state.
 * They share DB state but don't block each other.
 *
 * Features:
 * - Graceful shutdown (SIGTERM/SIGINT)
 * - Exponential backoff with jitter on failures
 * - Worker heartbeat to system_health table
 */

import { initDbSchema } from "../db/client";
import { db } from "../db/client";
import { getRuntimeConfigRequiredSync, getRuntimeConfigSnapshot } from "../lib/runtimeConfig";
import { handleWorkerError } from "../lib/workerErrorHandler";
import { logger } from "../utils/logger";
import { installShutdownHandlers, isShutdownRequested, runWorkerLoop } from "./workerBase";
import { ingestTick } from "./ingestWorker";
import { processTick } from "./processWorker";
import { sendTick } from "./sendWorker";

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
        timeoutId.unref();
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function isSchemaReady(): Promise<boolean> {
  const res = await db.query<{
    emails: string | null;
    job_queue: string | null;
    system_health: string | null;
    config: string | null;
  }>(
    `SELECT
       to_regclass('public.emails')::text AS emails,
       to_regclass('public.job_queue')::text AS job_queue,
       to_regclass('public.system_health')::text AS system_health,
       to_regclass('public.config')::text AS config`,
  );
  const row = res.rows[0];
  return Boolean(row?.emails && row?.job_queue && row?.system_health && row?.config);
}

async function main(): Promise<void> {
  console.log("🚀 Worker orchestrator starting");

  // Validate required runtime config early so worker startup fails fast with clear context.
  getRuntimeConfigRequiredSync("DATABASE_URL");
  const runtimeSnapshot = getRuntimeConfigSnapshot([
    "OPENAI_API_KEY",
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REDIRECT_URI",
  ]);
  logger.info("Worker runtime config snapshot", runtimeSnapshot);

  // Install graceful shutdown handlers FIRST
  installShutdownHandlers();

  const schemaPreflightTimeoutMs = parsePositiveInt(process.env.WORKER_SCHEMA_PREFLIGHT_TIMEOUT_MS) ?? 10_000;
  const schemaInitTimeoutMs = parsePositiveInt(process.env.WORKER_SCHEMA_INIT_TIMEOUT_MS) ?? 45_000;

  // Initialize database schema only when required.
  logger.info("Worker checking database schema readiness", {
    preflightTimeoutMs: schemaPreflightTimeoutMs,
    initTimeoutMs: schemaInitTimeoutMs,
  });
  try {
    const ready = await withTimeout(
      isSchemaReady(),
      schemaPreflightTimeoutMs,
      `Schema preflight timed out after ${schemaPreflightTimeoutMs}ms`,
    );

    if (ready) {
      logger.info("Worker schema already ready — skipping bootstrap migrations");
    } else {
      logger.info("Worker initializing database schema");
      await withTimeout(
        initDbSchema(),
        schemaInitTimeoutMs,
        `Schema init timed out after ${schemaInitTimeoutMs}ms`,
      );
      logger.info("Worker database schema initialized");
    }
  } catch (err) {
    if (isShutdownRequested()) {
      logger.info("Worker shutdown requested during DB init — exiting cleanly");
      process.exit(0);
    }

    const appError = await handleWorkerError(err, {
      worker: "WorkerOrchestrator",
      operation: "init-db-schema",
    });
    console.error("DB INIT FAILED", {
      code: appError.code,
      message: appError.message,
      reason: appError.reason,
      fix: appError.fix,
    });
    process.exit(1);
  }

  logger.info("Worker orchestrator started — 3 concurrent loops");

  // Run all three workers concurrently.
  // Promise.allSettled ensures one worker crashing doesn't kill the others.
  const results = await Promise.allSettled([
    runWorkerLoop({
      name: "IngestWorker",
      intervalMs: 30_000,
      idleIntervalMs: 60_000,
      tick: ingestTick,
    }),
    runWorkerLoop({
      name: "ProcessWorker",
      intervalMs: 10_000,
      idleIntervalMs: 30_000,
      tick: processTick,
    }),
    runWorkerLoop({
      name: "SendWorker",
      intervalMs: 5_000,
      idleIntervalMs: 30_000,
      tick: sendTick,
    }),
  ]);

  // Log which workers stopped and why
  let unexpectedCrash = false;
  for (const result of results) {
    if (result.status === "rejected") {
      if (isShutdownRequested()) {
        logger.warn("Worker loop exited during shutdown", {
          reason: String(result.reason ?? "unknown"),
        });
        continue;
      }

      unexpectedCrash = true;
      const appError = await handleWorkerError(result.reason, {
        worker: "WorkerOrchestrator",
        operation: "worker-loop-crash",
      });
      logger.error("Worker loop crashed", {
        code: appError.code,
        message: appError.message,
        reason: appError.reason,
        fix: appError.fix,
      });
    }
  }

  logger.info("Worker orchestrator stopped");
  process.exit(unexpectedCrash ? 1 : 0);
}

void main().catch(async (err) => {
  if (isShutdownRequested()) {
    logger.info("Worker main aborted during shutdown");
    process.exit(0);
  }

  const appError = await handleWorkerError(err, {
    worker: "WorkerOrchestrator",
    operation: "fatal",
  });
  logger.error("Worker orchestrator fatal error", {
    code: appError.code,
    message: appError.message,
    reason: appError.reason,
    fix: appError.fix,
  });
  process.exit(1);
});
