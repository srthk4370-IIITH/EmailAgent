import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getRuntimeConfigSync } from "./runtimeConfig";

export function extractHostname(hostOrOrigin: string): string {
  const raw = hostOrOrigin.trim().toLowerCase();
  if (!raw) return "";

  // Next.js may provide "::1" without brackets for hostname.
  if (raw === "::1") return "::1";

  try {
    if (raw.includes("://")) {
      return new URL(raw).hostname.toLowerCase();
    }
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    // Fallback for malformed values; keep behavior predictable.
    const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracketed?.[1]) return bracketed[1].toLowerCase();
    return raw.split(":")[0] ?? "";
  }
}

export function isLoopbackHost(hostOrOrigin: string): boolean {
  const host = extractHostname(hostOrOrigin);
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}

function getConfiguredGmailRedirectUrl(): URL | null {
  const raw = getRuntimeConfigSync("GMAIL_REDIRECT_URI");
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Soft host canonicalization for local desktop/dev flows.
 *
 * If request host and configured Gmail callback host are both loopback but not
 * identical, redirect to the configured host to keep auth/session origin stable.
 */
export function redirectToConfiguredLocalAuthHostIfNeeded(request: NextRequest): NextResponse | null {
  const callbackUrl = getConfiguredGmailRedirectUrl();
  if (!callbackUrl) return null;

  const requestHost = request.nextUrl.host.toLowerCase();
  const configuredHost = callbackUrl.host.toLowerCase();

  if (requestHost === configuredHost) return null;
  if (!isLoopbackHost(request.nextUrl.hostname) || !isLoopbackHost(callbackUrl.hostname)) return null;

  const redirected = new URL(request.url);
  redirected.protocol = callbackUrl.protocol;
  redirected.host = callbackUrl.host;
  return NextResponse.redirect(redirected, 307);
}
