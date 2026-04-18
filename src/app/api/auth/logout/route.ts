import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { deleteSession } from "../../../../db/auth";
import { withApiRoute } from "../../../../lib/routeErrorHandler";
import { shouldUseSecureSessionCookie } from "../../../../lib/sessionCookie";

async function POSTHandler(request: NextRequest) {
  const jar = await cookies();
  const token = jar.get("ea_session")?.value;
  if (token) {
    await deleteSession(token);
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
}


export const POST = withApiRoute(POSTHandler, { route: '/auth/logout', operation: 'POST' });
