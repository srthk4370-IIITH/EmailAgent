import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { normalizeError } from "./lib/errorNormalizer";
import { checkApiRateLimit, clientIpFromRequest } from "./lib/rateLimit";

const PUBLIC_API_PREFIXES = [
  "/api/auth/login",
  "/api/auth/google",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/callback",
  "/api/connect",
];

function getMiddlewareVerifySecret(): string | null {
  const raw = process.env.MIDDLEWARE_VERIFY_SECRET;
  if (!raw) return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // TIER 3 HARDENING: Robust skip for the internal verify endpoint (handles trailing slashes)
  if (pathname === "/api/session/verify" || pathname === "/api/session/verify/") {
    return NextResponse.next();
  }

  if (!checkApiRateLimit(clientIpFromRequest(request))) {
    const appError = normalizeError("rate limit", {
      source: "middleware",
      route: pathname,
      operation: "checkApiRateLimit",
      fallbackStatus: 429,
    });
    return NextResponse.json({ error: appError }, { status: appError.status });
  }

  for (const p of PUBLIC_API_PREFIXES) {
    if (pathname === p || pathname.startsWith(`${p}/`)) {
      return NextResponse.next();
    }
  }

  const verifySecret = getMiddlewareVerifySecret();

  if (!verifySecret) {
    const appError = normalizeError("auth_not_configured", {
      source: "middleware",
      route: pathname,
      operation: "verify-secret",
      fallbackStatus: 503,
    });
    return NextResponse.json({ error: appError }, { status: appError.status });
  }

  const token = request.cookies.get("ea_session")?.value;
  if (!token) {
    const appError = normalizeError("unauthorized", {
      source: "middleware",
      route: pathname,
      operation: "session-cookie",
      fallbackStatus: 401,
    });
    return NextResponse.json({ error: appError }, { status: appError.status });
  }

  const verifyUrl = new URL("/api/session/verify", request.url);
  console.log(`MIDDLEWARE: Verifying session at ${verifyUrl.toString()}`);
  
  const h = new Headers();
  h.set("Content-Type", "application/json");
  h.set("x-middleware-verify", verifySecret);
  
  try {
    const sessionRes = await fetch(verifyUrl.toString(), {
      method: "POST",
      headers: h,
      body: JSON.stringify({ token }),
    });

    if (!sessionRes.ok) {
      console.warn(`MIDDLEWARE: Session verify FAILED with status ${sessionRes.status}`);
      const errBody = await sessionRes.text().catch(() => "no-body");
      console.warn(`MIDDLEWARE: Error body: ${errBody}`);
      const appError = normalizeError(errBody, {
        source: "middleware",
        route: pathname,
        operation: "session-verify",
        fallbackStatus: sessionRes.status || 401,
      });
      return NextResponse.json({ error: appError }, { status: appError.status });
    }
    
    console.log("MIDDLEWARE: Session verify SUCCESS");
  } catch (err) {
    console.error("MIDDLEWARE: Session verify FETCH ERROR", err);
    const appError = normalizeError(err, {
      source: "middleware",
      route: pathname,
      operation: "session-verify-fetch",
      fallbackStatus: 500,
    });
    return NextResponse.json({ error: appError }, { status: appError.status });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
