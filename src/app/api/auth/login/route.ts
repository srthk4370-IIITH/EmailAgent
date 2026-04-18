import { randomBytes } from "crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createSession, upsertUserByEmail } from "../../../../db/auth";
import { apiError } from "../../../../lib/apiError";
import { withApiRoute } from "../../../../lib/routeErrorHandler";
import { shouldUseSecureSessionCookie } from "../../../../lib/sessionCookie";
import { emitSystemSignal } from "../../../../lib/systemSignals";
import { withTimeout } from "../../../../utils/withTimeout";

const AUTH_DB_TIMEOUT_MS = 8_000;

const schema = z.object({
  email: z.string().email(),
});

async function POSTHandler(request: NextRequest) {
  let attemptedEmail: string | null = null;
  try {
    const body = await request.json();
    attemptedEmail =
      body && typeof body === "object" && "email" in body && typeof (body as { email?: unknown }).email === "string"
        ? (body as { email: string }).email.trim().toLowerCase().slice(0, 320)
        : null;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      void emitSystemSignal("AUTH_FAILURE", {
        state: "INVALID_LOGIN_REQUEST",
        error: "invalid_email",
        meta: {
          reason: "invalid_email",
          userKey: attemptedEmail ?? "unknown",
        },
      });
      return NextResponse.json(
        apiError("INVALID_LOGIN_REQUEST", "invalid_email", "Provide a valid email address."),
        { status: 400 },
      );
    }

    const user = await withTimeout(upsertUserByEmail(parsed.data.email), AUTH_DB_TIMEOUT_MS);
    const token = randomBytes(32).toString("hex");
    await withTimeout(createSession(user.id, token), AUTH_DB_TIMEOUT_MS);

    const response = NextResponse.json({
      ok: true,
      user: { id: user.id, email: user.email },
    });
    response.cookies.set("ea_session", token, {
      httpOnly: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
      sameSite: "lax",
      secure: shouldUseSecureSessionCookie(request),
    });
    return response;
  } catch (error) {
    void emitSystemSignal("AUTH_FAILURE", {
      state: "LOGIN_FAILED",
      error: error instanceof Error ? error.message : "unknown_error",
      meta: {
        reason: "login_failed",
        userKey: attemptedEmail ?? "unknown",
      },
    });
    return NextResponse.json(
      apiError(
        "LOGIN_FAILED",
        error instanceof Error ? error.message : "unknown_error",
        "Retry login. If this persists, verify database connectivity.",
      ),
      { status: 500 },
    );
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/auth/login', operation: 'POST' });
