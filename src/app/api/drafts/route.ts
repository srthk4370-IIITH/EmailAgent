import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "../../../db/client";
import { listDrafts, listDraftsActive } from "../../../db/drafts";
import { apiError } from "../../../lib/apiError";
import { logSlowApi } from "../../../utils/api";
import { withApiRoute } from "../../../lib/routeErrorHandler";

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

    const drafts = activeOnly ? await listDraftsActive() : await listDrafts();

    const emailIds = [...new Set(drafts.map((d) => d.email_id))];
    const subjects = new Map<number, { subject: string; from_email: string }>();
    if (emailIds.length > 0) {
      const res = await db.query<{ id: number; subject: string; from_email: string }>(
        `SELECT id, subject, from_email FROM emails WHERE id = ANY($1::int[])`,
        [emailIds],
      );
      for (const row of res.rows) {
        subjects.set(row.id, { subject: row.subject, from_email: row.from_email });
      }
    }

    const response = NextResponse.json({
      drafts: drafts.map((d) => ({
        ...d,
        email_subject: subjects.get(d.email_id)?.subject ?? null,
        email_from: subjects.get(d.email_id)?.from_email ?? null,
      })),
    });
    logSlowApi("/api/drafts", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "DRAFTS_LIST_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry loading drafts. If it persists, verify database health.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/drafts", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/drafts', operation: 'GET' });
