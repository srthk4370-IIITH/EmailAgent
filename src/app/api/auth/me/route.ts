import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getUserBySessionToken } from "../../../../db/auth";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

async function GETHandler() {
  const jar = await cookies();
  const token = jar.get("ea_session")?.value;
  if (!token) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  const user = await getUserBySessionToken(token);
  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  return NextResponse.json({ user: { id: user.id, email: user.email } });
}


export const GET = withApiRoute(GETHandler, { route: '/auth/me', operation: 'GET' });
