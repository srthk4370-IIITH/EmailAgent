import { NextResponse } from "next/server";

import { getConfig } from "../../../../db/config";
import {
  countDuplicateGmailIds,
  countEmailsCompletedLastMinute,
  countEmailsIngestedQueueDepth,
  countEmailsInProcessing,
  countLeaseConflicts,
  countStuckProcessingEmails,
  getAvgEndToEndTimeMs,
  getAvgProcessingTimeMs,
  getLlmCircuitBreakerActive,
  getLlmFailureRateLastHour,
  getEmailErrorRateLastHour,
  getLastEmailActivityAt,
} from "../../../../db/system";
import { getPrimaryUser } from "../../../../db/auth";
import { db } from "../../../../db/client";
import { logSlowApi } from "../../../../utils/api";
import { getDefaultEmailAccount } from "../../../../db/emailAccounts";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

async function GETHandler() {
  const start = Date.now();
  try {
    const [
      stuck,
      duplicates,
      lastAt,
      config,
      avgProcessingMs,
      emailsCompletedLastMin,
      emailsInProcessing,
      avgEndToEndMs,
      errorRate,
      leaseConflicts,
      queueDepth,
      llmFailureRate,
      circuitBreakerActive,
      primaryUserResult,
    ] = await Promise.all([
      countStuckProcessingEmails(),
      countDuplicateGmailIds(),
      getLastEmailActivityAt(),
      getConfig(),
      getAvgProcessingTimeMs(),
      countEmailsCompletedLastMinute(),
      countEmailsInProcessing(),
      getAvgEndToEndTimeMs(),
      getEmailErrorRateLastHour(),
      countLeaseConflicts(),
      countEmailsIngestedQueueDepth(),
      getLlmFailureRateLastHour(),
      getLlmCircuitBreakerActive(),
      getPrimaryUser(),
    ]);

    const defaultAccount = await getDefaultEmailAccount();

    const gmailConfigured = Boolean(defaultAccount?.oauth_refresh_token);
    const historyId = defaultAccount ? defaultAccount.last_history_id : config.last_gmail_history_id;
    const gmailOk = !gmailConfigured || Boolean(historyId);

    const primaryUser = primaryUserResult;
    const dbConnected = true; // If we reached here, DB is connected
    const gmailTokenOk = Boolean(defaultAccount?.oauth_refresh_token ?? primaryUser?.gmail_refresh_token);
    const setupRequired = !primaryUser || !primaryUser.google_sub || !gmailTokenOk;

    const pipelineOk = stuck === 0 && duplicates === 0;

    const response = NextResponse.json({
      pipeline_ok: pipelineOk,
      gmail_sync_ok: gmailOk,
      duplicates,
      stuck_emails: stuck,
      last_processed_at: lastAt,
      avg_processing_time_ms: Math.round(avgProcessingMs * 100) / 100,
      emails_completed_last_min: emailsCompletedLastMin,
      error_rate: Math.round(errorRate * 10000) / 10000,
      emails_in_processing: emailsInProcessing,
      emails_stuck: stuck,
      avg_end_to_end_time_ms: Math.round(avgEndToEndMs * 100) / 100,
      lease_conflicts: leaseConflicts,
      // Added production metrics.
      queue_depth: queueDepth,
      processing_rate: emailsCompletedLastMin,
      avg_latency_ms: Math.round(avgEndToEndMs * 100) / 100,
      llm_failure_rate: Math.round(llmFailureRate * 10000) / 10000,
      circuit_breaker_active: circuitBreakerActive,
      // Setup health
      db_connected: dbConnected,
      primary_user_ok: Boolean(primaryUser?.google_sub),
      gmail_token_ok: gmailTokenOk,
      setup_required: setupRequired,
    });
    logSlowApi("/api/system/check", start);
    return response;
  } catch {
    const response = NextResponse.json(
      {
        pipeline_ok: false,
        gmail_sync_ok: false,
        duplicates: 0,
        stuck_emails: 0,
        last_processed_at: null,
        avg_processing_time_ms: 0,
        emails_completed_last_min: 0,
        error_rate: 0,
        emails_in_processing: 0,
        emails_stuck: 0,
        avg_end_to_end_time_ms: 0,
        lease_conflicts: 0,
        error: "check_failed",
      },
      { status: 500 },
    );
    logSlowApi("/api/system/check", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/system/check', operation: 'GET' });
