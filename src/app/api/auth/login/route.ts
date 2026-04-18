import { randomBytes } from "crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createSession, upsertUserByEmail } from "../../../../db/auth";
import { withApiRoute } from "../../../../lib/routeErrorHandler";
import { shouldUseSecureSessionCookie } from "../../../../lib/sessionCookie";

const schema = z.object({
  email: z.string().email(),
});

async function POSTHandler(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const user = await upsertUserByEmail(parsed.data.email);
    const token = randomBytes(32).toString("hex");
    await createSession(user.id, token);

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
  } catch {
    return NextResponse.json({ error: "Login failed" }, { status: 500 });
  }
}


export const POST = withApiRoute(POSTHandler, { route: '/auth/login', operation: 'POST' });
