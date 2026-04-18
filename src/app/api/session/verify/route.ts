import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionFromDB } from "../../../../db/auth";
import { getRuntimeConfig } from "../../../../lib/runtimeConfig";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

const bodySchema = z.object({
  token: z.string().min(1),
});

/**
 * Edge-safe session check for middleware: validates cookie token against DB.
 * Requires shared secret header (not for browser use).
 */
async function POSTHandler(request: NextRequest) {
  const start = Date.now();
  const secret = (await getRuntimeConfig("MIDDLEWARE_VERIFY_SECRET")) ?? "";
  console.log(`API: Session verify reach [${request.method}]`);
  
  if (!secret || request.headers.get("x-middleware-verify") !== secret) {
    console.warn("API: Session verify REJECTED - Invalid secret or missing header");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const raw = await request.json();
    console.log(`API: Session verify ingress - Token length: ${raw?.token?.length ?? 0}`);
    
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("API: Session verify FAILED - Invalid body", parsed.error.flatten());
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const user = await getSessionFromDB(parsed.data.token);
    if (!user) {
      console.warn("API: Session verify FAILED - Session not found in DB");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log(`API: Session verify SUCCESS for user: ${user.email} in ${Date.now() - start}ms`);
    return NextResponse.json({ ok: true, user: { email: user.email } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("API: Session verify CRITICAL ERROR:", msg);
    return NextResponse.json({ error: "Bad Request", details: msg }, { status: 400 });
  }
}

async function GETHandler() {
  const environment = (await getRuntimeConfig("NODE_ENV")) ?? "development";
  return NextResponse.json({ 
    status: "active", 
    message: "Session verification endpoint is online",
    environment,
  });
}


export const GET = withApiRoute(GETHandler, { route: '/session/verify', operation: 'GET' });
export const POST = withApiRoute(POSTHandler, { route: '/session/verify', operation: 'POST' });
