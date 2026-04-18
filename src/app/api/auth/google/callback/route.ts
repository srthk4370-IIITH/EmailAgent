import { randomBytes } from "crypto";

import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

import { createSession, upsertUserByGoogle } from "../../../../../db/auth";
import { upsertDefaultAccountForUser } from "../../../../../db/emailAccounts";
import { getOAuthClient } from "../../../../../services/oauth";
import {
  isValidDesktopHandoffId,
  markDesktopAuthHandoffError,
  markDesktopAuthHandoffReady,
} from "../../../../../lib/desktopAuthHandoff";
import { withApiRoute } from "../../../../../lib/routeErrorHandler";
import { shouldUseSecureSessionCookie } from "../../../../../lib/sessionCookie";
import { redirectToConfiguredLocalAuthHostIfNeeded } from "../../../../../lib/hostUtils";

function loginOAuthClient(_: NextRequest) {
  return getOAuthClient();
}

function parseDesktopHandoffFromState(state: string | null): string | null {
  const raw = (state ?? "").trim();
  if (!raw.startsWith("desktop_handoff:")) return null;
  const handoffId = raw.slice("desktop_handoff:".length);
  return isValidDesktopHandoffId(handoffId) ? handoffId : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function desktopHandoffPage(params: { ok: boolean; email?: string; error?: string }): NextResponse {
  const title = params.ok ? "Desktop sign-in complete" : "Desktop sign-in failed";
  const subtitle = params.ok
    ? `Account ${params.email ?? "(unknown)"} connected. Return to the desktop app.`
    : `Reason: ${params.error ?? "callback_failed"}. Return to the desktop app and retry.`;
  const safeTitle = escapeHtml(title);
  const safeSubtitle = escapeHtml(subtitle);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body {
        margin: 0;
        font-family: "Segoe UI", Arial, sans-serif;
        background: #f4f7fb;
        color: #10223a;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: min(560px, 100%);
        background: #ffffff;
        border: 1px solid #d6e1ee;
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 10px 32px rgba(16, 34, 58, 0.08);
      }
      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.3;
      }
      p {
        margin: 12px 0 0;
        color: #2f4966;
        line-height: 1.5;
      }
      .hint {
        margin-top: 18px;
        padding: 10px 12px;
        border-radius: 10px;
        background: #eef4fb;
        color: #2f4966;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${safeTitle}</h1>
      <p>${safeSubtitle}</p>
      <div class="hint">You can close this browser tab now.</div>
    </main>
    <script>
      setTimeout(function () {
        window.close();
      }, 1200);
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    status: params.ok ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function GETHandler(request: NextRequest) {
  const hostRedirect = redirectToConfiguredLocalAuthHostIfNeeded(request);
  if (hostRedirect) return hostRedirect;

  const desktopHandoffId = parseDesktopHandoffFromState(request.nextUrl.searchParams.get("state"));

  const err = request.nextUrl.searchParams.get("error");
  if (err) {
    if (desktopHandoffId) {
      markDesktopAuthHandoffError(desktopHandoffId, err);
      return desktopHandoffPage({ ok: false, error: err });
    }
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(err)}`, request.url));
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    if (desktopHandoffId) {
      markDesktopAuthHandoffError(desktopHandoffId, "missing_code");
      return desktopHandoffPage({ ok: false, error: "missing_code" });
    }
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
      if (desktopHandoffId) {
        markDesktopAuthHandoffError(desktopHandoffId, "no_profile");
        return desktopHandoffPage({ ok: false, error: "no_profile" });
      }
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

    if (desktopHandoffId) {
      markDesktopAuthHandoffReady(desktopHandoffId, token);
      return desktopHandoffPage({ ok: true, email });
    }

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
    if (desktopHandoffId) {
      markDesktopAuthHandoffError(desktopHandoffId, "callback_failed");
      return desktopHandoffPage({ ok: false, error: "callback_failed" });
    }
    return NextResponse.redirect(new URL("/login?error=callback_failed", request.url));
  }
}


export const GET = withApiRoute(GETHandler, { route: '/auth/google/callback', operation: 'GET' });
