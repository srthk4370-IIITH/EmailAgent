import { randomBytes } from "crypto";

import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

import { createSession, upsertUserByGoogle } from "../../../../../db/auth";
import { upsertDefaultAccountForUser } from "../../../../../db/emailAccounts";
import { getOAuthClient } from "../../../../../services/oauth";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";
import { shouldUseSecureSessionCookie } from "../../../../../lib/sessionCookie";
import { redirectToConfiguredLocalAuthHostIfNeeded } from "../../../../../lib/hostUtils";

function loginOAuthClient(_: NextRequest) {
  return getOAuthClient();
}

async function GETHandler(request: NextRequest) {
  const hostRedirect = redirectToConfiguredLocalAuthHostIfNeeded(request);
  if (hostRedirect) return hostRedirect;

  const err = request.nextUrl.searchParams.get("error");
  if (err) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(err)}`, request.url));
  }
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", request.url));
  }

  try {
    const oauth2 = loginOAuthClient(request);
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
    const { data } = await oauth2Api.userinfo.get();
    const email = data.email;
    const sub = data.id;
    if (!email || !sub) {
      return NextResponse.redirect(new URL("/login?error=no_profile", request.url));
    }

    const user = await upsertUserByGoogle({
      googleSub: String(sub),
      email,
      gmailEmail: email,
      refreshToken: tokens.refresh_token ?? undefined,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    });
    await upsertDefaultAccountForUser({
      userId: user.id,
      emailAddress: email,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    });
    const token = randomBytes(32).toString("hex");
    await createSession(user.id, token);

    const res = NextResponse.redirect(new URL("/", request.url));
    res.cookies.set("ea_session", token, {
      httpOnly: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
      sameSite: "lax",
      secure: shouldUseSecureSessionCookie(request),
    });
    return res;
  } catch {
    return NextResponse.redirect(new URL("/login?error=callback_failed", request.url));
  }
}


export const GET = withApiRoute(GETHandler, { route: '/auth/google/callback', operation: 'GET' });
