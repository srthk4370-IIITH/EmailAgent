import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getAuthSecret } from "./lib/authConfig";
import { normalizeError } from "./lib/errorNormalizer";
import { checkApiRateLimit, clientIpFromRequest } from "./lib/rateLimit";

const PUBLIC_API_PREFIXES = [
  "/api/auth/login",
  "/api/auth/google",
  "/api/auth/desktop",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/callback",
  "/api/connect",
];

const RATE_LIMIT_EXEMPT_PREFIXES = [
  "/api/session/verify",
  "/api/system/health",
  "/api/system/check",
  "/api/system/connections",
  "/api/system/diagnostics/run",
  "/api/system/accounts",
  "/api/sync/status",
];

function normalizeSecret(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function shouldUseSecureCookieForMiddleware(request: NextRequest): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const httpsByProxy = forwardedProto === "https";
  const httpsByUrl = request.nextUrl.protocol === "https:";
  if (!(httpsByProxy || httpsByUrl)) return false;

  const host = request.nextUrl.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  return !isLoopback;
}

async function resolveMiddlewareVerifySecret(): Promise<string | null> {
  const envSecret = normalizeSecret(process.env.AUTH_SECRET ?? process.env.MIDDLEWARE_VERIFY_SECRET ?? null);
  if (envSecret) return envSecret;

  try {
    return await getAuthSecret();
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (matchesPrefix(pathname, RATE_LIMIT_EXEMPT_PREFIXES)) {
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

  if (matchesPrefix(pathname, PUBLIC_API_PREFIXES)) {
    return NextResponse.next();
  }

  const verifySecret = await resolveMiddlewareVerifySecret();

  if (!verifySecret) {
    const appError = normalizeError(
      {
        code: "AUTH_SECRET_MISSING",
        category: "AUTH",
        severity: "critical",
        retryable: true,
        autoRecoverable: false,
        message: "Session verification is not configured",
        reason: "No AUTH_SECRET is available for middleware session verification.",
        fix: "Open Settings to refresh runtime configuration, then sign in again.",
        fixNowPath: "/settings",
        status: 503,
      },
      {
        source: "middleware",
        route: pathname,
        operation: "verify-secret",
        fallbackStatus: 503,
      },
    );
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
      const response = NextResponse.json({ error: appError }, { status: appError.status });

      // If the DB no longer has this session, clear the stale cookie to break 401 loops.
      if (sessionRes.status === 401) {
        response.cookies.set("ea_session", "", {
          httpOnly: true,
          path: "/",
          maxAge: 0,
          sameSite: "lax",
          secure: shouldUseSecureCookieForMiddleware(request),
        });
      }

      return response;
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
  runtime: "nodejs",
};
