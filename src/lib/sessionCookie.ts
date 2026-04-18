import type { NextRequest } from "next/server";

import { getRuntimeConfigSync } from "./runtimeConfig";
import { isLoopbackHost } from "./hostUtils";

function parseBoolean(raw: string | null): boolean | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return null;
}

export function shouldUseSecureSessionCookie(request: NextRequest): boolean {
  const forced = parseBoolean(getRuntimeConfigSync("SESSION_COOKIE_SECURE"));
  if (forced !== null) return forced;

  const nodeEnv = (getRuntimeConfigSync("NODE_ENV") ?? process.env.NODE_ENV ?? "development").toLowerCase();
  if (nodeEnv !== "production") return false;

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const httpsByProxy = forwardedProto === "https";
  const httpsByUrl = request.nextUrl.protocol === "https:";
  if (!(httpsByProxy || httpsByUrl)) return false;

  const hostHeader = request.headers.get("host") ?? request.nextUrl.host;
  if (isLoopbackHost(hostHeader)) return false;

  return true;
}
