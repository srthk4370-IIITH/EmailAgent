import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { consumeDesktopAuthHandoff } from "../../../../../../lib/desktopAuthHandoff";
import { withApiRoute } from "../../../../../../lib/routeErrorHandler";
import { shouldUseSecureSessionCookie } from "../../../../../../lib/sessionCookie";

const payloadSchema = z.object({
  handoffId: z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/),
});

async function POSTHandler(request: NextRequest) {
  const payload = await request.json().catch(() => ({}));
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_handoff_payload",
        cause: "invalid_handoff_payload",
        fix: "Restart desktop sign-in and try again.",
      },
      { status: 400 },
    );
  }

  const result = consumeDesktopAuthHandoff(parsed.data.handoffId);
  if (result.status === "pending") {
    return NextResponse.json({ ok: false, pending: true }, { status: 202 });
  }

  if (result.status === "error") {
    return NextResponse.json(
      {
        error: result.error,
        cause: result.error,
        fix: "Restart Google sign-in from the desktop app.",
      },
      { status: 409 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set("ea_session", result.token, {
    httpOnly: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
    secure: shouldUseSecureSessionCookie(request),
  });

  return response;
}

export const POST = withApiRoute(POSTHandler, {
  route: "/auth/desktop/handoff/consume",
  operation: "POST",
});
