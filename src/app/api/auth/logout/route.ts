import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { deleteSession } from "../../../../db/auth";
import { apiError } from "../../../../lib/apiError";
import { withApiRoute } from "../../../../lib/routeErrorHandler";
import { shouldUseSecureSessionCookie } from "../../../../lib/sessionCookie";
import { emitSystemSignal } from "../../../../lib/systemSignals";
import { withTimeout } from "../../../../utils/withTimeout";

const AUTH_DB_TIMEOUT_MS = 8_000;

async function POSTHandler(request: NextRequest) {
  try {
    const jar = await cookies();
    const token = jar.get("ea_session")?.value;
    if (token) {
      await withTimeout(deleteSession(token), AUTH_DB_TIMEOUT_MS);
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set("ea_session", "", {
      httpOnly: true,
      path: "/",
      maxAge: 0,
      sameSite: "lax",
      secure: shouldUseSecureSessionCookie(request),
    });
    return response;
  } catch (error) {
    void emitSystemSignal("AUTH_FAILURE", {
      state: "LOGOUT_FAILED",
      error: error instanceof Error ? error.message : "unknown_error",
      meta: {
        reason: "logout_failed",
        userKey: "session",
      },
    });
    return NextResponse.json(
      apiError(
        "LOGOUT_FAILED",
        error instanceof Error ? error.message : "unknown_error",
        "Retry logout. If this persists, clear browser cookies and retry.",
      ),
      { status: 500 },
    );
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/auth/logout', operation: 'POST' });
