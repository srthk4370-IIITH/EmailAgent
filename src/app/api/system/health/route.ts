import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { db } from "../../../../db/client";
import { getConfig } from "../../../../db/config";
import { countProcessableEmails } from "../../../../db/emails";
import { countJobsByStatus } from "../../../../db/jobs";
import { getAllHealthStatuses } from "../../../../db/systemHealth";
import { checkBudget } from "../../../../core/costControl";
import { apiError } from "../../../../lib/apiError";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

async function GETHandler() {
  try {
    await db.query("SELECT 1");
    const [config, processable, jobs, services, budget] = await Promise.all([
      getConfig(),
      countProcessableEmails(),
      countJobsByStatus("embed_email"),
      getAllHealthStatuses(),
      checkBudget(),
    ]);

    // Compute overall system status from individual services
    const hasDown = services.some((s) => s.status === "down");
    const hasDegraded = services.some((s) => s.status === "degraded");
    const overallStatus = hasDown ? "down" : hasDegraded ? "degraded" : "ok";

    return NextResponse.json({
      ok: overallStatus === "ok",
      overall_status: overallStatus,
      mode: config.global_mode,
      send_mode: config.send_mode,
      processable,
      jobs,
      services: Object.fromEntries(
        services.map((s) => [
          s.service,
          {
            status: s.status,
            last_checked_at: s.last_checked_at,
            last_ok_at: s.last_ok_at,
            error_message: s.error_message,
            last_heartbeat_at: s.last_heartbeat_at,
          },
        ]),
      ),
      budget: {
        tokens_used_today: budget.tokens_used_today,
        daily_token_limit: budget.daily_token_limit,
        budget_remaining: budget.budget_remaining,
        percentage_used: budget.percentage_used,
        budget_exceeded: budget.budget_exceeded,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      apiError(
        "HEALTH_CHECK_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Verify database connectivity and run diagnostics to inspect failing dependencies.",
      ),
      { status: 500 },
    );
  }
}


export const GET = withApiRoute(GETHandler, { route: '/system/health', operation: 'GET' });
