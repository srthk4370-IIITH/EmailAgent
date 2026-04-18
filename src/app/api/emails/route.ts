import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";

import { db } from "../../../db/client";
import { getEmbeddingCountsForEmailIds } from "../../../db/embeddings";
import { listEmailsFiltered, type EmailListFilter } from "../../../db/emails";
import { shapeEmailListItem } from "../../../lib/emailApi";
import { apiError } from "../../../lib/apiError";
import { emitSystemSignal } from "../../../lib/systemSignals";
import { logSlowApi } from "../../../utils/api";
import { withTimeout } from "../../../utils/withTimeout";
import type { EmailRecord } from "../../../db/emails";
import { withApiRoute } from "../../../lib/routeErrorHandler";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const LIST_TIMEOUT_MS = 8_000;
const AUX_TIMEOUT_MS = 4_000;

const querySchema = z.object({
  filter: z.enum(["all", "inbox", "sent", "rejected"]).optional(),
  limit: z.string().optional(),
  cursorDate: z.string().optional(),
  cursorId: z.string().optional(),
  accountId: z.string().optional(),
});

function parsePositiveInt(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return undefined;
  const int = Math.trunc(parsed);
  return int > 0 ? int : undefined;
}

function clampListLimit(input: string | undefined): number {
  const parsed = parsePositiveInt(input) ?? DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, parsed));
}

function isTimeoutLike(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("timeout") || message.includes("timed out") || message.includes("deadline");
}

function degradedEmailListResponse(params: {
  filter: EmailListFilter;
  reason: string;
  warnings: string[];
}): NextResponse {
  return NextResponse.json(
    {
      emails: [],
      filter: params.filter,
      nextCursor: null,
      degraded: true,
      reason: params.reason,
      warnings: params.warnings,
      fix: "Retry list fetch. If this persists, reduce polling frequency and verify database health.",
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

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
    const limit = clampListLimit(parsed.data.limit);
    const cursorDate = parsePositiveInt(parsed.data.cursorDate);
    const cursorId = parsePositiveInt(parsed.data.cursorId);
    const accountId = parsePositiveInt(parsed.data.accountId);

    void emitSystemSignal("EMAIL_LIST_REQUEST", {
      state: "REQUEST",
      meta: {
        filter,
        limit,
        accountId: accountId ?? null,
        hasCursor: Boolean(cursorDate && cursorId),
      },
    });

    const warnings: string[] = [];
    let degraded = false;

    let emails: EmailRecord[];
    try {
      emails = await withTimeout(
        listEmailsFiltered(filter, limit, cursorDate, cursorId, accountId),
        LIST_TIMEOUT_MS,
      );
    } catch (error) {
      degraded = true;
      const timeoutLike = isTimeoutLike(error);
      warnings.push(timeoutLike ? "email_list_timeout" : "email_list_failed");
      const reason = error instanceof Error ? error.message : "email_list_unavailable";
      void emitSystemSignal("EMAIL_LIST_DEGRADED", {
        state: "DEGRADED",
        error: reason,
        meta: {
          filter,
          limit,
          accountId: accountId ?? null,
          warnings,
        },
      });
      if (timeoutLike) {
        void emitSystemSignal("EMAIL_LIST_TIMEOUT", {
          state: "TIMEOUT",
          error: reason,
          meta: {
            filter,
            limit,
            accountId: accountId ?? null,
          },
        });
      }
      const response = degradedEmailListResponse({
        filter,
        reason,
        warnings,
      });
      logSlowApi("/api/emails", start);
      return response;
    }
    
    // TIER 3 OPTIMIZATION: Scoped draft lookup (only for processed email IDs)
    const emailIds = emails.map((e) => e.id);
    const draftByEmailId = new Map<
      number,
      {
        id: number;
        email_id: number;
        reply: string;
        edited_body: string | null;
        status: string;
        is_fallback: boolean;
      }
    >();
    let embeddingCounts = new Map<number, number>();

    if (emailIds.length > 0) {
      const [draftsResult, embeddingsResult] = await Promise.allSettled([
        withTimeout(
          db.query<{
            id: number;
            email_id: number;
            reply: string;
            edited_body: string | null;
            status: string;
            is_fallback: boolean;
          }>(
            "SELECT id, email_id, reply, edited_body, status, is_fallback FROM drafts WHERE email_id = ANY($1::int[])",
            [emailIds],
          ),
          AUX_TIMEOUT_MS,
        ),
        withTimeout(getEmbeddingCountsForEmailIds(emailIds), AUX_TIMEOUT_MS),
      ]);

      if (draftsResult.status === "fulfilled") {
        for (const draft of draftsResult.value.rows) {
          if (!draftByEmailId.has(draft.email_id)) {
            draftByEmailId.set(draft.email_id, draft);
          }
        }
      } else {
        degraded = true;
        warnings.push(isTimeoutLike(draftsResult.reason) ? "draft_lookup_timeout" : "draft_lookup_failed");
      }

      if (embeddingsResult.status === "fulfilled") {
        embeddingCounts = embeddingsResult.value;
      } else {
        degraded = true;
        warnings.push(isTimeoutLike(embeddingsResult.reason) ? "embedding_lookup_timeout" : "embedding_lookup_failed");
      }
    }

    const lastEmail = emails.length > 0 ? emails[emails.length - 1] : null;

    const resultData: {
      emails: ReturnType<typeof shapeEmailListItem>[];
      filter: EmailListFilter;
      nextCursor: { date: number | null; id: number } | null;
      degraded?: boolean;
      warnings?: string[];
      fix?: string;
    } = {
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

    if (degraded) {
      resultData.degraded = true;
      resultData.warnings = warnings;
      resultData.fix = "Retry list fetch. If this persists, reduce polling frequency and verify database health.";
      void emitSystemSignal("EMAIL_LIST_DEGRADED", {
        state: "DEGRADED",
        error: "email_list_partial_degradation",
        meta: {
          filter,
          limit,
          accountId: accountId ?? null,
          warnings,
        },
      });
      if (warnings.some((warning) => warning.includes("timeout"))) {
        void emitSystemSignal("EMAIL_LIST_TIMEOUT", {
          state: "TIMEOUT",
          error: "email_list_partial_timeout",
          meta: {
            filter,
            limit,
            accountId: accountId ?? null,
            warnings,
          },
        });
      }
    }

    // TIER 3 OPTIMIZATION: Browser Caching (ETag / Conditional GET)
    const etag = crypto.createHash("sha1").update(JSON.stringify(resultData)).digest("hex");
    const ifNoneMatch = request.headers.get("if-none-match");

    const cacheable = filter !== "inbox" && !degraded;

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
    const fallbackFilterRaw = request.nextUrl.searchParams.get("filter") ?? undefined;
    const fallbackFilter: EmailListFilter =
      fallbackFilterRaw === "all" || fallbackFilterRaw === "inbox" || fallbackFilterRaw === "sent" || fallbackFilterRaw === "rejected"
        ? fallbackFilterRaw
        : "inbox";

    const response = degradedEmailListResponse({
      filter: fallbackFilter,
      reason: err instanceof Error ? err.message : "email_list_failed",
      warnings: ["email_list_unexpected_failure"],
    });
    void emitSystemSignal("EMAIL_LIST_DEGRADED", {
      state: "DEGRADED",
      error: err instanceof Error ? err.message : "email_list_failed",
      meta: {
        filter: fallbackFilter,
        warnings: ["email_list_unexpected_failure"],
      },
    });
    if (err instanceof Error) {
      response.headers.set("X-Email-List-Error", "degraded");
    }

    // Endpoint intentionally returns a degraded 200 payload instead of 500.
    logSlowApi("/api/emails", start);
    return response;
  }
}


export const GET = withApiRoute(GETHandler, { route: '/emails', operation: 'GET' });
