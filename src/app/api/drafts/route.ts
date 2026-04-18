import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "../../../db/client";
import { listDrafts, listDraftsActive } from "../../../db/drafts";
import { apiError } from "../../../lib/apiError";
import { logSlowApi } from "../../../utils/api";
import { withTimeout } from "../../../utils/withTimeout";
import { withApiRoute } from "../../../lib/routeErrorHandler";

const DRAFT_LIST_TIMEOUT_MS = 8_000;
const EMAIL_JOIN_TIMEOUT_MS = 4_000;

const querySchema = z.object({
  active: z.enum(["1", "0", "true", "false"]).optional(),
});

async function GETHandler(request: NextRequest) {
  const start = Date.now();
  try {
    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const activeOnly =
      parsed.data.active === "1" ||
      parsed.data.active === "true" ||
      parsed.data.active === undefined;

    let degraded = false;
    const warnings: string[] = [];

    let drafts: Awaited<ReturnType<typeof listDrafts>>;
    try {
      drafts = await withTimeout(activeOnly ? listDraftsActive() : listDrafts(), DRAFT_LIST_TIMEOUT_MS);
    } catch (error) {
      const response = NextResponse.json({
        drafts: [],
        degraded: true,
        warnings: ["draft_list_timeout"],
        reason: error instanceof Error ? error.message : "draft_list_unavailable",
        fix: "Retry loading drafts. If this persists, verify database health.",
      });
      logSlowApi("/api/drafts", start);
      return response;
    }

    const emailIds = [...new Set(drafts.map((d) => d.email_id))];
    const subjects = new Map<number, { subject: string; from_email: string }>();
    if (emailIds.length > 0) {
      try {
        const res = await withTimeout(
          db.query<{ id: number; subject: string; from_email: string }>(
            `SELECT id, subject, from_email FROM emails WHERE id = ANY($1::int[])`,
            [emailIds],
          ),
          EMAIL_JOIN_TIMEOUT_MS,
        );
        for (const row of res.rows) {
          subjects.set(row.id, { subject: row.subject, from_email: row.from_email });
        }
      } catch {
        degraded = true;
        warnings.push("draft_email_join_timeout");
      }
    }

    const response = NextResponse.json({
      drafts: drafts.map((d) => ({
        ...d,
        email_subject: subjects.get(d.email_id)?.subject ?? null,
        email_from: subjects.get(d.email_id)?.from_email ?? null,
      })),
      ...(degraded
        ? {
            degraded: true,
            warnings,
            fix: "Retry loading drafts. If this persists, verify database health.",
          }
        : {}),
    });
    logSlowApi("/api/drafts", start);
    return response;
  } catch (err) {
    const response = NextResponse.json({
      drafts: [],
      degraded: true,
      warnings: ["draft_list_unexpected_failure"],
      ...(apiError(
        "DRAFTS_LIST_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry loading drafts. If it persists, verify database health.",
      ) as object),
    });
    logSlowApi("/api/drafts", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/drafts', operation: 'GET' });
