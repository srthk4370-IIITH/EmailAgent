import { NextResponse } from "next/server";
import { z } from "zod";

import { getEmailById, setEmailSeenState } from "../../../../../db/emails";
import { apiError } from "../../../../../lib/apiError";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";

const paramsSchema = z.object({ id: z.string().regex(/^\d+$/) });
const bodySchema = z.object({ isSeen: z.boolean().optional() });

async function PATCHHandler(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const parsed = paramsSchema.safeParse({ id });
    if (!parsed.success) {
      return NextResponse.json(
        apiError("INVALID_EMAIL_ID", "invalid_id", "Use a numeric email id."),
        { status: 400 },
      );
    }

    const emailId = Number(parsed.data.id);
    const email = await getEmailById(emailId);
    if (!email) {
      return NextResponse.json(
        apiError("EMAIL_NOT_FOUND", "not_found", "Refresh list and retry."),
        { status: 404 },
      );
    }

    let isSeen = true;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const rawBody = await request.json().catch(() => ({}));
      const parsedBody = bodySchema.safeParse(rawBody);
      if (!parsedBody.success) {
        return NextResponse.json(
          apiError("INVALID_SEEN_PAYLOAD", "invalid_payload", "Pass { isSeen: boolean } when setting read state."),
          { status: 400 },
        );
      }
      isSeen = parsedBody.data.isSeen ?? true;
    }

    if (email.source !== "inbox") {
      return NextResponse.json({ ok: true, id: email.id, is_seen: true });
    }

    if (email.is_seen !== isSeen) {
      await setEmailSeenState(email.id, isSeen);
    }

    return NextResponse.json({ ok: true, id: email.id, is_seen: isSeen });
  } catch (err) {
    return NextResponse.json(
      apiError(
        "MARK_SEEN_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry opening the email. If it persists, refresh inbox and inspect logs.",
      ),
      { status: 500 },
    );
  }
}


export const PATCH = withApiRoute(PATCHHandler, { route: '/emails/[id]/seen', operation: 'PATCH' });
