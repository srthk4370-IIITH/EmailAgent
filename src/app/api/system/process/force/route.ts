import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { processEmailById } from "../../../../../core/processor";
import { db } from "../../../../../db/client";
import { getEmailById, listProcessableEmails, markAwaitingReview } from "../../../../../db/emails";
import { apiError } from "../../../../../lib/apiError";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";
import { emitSystemSignal } from "../../../../../lib/systemSignals";
import { logSlowApi } from "../../../../../utils/api";
import { withTimeout } from "../../../../../utils/withTimeout";

const bodySchema = z
  .object({
    emailId: z.number().int().positive().optional(),
    traceId: z.string().min(3).max(128).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  })
  .optional();

type ForceProcessPayload = z.infer<typeof bodySchema>;

type ForceProcessResult = {
  emailId: number;
  beforeState: string | null;
  afterState: string | null;
  assistRepairApplied: boolean;
  error: string | null;
};

async function resolveTargetEmailIds(payload: ForceProcessPayload): Promise<number[]> {
  if (payload?.emailId) {
    return [payload.emailId];
  }

  if (payload?.traceId) {
    const result = await db.query<{ id: number }>(
      "SELECT id FROM emails WHERE trace_id = $1 ORDER BY id DESC LIMIT 1",
      [payload.traceId],
    );
    return result.rows[0]?.id ? [result.rows[0].id] : [];
  }

  const processable = await listProcessableEmails(payload?.limit ?? 5);
  return processable.map((row) => row.id);
}

async function POSTHandler(request: NextRequest) {
  const start = Date.now();
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        apiError("INVALID_FORCE_PROCESS_REQUEST", "invalid_payload", "Provide a valid emailId, traceId, limit, or timeoutMs."),
        { status: 400 },
      );
    }

    const payload = parsed.data;
    const timeoutMs = payload?.timeoutMs ?? 20_000;
    const targetIds = await resolveTargetEmailIds(payload);

    void emitSystemSignal("PROCESS_FORCE_USED", {
      state: "FORCE_PROCESS",
      error: targetIds.length === 0 ? "no_matching_targets" : null,
      meta: {
        requested: targetIds.length,
        timeoutMs,
        hasEmailId: Boolean(payload?.emailId),
        hasTraceId: Boolean(payload?.traceId),
        limit: payload?.limit ?? null,
      },
    });

    if (targetIds.length === 0) {
      const response = NextResponse.json({
        ok: true,
        requested: 0,
        processed: 0,
        results: [] as ForceProcessResult[],
        message: "No processable emails matched this request.",
      });
      logSlowApi("/api/system/process/force", start);
      return response;
    }

    const results: ForceProcessResult[] = [];

    for (const emailId of targetIds) {
      const before = await getEmailById(emailId);
      let errorMessage: string | null = null;
      let assistRepairApplied = false;

      try {
        await withTimeout(processEmailById(emailId), timeoutMs);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      let after = await getEmailById(emailId);

      if (after && after.decision === "assist" && after.state === "GENERATED") {
        try {
          await markAwaitingReview(emailId);
          assistRepairApplied = true;
          after = await getEmailById(emailId);
        } catch (error) {
          const repairError = error instanceof Error ? error.message : String(error);
          errorMessage = errorMessage ? `${errorMessage}; assist_repair_failed:${repairError}` : `assist_repair_failed:${repairError}`;
        }
      }

      results.push({
        emailId,
        beforeState: before?.state ?? null,
        afterState: after?.state ?? null,
        assistRepairApplied,
        error: errorMessage,
      });
    }

    const processed = results.filter((item) => item.error === null).length;

    const response = NextResponse.json({
      ok: true,
      requested: targetIds.length,
      processed,
      results,
    });
    logSlowApi("/api/system/process/force", start);
    return response;
  } catch (error) {
    const response = NextResponse.json(
      apiError(
        "FORCE_PROCESS_FAILED",
        error instanceof Error ? error.message : "unknown_error",
        "Retry force-process. If this persists, verify worker and database health.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/system/process/force", start);
    return response;
  }
}

export const POST = withApiRoute(POSTHandler, { route: "/system/process/force", operation: "POST" });
