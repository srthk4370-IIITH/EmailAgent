import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";

import { db } from "../../../db/client";
import { getEmbeddingCountsForEmailIds } from "../../../db/embeddings";
import { listEmailsFiltered, type EmailListFilter } from "../../../db/emails";
import { shapeEmailListItem } from "../../../lib/emailApi";
import { apiError } from "../../../lib/apiError";
import { logSlowApi } from "../../../utils/api";
import { withTimeout } from "../../../utils/withTimeout";
import type { EmailRecord } from "../../../db/emails";
import { withApiRoute } from "../../../lib/routeErrorHandler";

const querySchema = z.object({
  filter: z.enum(["all", "inbox", "sent", "rejected"]).optional(),
  limit: z.string().transform(Number).optional(),
  cursorDate: z.string().transform(Number).optional(),
  cursorId: z.string().transform(Number).optional(),
  accountId: z.string().transform(Number).optional(),
});

async function GETHandler(request: NextRequest) {
  const start = Date.now();
  try {
    const raw = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        apiError("INVALID_EMAIL_LIST_QUERY", "invalid_query", "Fix query parameters and retry."),
        { status: 400 },
      );
    }

    const filter: EmailListFilter = parsed.data.filter ?? "inbox";
    const limit = parsed.data.limit ?? 20;
    const accountId = parsed.data.accountId;
    const emails = await withTimeout(
      listEmailsFiltered(filter, limit, parsed.data.cursorDate, parsed.data.cursorId, Number.isFinite(accountId) ? accountId : undefined), 
      10_000
    );
    
    // TIER 3 OPTIMIZATION: Scoped draft lookup (only for processed email IDs)
    const emailIds = emails.map((e) => e.id);
    const drafts = emailIds.length > 0 
      ? await withTimeout(
          db.query<{
            id: number;
            email_id: number;
            reply: string;
            edited_body: string | null;
            status: string;
            is_fallback: boolean;
          }>(
            "SELECT id, email_id, reply, edited_body, status, is_fallback FROM drafts WHERE email_id = ANY($1::int[])",
            [emailIds]
          ),
          10_000,
        )
      : { rows: [] };

    const draftByEmailId = new Map<number, (typeof drafts.rows)[number]>();
    for (const draft of drafts.rows) {
      if (!draftByEmailId.has(draft.email_id)) {
        draftByEmailId.set(draft.email_id, draft);
      }
    }

    const embeddingCounts = await withTimeout(
      getEmbeddingCountsForEmailIds(emails.map((email) => email.id)),
      10_000,
    );

    const lastEmail = emails.length > 0 ? emails[emails.length - 1] : null;

    const resultData = {
      emails: emails.map((email: EmailRecord) =>
        shapeEmailListItem(
          email,
          draftByEmailId.get(email.id) ?? null,
          embeddingCounts.get(email.id) ?? 0,
        ),
      ),
      filter,
      nextCursor: (emails.length === limit && lastEmail) ? {
        date: lastEmail.internal_date,
        id: lastEmail.id,
      } : null,
    };

    // TIER 3 OPTIMIZATION: Browser Caching (ETag / Conditional GET)
    const etag = crypto.createHash("sha1").update(JSON.stringify(resultData)).digest("hex");
    const ifNoneMatch = request.headers.get("if-none-match");

    const cacheable = filter !== "inbox";

    if (cacheable && ifNoneMatch === etag) {
      logSlowApi("/api/emails", start);
      return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    }

    const response = NextResponse.json(resultData, {
      headers: cacheable ? { ETag: etag } : { "Cache-Control": "no-store" },
    });
    logSlowApi("/api/emails", start);
    return response;
  } catch (err) {
    const response = NextResponse.json(
      apiError(
        "EMAIL_LIST_FAILED",
        err instanceof Error ? err.message : "processing_deferred",
        "Retry list fetch. If issue persists, run diagnostics and verify database health.",
      ),
      { status: 500 },
    );
    logSlowApi("/api/emails", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/emails', operation: 'GET' });
