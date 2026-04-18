/**
 * Worker Base — Shared infrastructure for all workers.
 *
 * Provides:
 * - Exponential backoff with jitter
 * - Graceful shutdown (SIGTERM/SIGINT handling)
 * - Worker heartbeat to system_health
 * - Structured logging
 */

import { recordWorkerHeartbeat } from "../db/systemHealth";
import { handleWorkerError } from "../lib/workerErrorHandler";
import { emitSystemSignal } from "../lib/systemSignals";
import { logger } from "../utils/logger";

// ── Graceful shutdown ─────────────────────────────────────────────────
let shutdownRequested = false;
let shutdownHandlersInstalled = false;
let shutdownForceExitTimer: NodeJS.Timeout | null = null;
const shutdownWakeWaiters = new Set<() => void>();

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

const shutdownGraceMs =
  parsePositiveInt(process.env.WORKER_SHUTDOWN_GRACE_MS) ?? 90_000;

export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

function onShutdownSignal(signal: string) {
  if (shutdownRequested) {
    logger.warn(`Worker received ${signal} during shutdown — forcing immediate exit`);
    process.exit(1);
  }

  shutdownRequested = true;
  logger.info(`Worker received ${signal} — finishing current tick then exiting`, {
    graceMs: shutdownGraceMs,
  });

  // Wake any sleeping loops so they can observe shutdown immediately.
  for (const wake of shutdownWakeWaiters) {
    wake();
  }
  shutdownWakeWaiters.clear();

  // Give current tick time to finish, then force exit.
  if (shutdownForceExitTimer) {
    clearTimeout(shutdownForceExitTimer);
  }
  shutdownForceExitTimer = setTimeout(() => {
    const graceSeconds = Math.round(shutdownGraceMs / 1000);
    logger.warn(`Worker force exit after ${graceSeconds}s grace period`);
    process.exit(1);
  }, shutdownGraceMs);
  shutdownForceExitTimer.unref();
}

export function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  process.on("SIGTERM", () => onShutdownSignal("SIGTERM"));
  process.on("SIGINT", () => onShutdownSignal("SIGINT"));
}

// ── Exponential backoff with jitter ───────────────────────────────────

export interface BackoffState {
  baseMs: number;
  maxMs: number;
  currentMs: number;
  consecutiveFailures: number;
}

export function createBackoff(baseMs = 10_000, maxMs = 5 * 60_000): BackoffState {
  return { baseMs, maxMs, currentMs: baseMs, consecutiveFailures: 0 };
}

export function backoffSuccess(state: BackoffState): void {
  state.currentMs = state.baseMs;
  state.consecutiveFailures = 0;
}

export function backoffFailure(state: BackoffState): void {
  state.consecutiveFailures += 1;
  // Exponential: base * 2^failures, capped at max, with ±25% jitter
  const exponential = state.baseMs * Math.pow(2, Math.min(state.consecutiveFailures, 8));
  const capped = Math.min(exponential, state.maxMs);
  const jitter = capped * (0.75 + Math.random() * 0.5); // ±25%
  state.currentMs = Math.min(jitter, state.maxMs);
}

export function getBackoffMs(state: BackoffState): number {
  return Math.round(state.currentMs);
}

// ── Worker heartbeat ──────────────────────────────────────────────────

export async function sendHeartbeat(): Promise<void> {
  try {
    await recordWorkerHeartbeat();
  } catch (err) {
    // Heartbeat failure must never crash the worker
    const appError = await handleWorkerError(err, {
      worker: "WorkerLoop",
      operation: "heartbeat",
    });
    logger.warn("Worker heartbeat failed", {
      code: appError.code,
      message: appError.message,
      reason: appError.reason,
      fix: appError.fix,
      retryable: appError.retryable,
    });
  }
}

// ── Sleep utility ─────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  if (shutdownRequested || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    const wake = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      shutdownWakeWaiters.delete(wake);
      resolve();
    };

    const timer = setTimeout(wake, ms);
    shutdownWakeWaiters.add(wake);
  });
}

// ── Generic worker loop ───────────────────────────────────────────────

export interface WorkerConfig {
  name: string;
  /** Normal interval between ticks (ms) */
  intervalMs: number;
  /** Interval when idle (no work to do) */
  idleIntervalMs: number;
  /** The tick function. Return true if work was done, false if idle. */
  tick: () => Promise<boolean>;
}

/**
 * Run a worker loop with backoff, heartbeat, and graceful shutdown.
 * Returns when shutdown is requested.
 */
export async function runWorkerLoop(config: WorkerConfig): Promise<void> {
  const backoff = createBackoff(config.intervalMs, 5 * 60_000);
  logger.info(`${config.name} started`, { intervalMs: config.intervalMs });

  while (!isShutdownRequested()) {
    let didWork = false;
    let tickOk = true;

    try {
      await sendHeartbeat();
      didWork = await config.tick();
      backoffSuccess(backoff);
    } catch (error) {
      tickOk = false;
      const appError = await handleWorkerError(error, {
        worker: config.name,
        operation: "tick",
      });
      logger.error(`${config.name} tick failed`, {
        code: appError.code,
        message: appError.message,
        reason: appError.reason,
        fix: appError.fix,
        retryable: appError.retryable,
      });
      backoffFailure(backoff);
      if (typeof appError.retryAfterMs === "number" && Number.isFinite(appError.retryAfterMs)) {
        backoff.currentMs = Math.max(backoff.baseMs, Math.min(backoff.maxMs, appError.retryAfterMs));
      }
      void emitSystemSignal("WORKER_LOOP_RETRY", {
        state: "RETRY_SCHEDULED",
        error: appError.reason,
        meta: {
          worker: config.name,
          reason: appError.reason,
          consecutiveFailures: backoff.consecutiveFailures,
          nextBackoffMs: getBackoffMs(backoff),
        },
      });
    }

    if (isShutdownRequested()) break;

    const waitMs = tickOk
      ? (didWork ? config.intervalMs : config.idleIntervalMs)
      : getBackoffMs(backoff);

    await sleep(waitMs);
  }

  logger.info(`${config.name} stopped gracefully`);
}
