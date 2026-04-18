import { db, initDbSchema } from "../src/db/client";
import { getRuntimeConfigSync } from "../src/lib/runtimeConfig";

type SignalCount = {
  signal: string;
  count: number;
};

type AuthRepeat = {
  user_key: string;
  count: number;
};

type WorkerRetryHotspot = {
  email_id: string;
  count: number;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const LOOKBACK_MINUTES = parsePositiveInt(process.env.RELEASE_SIGNAL_LOOKBACK_MINUTES, 60);
const FORCE_PROCESS_FREQUENT_THRESHOLD = parsePositiveInt(
  process.env.RELEASE_FORCE_PROCESS_FREQUENT_THRESHOLD,
  10,
);
const AUTH_REPEAT_THRESHOLD = parsePositiveInt(process.env.RELEASE_AUTH_REPEAT_THRESHOLD, 3);

async function querySignalCounts(): Promise<SignalCount[]> {
  const result = await db.query<SignalCount>(
    `SELECT signal, COUNT(*)::int AS count
       FROM (
         SELECT
           CASE
             WHEN step = 'EMAIL_LIST_DEGRADED' THEN 'EMAIL_LIST_DEGRADED'
             WHEN step = 'EMAIL_LIST_TIMEOUT' THEN 'EMAIL_LIST_TIMEOUT'
             WHEN step = 'PROCESS_FORCE_USED' THEN 'PROCESS_FORCE_USED'
             WHEN step IN ('SEND_BLOCKED_SAFETY', 'send_blocked_safety') THEN 'SEND_BLOCKED_SAFETY'
             WHEN step = 'GMAIL_DISCONNECTED' THEN 'GMAIL_DISCONNECTED'
             WHEN step = 'AUTH_FAILURE' THEN 'AUTH_FAILURE'
             WHEN step = 'WORKER_LOOP_RETRY' THEN 'WORKER_LOOP_RETRY'
             ELSE NULL
           END AS signal
         FROM logs
         WHERE created_at >= NOW() - ($1::text || ' minutes')::interval
       ) normalized
      WHERE signal IS NOT NULL
      GROUP BY signal
      ORDER BY signal ASC`,
    [LOOKBACK_MINUTES],
  );
  return result.rows;
}

async function queryEmailListRequestCount(): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM logs
      WHERE step = 'EMAIL_LIST_REQUEST'
        AND created_at >= NOW() - ($1::text || ' minutes')::interval`,
    [LOOKBACK_MINUTES],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function queryRepeatingAuthFailures(): Promise<AuthRepeat[]> {
  const result = await db.query<AuthRepeat>(
    `SELECT COALESCE(meta->>'userKey', 'unknown') AS user_key,
            COUNT(*)::int AS count
       FROM logs
      WHERE step = 'AUTH_FAILURE'
        AND created_at >= NOW() - ($1::text || ' minutes')::interval
      GROUP BY COALESCE(meta->>'userKey', 'unknown')
      HAVING COUNT(*) >= $2
      ORDER BY count DESC, user_key ASC`,
    [LOOKBACK_MINUTES, AUTH_REPEAT_THRESHOLD],
  );
  return result.rows.filter((row) => row.user_key !== 'anonymous' && row.user_key !== 'unknown');
}

async function queryWorkerRetryHotspots(): Promise<WorkerRetryHotspot[]> {
  const result = await db.query<WorkerRetryHotspot>(
    `SELECT COALESCE(meta->>'emailId', 'unknown') AS email_id,
            COUNT(*)::int AS count
       FROM logs
      WHERE step = 'WORKER_LOOP_RETRY'
        AND created_at >= NOW() - ($1::text || ' minutes')::interval
        AND meta ? 'emailId'
      GROUP BY COALESCE(meta->>'emailId', 'unknown')
      HAVING COUNT(*) > 3
      ORDER BY count DESC, email_id ASC`,
    [LOOKBACK_MINUTES],
  );
  return result.rows;
}

async function queryPersistentRetryRows(): Promise<Array<{ id: number; retry_count: number }>> {
  const result = await db.query<{ id: number; retry_count: number }>(
    `SELECT id, retry_count
       FROM emails
      WHERE retry_count > 3
        AND COALESCE(last_step, '') <> 'send_skipped_dry_mode'
        AND COALESCE(from_email, '') <> 'fault.inject@example.com'
        AND COALESCE(gmail_id, '') NOT LIKE 'fi-inbox-%'
        AND updated_at >= NOW() - ($1::text || ' minutes')::interval
      ORDER BY retry_count DESC, id DESC
      LIMIT 20`,
    [LOOKBACK_MINUTES],
  );
  return result.rows;
}

function countFor(signal: string, rows: SignalCount[]): number {
  return Number(rows.find((row) => row.signal === signal)?.count ?? 0);
}

async function main() {
  await initDbSchema();

  const shipModeSnapshot = {
    MODE: getRuntimeConfigSync("MODE"),
    LOG_LEVEL: getRuntimeConfigSync("LOG_LEVEL"),
    RETRY_LIMIT: getRuntimeConfigSync("RETRY_LIMIT"),
    TIMEOUT_STRICT: getRuntimeConfigSync("TIMEOUT_STRICT"),
  };

  const signalCounts = await querySignalCounts();
  const emailListRequests = await queryEmailListRequestCount();
  const emailListDegraded = countFor("EMAIL_LIST_DEGRADED", signalCounts);
  const processForceUsed = countFor("PROCESS_FORCE_USED", signalCounts);
  const repeatingAuth = await queryRepeatingAuthFailures();
  const workerRetryHotspots = await queryWorkerRetryHotspots();
  const persistentRetryRows = await queryPersistentRetryRows();

  const degradedRatePercent =
    emailListRequests > 0 ? Number(((emailListDegraded / emailListRequests) * 100).toFixed(2)) : 0;

  const alerts: string[] = [];
  if (emailListRequests > 0 && degradedRatePercent > 5) {
    alerts.push(`ALERT /api/emails degraded ${degradedRatePercent}% > 5%`);
  }
  if (repeatingAuth.length > 0) {
    alerts.push(`ALERT repeating auth failures for users: ${repeatingAuth.map((row) => `${row.user_key}(${row.count})`).join(", ")}`);
  }
  if (workerRetryHotspots.length > 0 || persistentRetryRows.length > 0) {
    const hotspots = workerRetryHotspots.map((row) => `${row.email_id}(${row.count})`).join(", ");
    const persistent = persistentRetryRows.map((row) => `${row.id}(${row.retry_count})`).join(", ");
    alerts.push(`ALERT worker retries > 3 per email: ${hotspots || "none"}; persistent rows: ${persistent || "none"}`);
  }
  if (processForceUsed > FORCE_PROCESS_FREQUENT_THRESHOLD) {
    alerts.push(
      `ALERT force-processing used ${processForceUsed} times in ${LOOKBACK_MINUTES}m (threshold ${FORCE_PROCESS_FREQUENT_THRESHOLD})`,
    );
  }

  console.log("RELEASE_SIGNAL_AUDIT", {
    lookbackMinutes: LOOKBACK_MINUTES,
    shipModeSnapshot,
    trackedSignals: signalCounts,
    emailListRequests,
    degradedRatePercent,
    repeatingAuth,
    workerRetryHotspots,
    persistentRetryRows,
    forceProcessThreshold: FORCE_PROCESS_FREQUENT_THRESHOLD,
  });

  if (alerts.length > 0) {
    for (const alert of alerts) {
      console.error(alert);
    }
    process.exit(1);
  }

  console.log("RELEASE_SIGNAL_AUDIT_PASSED");
}

void main().catch((error) => {
  console.error("RELEASE_SIGNAL_AUDIT_FAILED", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
