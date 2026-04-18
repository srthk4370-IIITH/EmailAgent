import { createHash } from "crypto";

import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { getUserBySessionToken } from "../../../../db/auth";
import { apiError } from "../../../../lib/apiError";
import { shouldUseSecureSessionCookie } from "../../../../lib/sessionCookie";
import { withApiRoute } from "../../../../lib/routeErrorHandler";
import { emitSystemSignal } from "../../../../lib/systemSignals";
import { withTimeout } from "../../../../utils/withTimeout";

const AUTH_DB_TIMEOUT_MS = 8_000;

function sessionTokenKey(token: string): string {
  return createHash("sha1").update(token).digest("hex").slice(0, 12);
}

async function GETHandler(request: NextRequest) {
  const jar = await cookies();
  const token = jar.get("ea_session")?.value;
  if (!token) {
    void emitSystemSignal("AUTH_FAILURE", {
      state: "AUTH_REQUIRED",
      error: "missing_session",
      meta: {
        reason: "missing_session",
        userKey: "anonymous",
      },
    });
    return NextResponse.json(
      {
        user: null,
        ...apiError("AUTH_REQUIRED", "missing_session", "Sign in and retry."),
      },
      { status: 401 },
    );
  }

  const user = await withTimeout(getUserBySessionToken(token), AUTH_DB_TIMEOUT_MS);
  if (!user) {
    void emitSystemSignal("AUTH_FAILURE", {
      state: "AUTH_REQUIRED",
      error: "invalid_session",
      meta: {
        reason: "invalid_session",
        userKey: `session:${sessionTokenKey(token)}`,
      },
    });
    const response = NextResponse.json(
      {
        user: null,
        ...apiError("AUTH_REQUIRED", "invalid_session", "Sign in again and retry."),
      },
      { status: 401 },
    );
    response.cookies.set("ea_session", "", {
      httpOnly: true,
      path: "/",
      maxAge: 0,
      sameSite: "lax",
      secure: shouldUseSecureSessionCookie(request),
    });
    return response;
  }

  return NextResponse.json({ user: { id: user.id, email: user.email } });
}


export const GET = withApiRoute(GETHandler, { route: '/auth/me', operation: 'GET' });
